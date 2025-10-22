// AreTheyIn API — Railway-ready (ESM)
// Fixed version with better type safety and iOS compatibility
import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;
const SOURCE_URL =
  "https://aretheyin.boldmethod.com/index.aspx?op=public&sid=d2f78e63-1fb3-40ae-957f-920d2a455d85";
const POLL_MS = Number(process.env.POLL_MS || 60_000);
const LOG_SAMPLE = process.env.LOG_SAMPLE === "1";

// -------------------------------
// Helpers
// -------------------------------
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

function extractCellText($, td) {
  const text = decode($(td).text());
  if (/^MM\/dd(\s+)HH:mm$/i.test(text) || text === "" || text === "—") {
    const html = $(td).html() || "";
    const stripped = decode(html.replace(/<[^>]*>/g, ""));
    return stripped || text;
  }
  return text;
}

function splitNameAndTitle(raw) {
  const t = decode(raw);
  if (!t) return { name: null, title: null };
  const parts = t.split(/\s*[-–—]\s+/);
  if (parts.length >= 2) {
    return { 
      name: parts.shift()?.trim() || null, 
      title: parts.join(" - ").trim() || null 
    };
  }
  return { name: t, title: null };
}

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
  return { 
    raw: text, 
    digits, 
    e164: digits.length >= 11 ? `+${digits}` : null, 
    pretty: text 
  };
}

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
    return { 
      raw: text, 
      hhmm: `${h}:${mm}`, 
      pretty: `${Number(h)}:${mm} ${ampm}`, 
      tokens: [ampm] 
    };
  }
  
  const tokens = (text.match(/[A-Za-z]+/g) || []).map((t) => t);
  return { raw: text, hhmm: null, pretty: text, tokens };
}

function parseUpdatedFromCell($, td) {
  const text = extractCellText($, td);
  
  if (/^MM\/dd(\s+)HH:mm$/i.test(text)) {
    return { local: null, isoGuess: null, epochMs: null, debug: "FormatTokenSeen" };
  }
  
  let isoGuess = null;
  let epochMs = null;
  
  if (text) {
    const d = new Date(text);
    if (!Number.isNaN(d.getTime())) {
      isoGuess = d.toISOString();
      // CRITICAL FIX: Ensure epochMs is always a number or null (never NaN)
      epochMs = d.getTime();
      if (Number.isNaN(epochMs) || !Number.isFinite(epochMs)) {
        epochMs = null;
      }
    }
  }
  
  return { local: text || null, isoGuess, epochMs, debug: null };
}

function normalizeStatus({ trClass, cellText }) {
  const c = (trClass || "").toLowerCase();
  const t = (cellText || "").toLowerCase();
  
  // CRITICAL FIX: Ensure status values match Swift enum EXACTLY
  if (/initem/.test(c) || /^in$/.test(t)) return "In";
  if (/outitem/.test(c) || /^out$/.test(t)) return "Out";
  if (/unavailable/.test(c) || /^unavailable$/.test(t)) return "Unavailable";
  
  // Return Unknown as fallback (matches Swift enum)
  return "Unknown";
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
  
  // CRITICAL FIX: Skip records without valid IDs
  if (!id) return null;

  const statusCellText = extractCellText($, tds[1]);
  const status = normalizeStatus({ trClass, cellText: statusCellText });

  const nameTitleRaw = extractCellText($, tds[2]);
  const { name, title } = splitNameAndTitle(nameTitleRaw);

  const contactRaw = extractCellText($, tds[3]);
  const phone = parsePhone(contactRaw);

  const remarks = extractCellText($, tds[4]) || null;
  const returning = parseReturning(extractCellText($, tds[5]));
  const updated = parseUpdatedFromCell($, tds[6]);

  // CRITICAL FIX: Ensure all nested objects have proper null handling
  return {
    id,
    status,
    name: name || null,
    title: title || null,
    contact: {
      raw: phone.raw,
      digits: phone.digits,
      e164: phone.e164,
      pretty: phone.pretty
    },
    remarks,
    returning: {
      raw: returning.raw,
      hhmm: returning.hhmm,
      pretty: returning.pretty,
      tokens: returning.tokens || []
    },
    updated: {
      local: updated.local,
      isoGuess: updated.isoGuess,
      epochMs: updated.epochMs, // Now guaranteed to be number or null
      debug: updated.debug
    },
    meta: {
      trClass: trClass || null,
      rowIdAttr: $tr.attr("id") || null,
      parsedAt: new Date().toISOString(),
      flags: {
        isIn: status === "In",
        isOut: status === "Out",
        isUnavailable: status === "Unavailable"
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
      // CRITICAL FIX: Only add records with valid IDs
      if (rec && rec.id) {
        items.push(rec);
      }
      
      if (LOG_SAMPLE && i < 3) {
        const rawHtml = $(tr).find("td.OtlkItem").eq(6).html() || "";
        console.log("[DEBUG UpdatedCell rawHTML]", rawHtml);
        console.log("[DEBUG UpdatedCell text   ]", $(tr).find("td.OtlkItem").eq(6).text());
      }
    });

    // Dedup by id, keep last
    const deduped = Object.values(
      items.reduce((acc, r) => ((acc[r.id] = r), acc), {})
    );

    // Sort by status then name
    const order = { In: 0, Out: 1, Unavailable: 2, Unknown: 3 };
    deduped.sort((a, b) => {
      const aK = order[a.status] ?? 99;
      const bK = order[b.status] ?? 99;
      if (aK !== bK) return aK - bK;
      return (a.name || "").localeCompare(b.name || "");
    });

    cache = { 
      lastFetched: new Date().toISOString(), 
      items: deduped, 
      error: null 
    };

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

  // CORS headers for iOS
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });

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
    // CRITICAL FIX: Ensure response structure matches Swift expectations
    res.json({
      lastFetched: cache.lastFetched,
      items: cache.items,
      error: cache.error
    });
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  // Debug endpoint to see raw JSON
  app.get("/api/debug", (_req, res) => {
    res.set("Content-Type", "text/plain");
    res.send(JSON.stringify({
      lastFetched: cache.lastFetched,
      items: cache.items,
      error: cache.error
    }, null, 2));
  });

  app.listen(PORT, () => console.log(`[AreTheyIn] API listening on :${PORT}`));
})();
