// AreTheyIn API — Railway-ready
// Scrapes Boldmethod's public "Are They In" board and exposes JSON.
// Logs parsed rows to the console on each refresh.

import express from "express";
import axios from "axios";
import cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

// Source URL (public view)
const SOURCE_URL =
  "https://aretheyin.boldmethod.com/index.aspx?op=public&sid=d2f78e63-1fb3-40ae-957f-920d2a455d85";

// Polling cadence (ms)
const POLL_MS = Number(process.env.POLL_MS || 60_000);

// In-memory cache
let cache = {
  lastFetched: null,
  items: [],
  error: null
};

// Utilities
const decode = (s) =>
  (s ?? "")
    .replace(/\u00A0/g, " ") // &nbsp;
    .replace(/\s+/g, " ")
    .trim();

const parseDate = (s) => {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

function rowToRecord($, tr) {
  // Rows look like:
  // <tr class="InItem" id="Row...">
  //   <td class="OtlkItem" style="display:none;">GUID</td>
  //   <td class="OtlkItem">In</td>
  //   <td class="OtlkItem">Name</td>
  //   <td class="OtlkItem">Contact</td>
  //   <td class="OtlkItem">Remarks</td>
  //   <td class="OtlkItem">Returning</td>
  //   <td class="OtlkItem">10/16/2025 8:34 AM</td>
  // </tr>

  const tds = $(tr).find("td.OtlkItem");
  if (tds.length < 7) return null;

  const id = decode($(tds[0]).text());
  const status = decode($(tds[1]).text());
  const name = decode($(tds[2]).text());
  const contact = decode($(tds[3]).html() || $(tds[3]).text()); // keep phone text if it had &nbsp;
  const remarks = decode($(tds[4]).text());
  const returning = decode($(tds[5]).text());
  const updatedRaw = decode($(tds[6]).text());

  return {
    id,
    status,               // "In" | "Out" | "Unavailable" | etc.
    name,                 // "Aaron TerBest - FDM Analyst"
    contact: contact || null,
    remarks: remarks || null,
    returning: returning || null,
    updatedLocal: updatedRaw || null,
    updatedUtc: updatedRaw ? parseDate(updatedRaw) : null,
    // Helpful derivations
    isIn: /^in$/i.test(status),
    isOut: /^out$/i.test(status),
    isUnavailable: /^unavailable$/i.test(status)
  };
}

async function fetchBoard() {
  try {
    const { data: html } = await axios.get(SOURCE_URL, {
      // Some sites prefer a UA
      headers: { "User-Agent": "AreTheyInAPI/1.0 (+railway)" },
      timeout: 20_000
    });

    const $ = cheerio.load(html);

    // The page uses many <tr> rows; target ones with a Row* id OR that contain td.OtlkItem columns
    const rows = $("tr[id^='Row'], tr:has(td.OtlkItem)");
    const items = [];

    rows.each((_, tr) => {
      const rec = rowToRecord($, tr);
      if (rec && rec.id) items.push(rec);
    });

    // Keep only unique IDs (defensive)
    const deduped = Object.values(
      items.reduce((acc, r) => {
        acc[r.id] = r;
        return acc;
      }, {})
    );

    // Sort by status then name for predictable output
    deduped.sort((a, b) => {
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

    // Pretty console output
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

// Kick off polling
await fetchBoard();
setInterval(fetchBoard, POLL_MS);

// Routes
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

// Start server
app.listen(PORT, () => {
  console.log(`[AreTheyIn] API listening on :${PORT}`);
});
