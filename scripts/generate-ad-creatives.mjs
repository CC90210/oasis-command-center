// Regenerates lib/cold-outreach/ad-creatives.generated.ts from lib/cold-outreach/ads/*.html.
// These are STATIC social-ad creatives (fixed 1080px canvases) for the /templates
// gallery ONLY — deliberately NOT in COLD_OUTREACH_TEMPLATES (the email SEND path),
// so an ad can never be queued as an email. Run:
//   node scripts/generate-ad-creatives.mjs
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "lib", "cold-outreach", "ads");
const outFile = join(root, "lib", "cold-outreach", "ad-creatives.generated.ts");
const files = readdirSync(srcDir).filter((f) => f.endsWith(".html")).sort();

function titleCase(key) {
  return key.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
// format = the ad layout family, derived from the filename.
function inferFormat(key) {
  if (key.includes("story") || key.includes("spotlight")) return key.includes("spotlight") ? "spotlight" : "tier-stack";
  if (key.includes("hero")) return "hero-number";
  if (key.includes("rows")) return "borrow-rows";
  if (key.includes("framed") || key.includes("card")) return "framed-card";
  return "ad";
}
function inferCanvas(html) {
  const w = html.match(/width\s*:\s*(1080|540)px/);
  const isStory = /1920px/.test(html);
  return isStory ? "1080x1920" : "1080x1080";
}

const entries = files.map((file) => {
  const key = basename(file, ".html");
  const html = readFileSync(join(srcDir, file), "utf8");
  return { key, name: titleCase(key), format: inferFormat(key), canvas: inferCanvas(html), html };
});

const banner = `// GENERATED FILE - do not edit by hand.
// Run \`node scripts/generate-ad-creatives.mjs\` after updating lib/cold-outreach/ads/*.html.
// Static social-ad creatives for the /templates gallery ONLY (never the email send path).

export type AdCreative = {
  key: string;
  name: string;
  /** Layout family: tier-stack | hero-number | borrow-rows | framed-card | spotlight */
  format: string;
  /** Render canvas, e.g. 1080x1080 (feed) or 1080x1920 (story). */
  canvas: string;
  html: string;
};

export const AD_CREATIVES: AdCreative[] = `;

writeFileSync(outFile, banner + JSON.stringify(entries, null, 2) + ";\n");
console.log(`wrote ${outFile} with ${entries.length} ad creatives`);
