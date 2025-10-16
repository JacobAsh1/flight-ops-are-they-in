// AreTheyIn API — Railway-ready (ESM)
// Ultra-robust parsing for all columns + clean JSON + readable console output.

import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

const SOURCE_URL =
  "https://aretheyin.boldmethod.com/index.aspx?op=public&sid=d2f78e63-1fb3-40ae-957f-920d2a455d85";

const POLL_MS = Number(process.env.POLL_MS || 60_000);

// -------------------------------
// Helpers
// -------------------------------

// Normalize whitespace, decode nbsp, and strip common HTML artifacts.
const decode = (s) =>
  (s ?? "")
    .replace(/\u00A0/g, " ") // &nbsp;
    .replace(/[ \t]+/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();

// Best-effort phone sanitizer → { raw, digits, e164?, pretty? }
// Assumes NANP if 10 digits; if 7 digits, we leave pretty as 'XXX-XXXX'.
function parsePhone(raw) {
  const text = decode(raw);
  if (!text) return { raw: null, digits: null, e164: null, pretty: null };

  const digits = text.replace(/\D+/g, "");
  if (!digits) return { raw: text, digits: null, e164: null, pretty: text };

  // NANP 10-digit (e.g., 701-777-7868)
  if (digits.length === 10) {
    const e164 = `+1${digits}`;
    const pretty = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    return { raw: text, digits, e164, pretty };
  }

  // 7-digit local
  if (digits.length === 7) {
    const pretty = `${digits.slice(0, 3)}-${digits.slice(3)}`;
    return { raw: text, digits, e164: null, pretty };
  }

  // Already E.164 or extension noise—return as-is
  return { raw: text, digits, e164: digits.length >= 11 ? `+${digits}` : null, pretty: text };
}

// Split “Name – Title” if present, tolerate hyphen variations.
function splitNameAndTitle(raw) {
  const text = decode(raw);
  if (!text) return { name: null, title: null };

  // En dash, em dash, hyphen variants
  const parts = text.split(/\s*[-–—]\s+/);
  if (parts.length >= 2) {
    const name = parts.shift()?.trim() || null;
    const title = parts.join(" - ").trim() || null;
    return { name, title };
  }
  return { name: text || null, title: null };
}

// Parse "Returning" column.
// - "1145" → 11:45
// - "Thurs AM" / "Thu PM mod" / "Meeting" → keep raw + tokens
function parseReturning(raw) {
  const text = decode(raw);
  if (!text) return { raw: null, hhmm: null, pretty: null, tokens: [] };

  const tokens = text.split(/\s+/);

  // Simple HHMM (3–4 digits) like 945 or 1145
  if (/^\d{3,4}$/.test(text)) {
    const padded = text.padStart(4, "0");
    const hh = padded.slice(0, 2);
    const mm = padded.slice(2, 4);
    const pretty = `${Number(hh)}:${mm}`;
    return { raw: text, hhmm: `${hh}:${mm}`, pretty, tokens };
  }

  // Contains AM/PM times (very light parse)
  const m = text.match(/\b(\d{1,2}):?(\d{2})?\s*(AM|PM)\b/i);
  if (m) {
    const h = m[1].padStart(2, "0");
    const mm = (m[2] || "00").padStart(2, "0");
    const ampm = m[3].toUpperCase();
    return { raw: text, hhmm: `${h}:${mm}`, pretty: `${Number(h)}:${mm} ${ampm}`, tokens };
  }

  // Fallback: keep raw and helpful tokens (Thu, PM, Meeting, etc.)
  return { raw: text, hhmm: null, pretty: text, tokens };
}

// Parse Updated column.
// We KEEP the original (`localRaw`) for display & logs.
// We also try to produce a best-effort ISO using Date() (timezone-naive).
function parseUpdated(raw) {
  const localRaw = decode(raw);
  if (!localRaw) return { localRaw: null, isoUtcGuess: null, epochMs: null };

  // Date() will interpret "MM/DD/YYYY HH:mm AM" in server TZ. We just offer it as a guess.
  const d = new Date(localRaw);
  if (Number.isNaN(d.getTime())) {
    return { localRaw, isoUtcGuess: null, epochMs: null };
  }
  return { localRaw, isoUtcGuess: d.toISOString(), epochMs: d.getTime() };
}

// Normalize status using both row class and cell text.
function normalizeStatus({ trClass, cellText }) {
  const c = (trClass || "").toLowerCase();
  const t = (cellText || "").toLowerCase();

  const pick = (s) => ({
    value: s,
    isIn: s === "in",
    isOut: s === "out",
    isUnavailable: s === "unavailable"
  });

  if (/initem/.test(c) || /^in$/.test(t)) return pick("In");
  if (/outitem/.test(c) || /^out$/.test(t)) return pick("Out");
  if (/unavailable/.test(c) || /^unavailable$/.test(t)) return pick("Unavailable");

  // Fallback to raw text with capitalization
  const pretty = t ? t[0].toUpperCase() + t.slice(1) : "Unknown";
  return pick(pretty);
}

// Extract safe text from a specific <td>.
const cell = ($, tds, idx) => decode($(tds[idx]).text());

// -------------------------------
// Row → Record
// -------------------------------
function rowToRecord($, tr) {
  const $tr = $(tr);
  const tds = $tr.find("td.OtlkItem");
  if (tds.length < 7) return null; // unexpected row

  const trClass = ($tr.attr("class") || "").trim();
  const id = cell($, tds, 0) || $tr.attr("id")?.replace(/^Row/, "") || null;

  const statusFromCell = cell($, tds, 1);
  const status = normalizeStatus({ trClass, cellText: statusFromCell });

  const nameTitleRaw = cell($, tds, 2);
  const { name, title } = splitNameAndTitle(nameTitleRaw);

  const contactRaw = cell($, tds, 3);
  const phone = parsePhone(contactRaw);

  const remarksRaw = cell($, tds, 4) || null;
  const returningRaw = cell($, tds, 5);
  const returning = parseReturning(returningRaw);

  const updated = parseUpdated(cell($, tds, 6));

  return {
    id,
    status: status.value,                // "In" | "Out" | "Unavailable" | "Unknown"
    name,                                // "Brendan Aug"
    title,                               // "FDM Analyst" etc.
    contact: {
      raw: phone.raw,
      digits: phone.digits,
      e164: phone.e164,
      pretty: phone.pretty
    },
    remarks: remarksRaw || null,         // free text or null
    returning,                           // { raw, hhmm, pretty, tokens }
    updated: {                           // preserve human string for UI
      local: updated.localRaw,
      isoGuess: updated.isoUtcGuess,
      epochMs: updated.epochMs
    },
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
// Fetch + Parse
// -------------------------------
let cache = {
  lastFetched: null,
  items: [],
  error: null
};

async function fetchBoard() {
  try {
    const { data: html } = await axios.get(SOURCE_URL, {
      headers: { "User-Agent": "AreTheyInAPI/1.0 (+railway)" },
      timeout: 20_000
    });

    const $ = cheerio.load(html);

    // Only rows that look like data rows
    const rows = $("tr[id^='Row'], tr[class*='Item']:has(td.OtlkItem)");
    const items = [];

    rows.each((_, tr) => {
      const rec = rowToRecord($, tr);
      if (rec && rec.id) items.push(rec);
    });

    // Deduplicate by id (keep last)
    const deduped = Object.values(
      items.reduce((acc, r) => ((acc[r.id] = r), acc), {})
    );

    // Stable sort: status category, then name
    const order = { in: 0, out: 1, unavailable: 2, unknown: 3 };
    deduped.sort((a, b) => {
      const aKey = order[a.status.toLowerCase()] ?? 99;
      const bKey = order[b.status.toLowerCase()] ?? 99;
      if (aKey !== bKey) return aKey - bKey;
      return (a.name || "").localeCompare(b.name || "");
    });

    cache = {
      lastFetched: new Date().toISOString(),
      items: deduped,
      error: null
    };

    // -------------------------------
    // Pretty console output
    // -------------------------------
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
        Updated: r.updated.local || ""
      }))
    );
  } catch (err) {
    cache.error = {
      message: err?.message || "Unknown error",
      time: new Date().toISOString()
    };
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
    res.json({
      lastFetched: cache.lastFetched,
      items: cache.items,
      error: cache.error
    });
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.listen(PORT, () => {
    console.log(`[AreTheyIn] API listening on :${PORT}`);
  });
})();
