// golf-carts.mjs
// Fetches the RV One (InteractRV) inventory XML and rewrites it into a
// standard Google Shopping PRODUCT feed containing ONLY golf carts.
// Golf carts aren't eligible for Google Vehicle Ads, so they go up as
// ordinary retail products (free listings, free local listings, Shopping ads).
//
// Usage:
//   FEED_URL="https://.../feed.xml" node golf-carts.mjs        (fetch live)
//   node golf-carts.mjs path/to/sample.xml                     (local file, for testing)
//
// Output: writes google-carts-feed.xml (or OUTPUT_PATH).
//
// No external dependencies. Requires Node 20+ (built-in fetch).

import { readFileSync, writeFileSync } from "node:fs";

// ---- Config -----------------------------------------------------------------
const FEED_URL = process.env.FEED_URL || "";
const OUTPUT_PATH = process.env.OUTPUT_PATH || "google-carts-feed.xml";
const MAX_ADDITIONAL_IMAGES = 10;
const CHANNEL_TITLE = "Stellhorn RV Golf Cart Feed";
const CHANNEL_LINK = "https://www.stellhornrv.com";
// Google product taxonomy id for golf carts:
// Vehicles & Parts > Vehicles > Motor Vehicles > Golf Carts
const GOLF_CART_CATEGORY = "3931";
// Store code from the linked Google Business Profile (same store as the RVs).
// Needed if you later enroll these in free LOCAL listings (shows on your GBP).
const STORE_CODE = process.env.STORE_CODE || "GD2151";

// ---- Tiny helpers -----------------------------------------------------------

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
      .replace(/&amp;/g, "&"); // must be last
  } while (out !== prev && ++guard < 5);
  return out;
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripHtml(raw) {
  return decodeEntities(raw)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "13995.0000" -> "13995.00 USD"; blank/invalid -> "".
function formatPrice(raw) {
  const n = Number(String(raw).trim());
  if (!raw || Number.isNaN(n) || n <= 0) return "";
  return `${n.toFixed(2)} USD`;
}

function el(tagName, value) {
  if (value === "" || value == null) return "";
  return `    <${tagName}>${xmlEscape(value)}</${tagName}>\n`;
}

// ---- Core parsing -----------------------------------------------------------

function getInput() {
  const fileArg = process.argv[2];
  if (fileArg) return Promise.resolve(readFileSync(fileArg, "utf8"));
  if (!FEED_URL) throw new Error("Set FEED_URL env var or pass a file path.");
  return fetch(FEED_URL).then((r) => {
    if (!r.ok) throw new Error(`Fetch failed: ${r.status} ${r.statusText}`);
    return r.text();
  });
}

function extractImages(unitChunk) {
  const assetsBlock = tag(unitChunk, "assets");
  const images = [];
  const assetRe = /<asset>([\s\S]*?)<\/asset>/g;
  let m;
  while ((m = assetRe.exec(assetsBlock)) !== null) {
    const asset = m[1];
    const type = tag(asset, "assetType").trim();
    const url = tag(asset, "url").trim();
    if (type === "Unit Photo" && url) images.push(url);
  }
  return images;
}

function buildItem(unit) {
  if (tag(unit, "status").trim() !== "Active") return ""; // only live inventory

  // ONLY golf carts belong in this product feed. Everything else (RVs,
  // towables, motorhomes, trailers) is handled by the vehicle feed.
  const productType = decodeEntities(tag(unit, "productType"));
  if (!/golf\s*cart/i.test(productType)) return "";

  const stockNumber = tag(unit, "stockNumber").trim();
  const brand = decodeEntities(tag(unit, "manufacturer")).trim();       // e.g. ICON Electric Vehicles
  const series = decodeEntities(tag(unit, "make")).trim();              // e.g. EPIC
  const modelCode = decodeEntities(tag(unit, "model")).trim();          // e.g. E40FX -> MPN
  const isNew = tag(unit, "isNew").trim().toLowerCase() === "true";
  const title = decodeEntities(tag(unit, "description")).trim();
  const link = tag(unit, "itemDetailUrl").trim();

  const prices = tag(unit, "prices");
  const price = formatPrice(tag(prices, "sales"));

  const props = tag(unit, "properties");
  const color = decodeEntities(tag(props, "exteriorColor")).trim();
  const description = stripHtml(tag(unit, "details")).slice(0, 5000);

  const images = extractImages(unit);
  const mpn = [series, modelCode].filter(Boolean).join(" ").trim();

  // Shopping requires an id, a price, and an image at minimum.
  if (!stockNumber || !price || !images.length) return "";

  let item = "  <item>\n";
  item += el("g:id", stockNumber);
  item += el("title", title);
  if (description) item += el("description", description);
  item += el("g:google_product_category", GOLF_CART_CATEGORY);
  item += el("g:link", link);
  item += el("g:image_link", images[0]);
  for (const url of images.slice(1, 1 + MAX_ADDITIONAL_IMAGES)) {
    item += el("g:additional_image_link", url);
  }
  item += el("g:condition", isNew ? "new" : "used");
  item += el("g:availability", "in_stock");
  item += el("g:price", price);
  item += el("g:brand", brand);
  if (mpn) item += el("g:mpn", mpn);
  // Golf carts have no retail GTIN/barcode. Brand + MPN cover identification;
  // if Google ever demands a GTIN, flip this to "no" instead.
  item += el("g:identifier_exists", "no");
  if (color) item += el("g:color", color);
  // Store code lets these extend to free LOCAL listings (shows on your GBP).
  item += el("g:store_code", STORE_CODE);
  item += "  </item>\n";
  return item;
}

function build(xml) {
  let items = "";
  let count = 0;

  const unitRe = /<unit>([\s\S]*?)<\/unit>/g;
  let um;
  while ((um = unitRe.exec(xml)) !== null) {
    const item = buildItem(um[1]);
    if (item) {
      items += item;
      count++;
    }
  }

  const rss =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n` +
    `<channel>\n` +
    `  <title>${xmlEscape(CHANNEL_TITLE)}</title>\n` +
    `  <link>${xmlEscape(CHANNEL_LINK)}</link>\n` +
    `  <description>Golf cart inventory for Google Shopping</description>\n` +
    items +
    `</channel>\n</rss>\n`;

  return { rss, count };
}

// ---- Run --------------------------------------------------------------------

const xml = await getInput();
const { rss, count } = build(xml);
writeFileSync(OUTPUT_PATH, rss, "utf8");
console.log(`Wrote ${count} golf carts to ${OUTPUT_PATH}`);
