// golf-carts-local.mjs
// Builds a LOCAL product inventory feed for the golf carts. This is what
// qualifies them for free LOCAL listings — the "See what's in store" unit
// that shows on your Google Business Profile in Search and Maps.
//
// It is SUPPLEMENTAL to the primary product feed (google-carts-feed.xml):
// same item ids, plus per-store availability. Output is a tab-separated
// (TSV) file, which is the standard local inventory format.
//
// Usage:
//   FEED_URL="https://.../feed.xml" node golf-carts-local.mjs   (fetch live)
//   node golf-carts-local.mjs path/to/sample.xml                (local file, testing)
//
// Output: writes google-carts-local.txt (or OUTPUT_PATH).
//
// No external dependencies. Requires Node 20+ (built-in fetch).

import { readFileSync, writeFileSync } from "node:fs";

const FEED_URL = process.env.FEED_URL || "";
const OUTPUT_PATH = process.env.OUTPUT_PATH || "google-carts-local.txt";
// Must match the store code in your linked Google Business Profile.
const STORE_CODE = process.env.STORE_CODE || "GD2151";

function tag(chunk, name) {
  const m = chunk.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : "";
}

function decodeEntities(s) {
  let prev;
  let out = String(s);
  let guard = 0;
  do {
    prev = out;
    out = out
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#160;/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
  } while (out !== prev && ++guard < 5);
  return out;
}

function formatPrice(raw) {
  const n = Number(String(raw).trim());
  if (!raw || Number.isNaN(n) || n <= 0) return "";
  return `${n.toFixed(2)} USD`;
}

function getInput() {
  const fileArg = process.argv[2];
  if (fileArg) return Promise.resolve(readFileSync(fileArg, "utf8"));
  if (!FEED_URL) throw new Error("Set FEED_URL env var or pass a file path.");
  return fetch(FEED_URL).then((r) => {
    if (!r.ok) throw new Error(`Fetch failed: ${r.status} ${r.statusText}`);
    return r.text();
  });
}

function build(xml) {
  const rows = [["store_code", "id", "availability", "price", "quantity"]];
  let count = 0;

  const unitRe = /<unit>([\s\S]*?)<\/unit>/g;
  let um;
  while ((um = unitRe.exec(xml)) !== null) {
    const unit = um[1];
    if (tag(unit, "status").trim() !== "Active") continue;

    // Golf carts only — must line up with the primary product feed.
    const productType = decodeEntities(tag(unit, "productType"));
    if (!/golf\s*cart/i.test(productType)) continue;

    const id = tag(unit, "stockNumber").trim();
    const price = formatPrice(tag(tag(unit, "prices"), "sales"));
    if (!id || !price) continue;

    rows.push([STORE_CODE, id, "in_stock", price, "1"]);
    count++;
  }

  // TSV: header + one row per cart. Each unit is a single physical item.
  const tsv = rows.map((r) => r.join("\t")).join("\n") + "\n";
  return { tsv, count };
}

const xml = await getInput();
const { tsv, count } = build(xml);
writeFileSync(OUTPUT_PATH, tsv, "utf8");
console.log(`Wrote local inventory for ${count} golf carts to ${OUTPUT_PATH}`);
