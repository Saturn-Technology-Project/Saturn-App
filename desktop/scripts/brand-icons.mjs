// Builds src/assets/brands/<id>.* — the official, full-color icon for each Customizations integration.
// Run with: node scripts/brand-icons.mjs
// 1. Full-color SVG logos from Iconify's "logos" set (CC0, svgporn/gilbarbara), when the brand is there.
// 2. Otherwise the icon the vendor publishes: an explicit official asset URL, or the SVG icon /
//    apple-touch-icon its homepage declares.
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getIconData, iconToHTML, iconToSVG, replaceIDs } from "@iconify/utils";

const require = createRequire(import.meta.url);
const logos = require("@iconify-json/logos/icons.json");
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "assets", "brands");

const LOGOS = {
  shopify: "shopify", xero: "xero", "google-calendar": "google-calendar", notion: "notion-icon",
  "google-drive": "google-drive", figma: "figma", adobe: "adobe", spotify: "spotify-icon", github: "github-icon",
  linear: "linear-icon", atlassian: "atlassian", vercel: "vercel-icon", supabase: "supabase-icon", neon: "neon-icon",
  huggingface: "hugging-face-icon", gmail: "google-gmail", slack: "slack-icon", sentry: "sentry-icon", "microsoft-365": "microsoft-icon",
};

/** Official files published by the vendor (listed in the MCP registry or the vendor's brand pages). */
const ASSETS = {
  "google-docs": "https://www.gstatic.com/images/branding/product/2x/docs_2020q4_48dp.png",
  "google-sheets": "https://www.gstatic.com/images/branding/product/2x/sheets_2020q4_48dp.png",
  "google-slides": "https://www.gstatic.com/images/branding/product/2x/slides_2020q4_48dp.png",
  context7: "https://context7.com/context7-icon-green.png",
  // Mercury's declared SVG icon follows the browser's color scheme (white in dark mode); its touch icon is fixed.
  mercury: "https://mercury.com/apple-icon.png",
};

/** Vendor homepages whose declared icon is used. */
const SITES = {
  "saturn-mcp": "https://saturn-core.com", stripe: "https://stripe.com", brex: "https://www.brex.com", ramp: "https://ramp.com", carta: "https://carta.com",
  ibkr: "https://www.interactivebrokers.com", dukascopy: "https://www.dukascopy.com", etherscan: "https://etherscan.io",
  plaid: "https://plaid.com", northwest: "https://www.northwestregisteredagent.com", factset: "https://www.factset.com",
  "financial-datasets": "https://www.financialdatasets.ai", "twelve-data": "https://twelvedata.com",
  "seeking-alpha": "https://seekingalpha.com", "sec-api": "https://sec-api.io", canva: "https://www.canva.com",
  indeed: "https://www.indeed.com", booking: "https://www.booking.com", deepwiki: "https://deepwiki.com", sumsub: "https://sumsub.com",
};

const UA = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36" };
const EXT = { "image/svg+xml": "svg", "image/png": "png", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/webp": "webp", "image/jpeg": "jpg" };

async function download(id, url) {
  const response = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim();
  const ext = EXT[type] ?? path.extname(new URL(url).pathname).slice(1).toLowerCase();
  if (!["svg", "png", "ico", "webp", "jpg"].includes(ext)) throw new Error(`not an image (${type}) at ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 100) throw new Error(`empty image at ${url}`);
  await writeFile(path.join(out, `${id}.${ext}`), bytes);
  return `${ext}, ${Math.round(bytes.length / 1024)}KB from ${url}`;
}

/** Picks the best icon a homepage declares: SVG icon, then the largest apple-touch-icon / PNG icon, then /favicon.ico. */
async function siteIcon(site) {
  const html = await (await fetch(site, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(15000) })).text();
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).filter((tag) => /rel=["'][^"']*icon[^"']*["']/i.test(tag) && !/mask-icon/i.test(tag)); // mask icons are single-color
  const parsed = links.map((tag) => {
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    const sizes = Number(/sizes=["'](\d+)x\d+["']/i.exec(tag)?.[1] ?? 0);
    const svg = /type=["']image\/svg\+xml["']/i.test(tag) || /\.svg(\?|$)/i.test(href ?? "");
    const touch = /apple-touch-icon/i.test(tag);
    return { href, score: (svg ? 10_000 : 0) + (touch ? 1000 : 0) + sizes };
  }).filter((item) => item.href && !item.href.startsWith("data:"));
  parsed.sort((a, b) => b.score - a.score);
  const base = new URL(site);
  return [...parsed.map((item) => new URL(item.href, base).toString()), new URL("/apple-touch-icon.png", base).toString(), new URL("/favicon.ico", base).toString()];
}

await mkdir(out, { recursive: true });
for (const file of await readdir(out)) await rm(path.join(out, file));

for (const [id, name] of Object.entries(LOGOS)) {
  const data = getIconData(logos, name);
  if (!data) { console.log(`✗ ${id}: logos:${name} missing`); continue; }
  const svg = iconToSVG(data, { height: "auto" });
  await writeFile(path.join(out, `${id}.svg`), iconToHTML(replaceIDs(svg.body, id), svg.attributes));
  console.log(`✓ ${id}: logos:${name}`);
}
for (const [id, url] of Object.entries(ASSETS)) {
  try { console.log(`✓ ${id}: ${await download(id, url)}`); } catch (error) { console.log(`✗ ${id}: ${error.message}`); }
}
for (const [id, site] of Object.entries(SITES)) {
  let done = false;
  try {
    for (const url of await siteIcon(site)) {
      try { console.log(`✓ ${id}: ${await download(id, url)}`); done = true; break; } catch { /* next candidate */ }
    }
  } catch (error) { console.log(`✗ ${id}: ${error.message}`); continue; }
  if (!done) console.log(`✗ ${id}: no usable icon on ${site}`);
}
