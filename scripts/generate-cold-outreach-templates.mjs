/**
 * Regenerates lib/cold-outreach/templates.generated.ts from the HTML
 * email templates in lib/cold-outreach/templates/.
 *
 * Source of truth for the HTML lives in SunBiz-Agent/docs/*.html (the
 * published template library). To update: copy the changed .html files
 * into lib/cold-outreach/templates/, then run
 *
 *   node scripts/generate-cold-outreach-templates.mjs
 *
 * The generated module is committed so the Vercel build has no runtime
 * fs dependency (no output-file-tracing footguns for dynamically read
 * assets).
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "lib", "cold-outreach", "templates");
const outFile = join(root, "lib", "cold-outreach", "templates.generated.ts");

const files = readdirSync(srcDir).filter((f) => f.endsWith(".html")).sort();
if (files.length === 0) {
  console.error(`no .html templates found in ${srcDir}`);
  process.exit(1);
}

function titleCase(key) {
  return key
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const entries = files.map((file) => {
  const key = basename(file, ".html");
  const html = readFileSync(join(srcDir, file), "utf8");
  // Default subject = the template's <title>, minus the brand suffix the
  // titles carry for the browser-tab view of the template library.
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const subject = (titleMatch ? titleMatch[1] : titleCase(key))
    .replace(/\s*(?:\u2014|-|&mdash;|&#8212;)\s*SunBiz Funding\s*$/i, "")
    .trim();
  return { key, name: titleCase(key), subject, html };
});

const banner = `// GENERATED FILE - do not edit by hand.
// Run \`node scripts/generate-cold-outreach-templates.mjs\` after updating
// the .html sources in lib/cold-outreach/templates/ (which mirror
// SunBiz-Agent/docs/*.html).

export type ColdOutreachTemplate = {
  /** Stable key - the source filename without extension. */
  key: string;
  /** Display name for the picker. */
  name: string;
  /** Suggested subject line (template <title> minus brand suffix). */
  subject: string;
  /** Full email-ready HTML. Tokens: {{first_name}} {{business_name}} {{year}} {{unsubscribe_url}}. */
  html: string;
};

export const COLD_OUTREACH_TEMPLATES: ColdOutreachTemplate[] = `;

writeFileSync(outFile, banner + JSON.stringify(entries, null, 2) + ";\n");
console.log(`wrote ${outFile} with ${entries.length} templates`);
