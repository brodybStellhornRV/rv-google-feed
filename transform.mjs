// transform.mjs
// Fetches the RV One (InteractRV) inventory XML and rewrites it into a
// Google Vehicle Ads RSS 2.0 feed that Google Merchant Center can ingest.
//
// Usage:
//   FEED_URL="https://.../feed.xml" node transform.mjs            (fetch live)
//   node transform.mjs path/to/sample.xml                          (local file, for testing)
//
// Output: writes google-feed.xml in the current directory (or OUTPUT_PATH).
//
// No external dependencies. Requires Node 20+ (built-in fetch).

import { readFileSync, writeFileSync } from "node:fs";

// ---- Config -----------------------------------------------------------------
const FEED_URL = process.env.FEED_URL || "";        // set this in GitHub Actions
const OUTPUT_PATH = process.env.OUTPUT_PATH || "google-feed.xml";
const MAX_ADDITIONAL_IMAGES = 10;                   // Google-friendly cap
const CHANNEL_TITLE = "Stellhorn RV Vehicle Feed";
const CHANNEL_LINK = "https://www.stellhornrv.com";

// ---- Tiny helpers -----------------------------------------------------------

// Pull the first <tag>...</tag> text from a chunk (non-greedy, no nesting).
function tag(chunk, name) {
  const m = chunk.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : "";
}

// Decode the XML entities present in this feed, then re-escape safely on output.
// Loops until stable so double-encoded values (e.g. "&amp;amp;" -> "&") resolve.
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

// Escape a plain string for safe inclusion in XML text.
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Strip HTML tags and collapse whitespace (for the description field).
function stripHtml(raw) {
  return decodeEntities(raw)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "65911.0000" -> "65911.00 USD"; blank/invalid -> "".
function formatPrice(raw) {
  const n = Number(String(raw).trim());
  if (!raw || Number.isNaN(n) || n <= 0) return "";
  return `${n.toFixed(2)} USD`;
}

// Mileage for used units: strip to digits; if the source has none, use "0".
function usedMileage(raw) {
  const digits = String(raw).replace(/[^\d]/g, "");
  return digits || "0";
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

// Extract images from a <unit> chunk: keep only assetType "Unit Photo".
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

function buildItem(unit, loc, dealershipName) {
  if (tag(unit, "status").trim() !== "Active") return ""; // only live inventory

  // Golf carts aren't eligible for Google Vehicle Ads; they belong in the
  // separate Shopping product feed. Skip them here.
  const productType = decodeEntities(tag(unit, "productType"));
  if (/golf\s*cart/i.test(productType)) return "";

  const stockNumber = tag(unit, "stockNumber").trim();
  const vin = tag(unit, "globalUniqueId").trim();
  const manufacturer = decodeEntities(tag(unit, "manufacturer")).trim(); // -> make
  const series = decodeEntities(tag(unit, "make")).trim();               // -> model
  const floorplan = decodeEntities(tag(unit, "model")).trim();           // -> trim
  const year = tag(unit, "year").trim();
  const isNew = tag(unit, "isNew").trim().toLowerCase() === "true";
  const title = decodeEntities(tag(unit, "description")).trim();
  const link = tag(unit, "itemDetailUrl").trim();

  const prices = tag(unit, "prices");
  const price = formatPrice(tag(prices, "sales"));
  const msrp = formatPrice(tag(prices, "msrp"));

  const props = tag(unit, "properties");
  const features = decodeEntities(tag(props, "features")).trim();
  const exteriorColor = decodeEntities(tag(props, "exteriorColor")).trim();
  const interiorColor = decodeEntities(tag(props, "interiorColor")).trim();
  // RV One's XML doesn't export mileage for towables. Google requires g:mileage
  // on used vehicles, so fall back to "0" (how dealers list trailers: "Used - 0 mi").
  const miles = usedMileage(tag(props, "miles"));
  const description = stripHtml(tag(unit, "details")).slice(0, 2000);

  const images = extractImages(unit);

  // Skip anything missing a hard requirement.
  if (!vin || !price || !stockNumber) return "";

  const addr = [
    tag(loc, "address").trim(),
    tag(loc, "city").trim(),
    `${tag(loc, "state").trim()} ${tag(loc, "zip").trim()}`.trim(),
    tag(loc, "country").trim(),
  ]
    .filter(Boolean)
    .join(", ");

  let item = "  <item>\n";
  item += el("g:id", stockNumber);
  item += el("g:vin", vin);
  item += el("title", title);
  item += el("g:condition", isNew ? "new" : "used");
  item += el("g:make", manufacturer);
  item += el("g:model", series);
  item += el("g:trim", floorplan);
  item += el("g:year", year);
  if (!isNew) item += el("g:mileage", miles); // required for used; defaults to 0
  item += el("g:price", price);
  if (isNew) item += el("g:vehicle_msrp", msrp);
  item += el("g:link", link);
  if (images.length) item += el("g:image_link", images[0]);
  for (const url of images.slice(1, 1 + MAX_ADDITIONAL_IMAGES)) {
    item += el("g:additional_image_link", url);
  }
  item += el("g:store_code", tag(loc, "id").trim());
  item += el("g:dealership_name", dealershipName);
  item += el("g:dealership_address", addr);
  item += el("g:vehicle_fulfillment", "IN_STORE");
  if (features) item += el("g:vehicle_option", features.split("|").join(","));
  if (exteriorColor) item += el("g:exterior_color", exteriorColor);
  if (interiorColor) item += el("g:interior_color", interiorColor);
  if (description) item += el("g:description", description);
  item += "  </item>\n";
  return item;
}

function build(xml) {
  // Dealership (business) name = the <name> directly under <account>.
  const dealershipName = decodeEntities(
    (xml.match(/<account><name>([\s\S]*?)<\/name>/) || [, ""])[1]
  ).trim();

  let items = "";
  let count = 0;

  // Each <location> block carries its own address + units.
  const locRe = /<location>([\s\S]*?)<\/location>/g;
  let lm;
  while ((lm = locRe.exec(xml)) !== null) {
    const locBlock = lm[1];
    const locHeader = locBlock.split("<units>")[0]; // address fields live here
    const unitsBlock = tag(locBlock, "units");

    const unitRe = /<unit>([\s\S]*?)<\/unit>/g;
    let um;
    while ((um = unitRe.exec(unitsBlock)) !== null) {
      const item = buildItem(um[1], locHeader, dealershipName);
      if (item) {
        items += item;
        count++;
      }
    }
  }

  const rss =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n` +
    `<channel>\n` +
    `  <title>${xmlEscape(CHANNEL_TITLE)}</title>\n` +
    `  <link>${xmlEscape(CHANNEL_LINK)}</link>\n` +
    `  <description>Vehicle inventory for Google Vehicle Ads</description>\n` +
    items +
    `</channel>\n</rss>\n`;

  return { rss, count };
}

// ---- Run --------------------------------------------------------------------

const xml = await getInput();
const { rss, count } = build(xml);
writeFileSync(OUTPUT_PATH, rss, "utf8");
console.log(`Wrote ${count} vehicles to ${OUTPUT_PATH}`);
