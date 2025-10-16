// AreTheyIn API — Railway-ready (ESM)
// Fix: Cheerio ESM import uses `* as` and `cheerio.load(...)`

import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

const SOURCE_URL =
  "https://aretheyin.boldmethod.com/index.aspx?op=public&sid=d2f78e63-1fb3-40ae-957f-920d2a455d85";

const POLL_MS = Number(process.env.POLL_MS || 60_000);

let cache = {
  lastFetched: null,
  items: [],
  error: null
};

const decode = (s) =>
  (s ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const parseDate = (s) => {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

function rowToRecord($, tr) {
  const tds = $(tr).find("td.OtlkItem");
  if (tds.length < 7) return null;

  const id = decode($(tds[0]).text());
  const status = decode($(tds[1]).text());
  const name = decode($(tds[2]).text());
  const contact = decode($(tds[3]).text());
  const remarks = decode($(tds[4]).text());
  const returning = decode($(tds[5]).text());
  const updatedRaw = decode($(tds[6]).text());

  return {
    id,
    status,
    name,
    contact: contact || null,
    remarks: remarks || null,
    returning: returning || null,
    updatedLocal: updatedRaw || null,
    updatedUtc: updatedRaw ? parseDate(updatedRaw) : null,
    isIn: /^in$/i.test(status),
    isOut: /^out$/i.test(status),
    isUnavailable: /^unavailable$/i.test(status)
  };
}

async function fetchBoard() {
  try {
    const { data: html } = await axios.get(SOURCE_URL, {
      headers: { "User-Agent": "AreTheyInAPI/1.0 (+railway)" },
      timeout: 20_000
    });

    const $ = cheerio.load(html);

    const rows = $("tr[id^='Row'], tr:has(td.OtlkItem)");
    const items = [];

    rows.each((_, tr) => {
      const rec = rowToRecord($, tr);
      if (rec && rec.id) items.push(rec);
    });

    const deduped = Object.values(
      items.reduce((acc, r) => ((acc[r.id] = r), acc), {})
    ).sort((a, b) => {
      const sA = a.status.toLowerCase();
      const sB = b.status.toLowerCase();
      if (sA !== sB) return sA < sB ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    cache = {
      lastFetched: new Date().toISOString(),
      items: deduped,
      error: null
    };

    console.clear();
    console.log(`[AreTheyIn] ${cache.lastFetched}`);
    console.table(
      deduped.map((r) => ({
        Status: r.status,
        Name: r.name,
        Contact: r.contact || "",
        Remarks: r.remarks || "",
        Returning: r.returning || "",
        UpdatedLocal: r.updatedLocal || ""
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
