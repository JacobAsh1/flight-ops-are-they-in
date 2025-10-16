// AreTheyIn API — Railway-ready (ESM)
// Robust parsers for all columns + exact "Updated" string logging.
// If you still ever see "MM/dd HH:mm", we bypass any template string
// by grabbing the cell's raw HTML and stripping entities manually.

import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

const SOURCE_URL =
  "https://aretheyin.boldmethod.com/index.aspx?op=public&sid=d2f78e63-1fb3-40ae-957f-920d2a455d85";

const POLL_MS = Number(process.env.POLL_MS || 60_000);
const LOG_SAMPLE = process.env.LOG_SAMPLE === "1"; // set to 1 to log first few raw cells

// -------------------------------
// Helpers
// -------------------------------

// Safe whitespace/entity cleanup (handles \u00A0 from &nbsp;)
const decode = (s) =>
  (s ?? "")
    .replace(/\u00A0|&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();

// Pull visible text AND, if needed, raw HTML (to defeat template placeholders)
function extractCellText($, td) {
  const text = decode($(td).text());
  // If the text suspiciously looks like a format token, try from HTML
  if (/^MM\/dd(\s+)HH:mm$/i.test(text) || text === "" || text === "—") {
    const html = $(td).html() || "";
    // strip tags, collapse entities/nbsp
    const stripped = decode(html.replace(/<[^>]*>/g, ""));
    return stripped || text; // prefer stripped; fall back to original text
  }
  return text;
}

// Name — Title split (supports hyphen/en dash/em dash)
function splitNameAndTitle(raw) {
  const t = decode(raw);
  if (!t) return { name: null, title: null };
  const parts = t.split(/\s*[-–—]\s+/);
  if (parts.length >= 2) {
    return { name: parts.shift()?.trim() || null, title: parts.join(" - ").trim() || null };
  }
  return { name: t, title: null };
}

// Phone sanitizer
function parsePhone(raw) {
  const text = decode(raw);
  if (!text) return { raw: null, digits: null, e164: null, pretty: null };
  const digits = text.replace(/\D+/g, "");
  if (!digits) return { raw: text, digits: null, e164: null, pretty: text };

  if (digits.length === 10) {
    const e164 = `+1${digits}`;
    const pretty = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    return { raw: text, digits, e164, pretty };
  }
  if (digits.length === 7) {
    const pretty = `${digits.slice(0, 3)}-${digits.slice(3)}`;
    return { raw: text, digits, e164: null, pretty };
  }
  return { raw: text, digits, e164: digits.length >= 11 ? `+${digits}` : null, pretty: text };
}

// Returning column (times like "1145", "9:30 AM", or free text like "Thu PM mod")
function parseReturning(raw) {
  const text = decode(raw);
  if (!text) return { raw: null, hhmm: null, pretty: null, tokens: [] };

  // Pure HHMM / HMM
  if (/^\d{3,4}$/.test(text)) {
    const padded = text.padStart(4, "0");
    const hh = padded.slice(0, 2);
    const mm = padded.slice(2, 4);
    const pretty = `${Number(hh)}:${mm}`;
    return { raw: text, hhmm: `${hh}:${mm}`, pretty, tokens: [pretty] };
  }

  // e.g., "9:30 AM"
  const m = text.match(/\b(\d{1,2}):?(\d{2})?\s*(AM|PM)\b/i);
  if (m) {
    const h = m[1].padStart(2, "0");
    const mm = (m[2] || "00").padStart(2, "0");
    const ampm = m[3].toUpperCase();
    return { raw: text, hhmm: `${h}:${mm}`, pretty: `${Number(h)}:${mm} ${ampm}`, tokens: [ampm] };
  }

  // Tokens for keywords (Thu/Thurs, AM/PM, Meeting, Campus, etc.)
  const tokens = (text.match(/[A-Za-z]+/g) || []).map((t) => t);
  return { raw: text, hhmm: null, pretty: text, tokens };
}

// Updated column — keep exact string, but also offer an ISO guess
function parseUpdatedFromCell($, td) {
  const text = extractCellText($, td);

  // If something still returns a format token, we treat it as missing
  if (/^MM\/dd(\s+)HH:mm$/i.test(text)) {
    return { local: null, isoGuess: null, epochMs: null, debug: "FormatTokenSeen" };
  }

  // Try a best-effort Date parse for ISO (timezone-naive)
  let isoGuess = null;
  let epochMs = null;
  if (text) {
    const d = new Date(text);
    if (!Number.isNaN(d.getTime())) {
      isoGuess = d.toISOString();
      epochMs = d.getTime();
    }
  }
  return { local: text || null, isoGuess, epochMs, debug: null };
}

// Status normalization using both row class and cell text
function normalizeStatus({ trClass, cellText }) {
  const c = (trClass || "").toLowerCase();
  const t = (cellText || "").toLowerCase();

  const pick = (s) => ({
    value: s,
    isIn: s === "In",
    isOut: s === "Out",
    isUnavailable: s === "Unavailable"
  });

  if (/initem/.test(c) || /^in$/.test(t)) return pick("In");
  if (/outitem/.test(c) || /^out$/.test(t)) return pick("Out");
  if (/unavailable/.test(c) || /^unavailable$/.test(t)) return pick("Unavailable");

  const pretty = t ? t[0].toUpperCase() + t.slice(1) : "Unknown";
  return pick(pretty);
}

// -------------------------------
// Row → Record
// -------------------------------
function rowToRecord($, tr) {
  const $tr = $(tr);
  const tds = $tr.find("td.OtlkItem");
  if (tds.length < 7) return null;

  const trClass = ($tr.attr("class") || "").trim();
  const idFromHidden = extractCellText($, tds[0]);
  const idFromAttr = ($tr.attr("id") || "").replace(/^Row/, "");
  const id = idFromHidden || idFromAttr || null;

  const statusCellText = extractCellText($, tds[1]);
  const status = normalizeStatus({ trClass, cellText: statusCellText });

  const nameTitleRaw = extractCellText($, tds[2]);
  const { name, title } = splitNameAndTitle(nameTitleRaw);

  const contactRaw = extractCellText($, tds[3]);
  const phone = parsePhone(contactRaw);

  const remarks = extractCellText($, tds[4]) || null;

  const returning = parseReturning(extractCellText($, tds[5]));

  const updated = parseUpdatedFromCell($, tds[6]);

  return {
    id,
    status: status.value, // "In" | "Out" | "Unavailable" | "Unknown"
    name,
    title,
    contact: {
      raw: phone.raw,
      digits: phone.digits,
      e164: phone.e164,
      pretty: phone.pretty
    },
    remarks,
    returning, // { raw, hhmm, pretty, tokens }
    updated,   // { local, isoGuess, epochMs, debug }
    meta: {
      trClass,
      rowIdAttr: $tr.attr("id") || null,
      parsedAt: new Date().toISOString(),
      flags: {
        isIn: status.isIn,
        isOut: status.isOut,
        isUnavailable: status.isUnavailable
      }
    }
  };
}

// -------------------------------
let cache = { lastFetched: null, items: [], error: null };

async function fetchBoard() {
  try {
    const { data: html } = await axios.get(SOURCE_URL, {
      headers: { "User-Agent": "AreTheyInAPI/1.0 (+railway)" },
      timeout: 20_000
    });

    const $ = cheerio.load(html);

    const rows = $("tr[id^='Row'], tr[class*='Item']:has(td.OtlkItem)");
    const items = [];
    rows.each((i, tr) => {
      const rec = rowToRecord($, tr);
      if (rec && rec.id) items.push(rec);
      if (LOG_SAMPLE && i < 3) {
        const rawHtml = $(tr).find("td.OtlkItem").eq(6).html() || "";
        console.log("[DEBUG UpdatedCell rawHTML]", rawHtml);
        console.log("[DEBUG UpdatedCell text   ]", $(tr).find("td.OtlkItem").eq(6).text());
      }
    });

    // Dedup by id, keep last
    const deduped = Object.values(items.reduce((acc, r) => ((acc[r.id] = r), acc), {}));

    // Sort by status then name
    const order = { in: 0, out: 1, unavailable: 2, unknown: 3 };
    deduped.sort((a, b) => {
      const aK = order[a.status.toLowerCase()] ?? 99;
      const bK = order[b.status.toLowerCase()] ?? 99;
      if (aK !== bK) return aK - bK;
      return (a.name || "").localeCompare(b.name || "");
    });

    cache = { lastFetched: new Date().toISOString(), items: deduped, error: null };

    // Console output — IMPORTANT: log the exact site string for Updated.
    console.clear();
    console.log(`[AreTheyIn] ${cache.lastFetched}  —  ${deduped.length} rows`);
    console.table(
      deduped.map((r) => ({
        Status: r.status,
        Name: r.name || "",
        Title: r.title || "",
        Contact: r.contact.pretty || r.contact.raw || "",
        Remarks: r.remarks || "",
        Returning: r.returning.pretty || "",
        Updated: String(r.updated.local || "")
      }))
    );
  } catch (err) {
    cache.error = { message: err?.message || "Unknown error", time: new Date().toISOString() };
    console.error("[AreTheyIn] Fetch error:", cache.error.message);
  }
}

// -------------------------------
// Startup + Routes
// -------------------------------
(async () => {
  await fetchBoard();
  setInterval(fetchBoard, POLL_MS);

  app.get("/", (_req, res) => {
    res.json({
      service: "are-they-in-api",
      source: SOURCE_URL,
      lastFetched: cache.lastFetched,
      count: cache.items.length,
      error: cache.error
    });
  });

  app.get("/api/status", (_req, res) => {
    res.json({ lastFetched: cache.lastFetched, items: cache.items, error: cache.error });
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.listen(PORT, () => console.log(`[AreTheyIn] API listening on :${PORT}`));
})();
