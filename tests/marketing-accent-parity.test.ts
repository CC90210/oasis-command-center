/**
 * marketing-accent-parity.test.ts - the marketing site looks exactly as it
 * did, and an offer page changes only --accent (design section 8.1).
 *
 * WHY. Offer pages reuse the marketing site's CTA classes and eyebrow device
 * rather than copies of them, so one change to a button reaches both and they
 * never drift. To let an offer wear its own colour, the colour in those classes
 * now reads the CSS variable --accent, defaulting to the signal cyan. That is a
 * change to every CTA and eyebrow on oasisai.work, so this pins that it changes
 * nothing anyone can see there:
 *
 *   1. Each class string is exactly the one it replaced, with only the signal
 *      utility swapped for the variable (the strings below are main 34a2944f's).
 *   2. The variable's default is tailwind's signal.DEFAULT, the colour the old
 *      utility drew, so with --accent unset the computed colour is identical.
 *   3. Nothing on the marketing site sets --accent (its layout, its pages, its
 *      components): it can only ever see the default.
 *   4. The eyebrow's rule (marketing.css) falls back to the same signal value.
 *   5. No marketing file carries its own copy of the CTA class string.
 *   6. The offer page's faces (app/fonts/offer-fonts.ts) are the marketing
 *      layout's: the same files, weights, styles, variables and display. Every
 *      offer face has preload off (a plain form page shares its route and must
 *      download no font), and the marketing site still preloads its own.
 * The offer side (an offer page sets --accent on its root and uses these same
 * strings) is rendered and checked in tests/offer-pages-public.test.ts.
 *
 * Run: node --conditions=react-server --import tsx tests/marketing-accent-parity.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import config from "../tailwind.config";

// next/link pulls the client router context, which does not exist under the
// react-server condition these tests run with; Cta.tsx's CtaLink is not what
// this reads, so a plain anchor stands in (as tests/forms-safe.test.ts does).
const linkPath = require.resolve("next/link");
require.cache[linkPath] = { id: linkPath, filename: linkPath, path: dirname(linkPath), loaded: true, children: [], paths: [], exports: { __esModule: true, default: () => null } } as unknown as NodeModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the next/link stand-in above
const { ACCENT_DEFAULT, CTA_INLINE, CTA_PRIMARY, CTA_SECONDARY } = require("../components/marketing/Cta") as typeof import("../components/marketing/Cta");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- same
const { EYEBROW_CLASS } = require("../components/marketing/Section") as typeof import("../components/marketing/Section");

const ROOT = join(__dirname, "..");
const VAR_BG = "bg-[color:var(--accent,#00D4FF)]";
const VAR_TEXT = "text-[color:var(--accent,#00D4FF)]";

// main 34a2944f, verbatim.
const BEFORE = {
  CTA_PRIMARY:
    "inline-flex items-center justify-center gap-2 rounded-md bg-signal px-6 py-3 text-[15px] font-semibold tracking-[-0.01em] text-ops-void transition-all hover:brightness-110 disabled:opacity-60",
  CTA_SECONDARY:
    "inline-flex items-center justify-center gap-2 rounded-md border border-ops-edge px-6 py-3 text-[15px] font-medium tracking-[-0.01em] text-fg-muted transition-colors hover:border-fg-dim hover:text-fg",
  CTA_INLINE: "inline-flex items-center gap-1.5 text-[15px] font-medium text-signal transition-colors hover:text-fg",
  EYEBROW: "m-eyebrow font-data text-[10px] uppercase tracking-[0.26em] text-signal",
};

let checks = 0;
const ok = (cond: boolean, msg: string) => {
  assert.ok(cond, msg);
  checks += 1;
};

// 1. Only the colour utility changed.
assert.equal(CTA_PRIMARY.replace(VAR_BG, "bg-signal"), BEFORE.CTA_PRIMARY, "CTA_PRIMARY changed beyond its colour");
assert.equal(CTA_SECONDARY, BEFORE.CTA_SECONDARY, "CTA_SECONDARY changed");
assert.equal(CTA_INLINE.replace(VAR_TEXT, "text-signal"), BEFORE.CTA_INLINE, "CTA_INLINE changed beyond its colour");
assert.equal(EYEBROW_CLASS.replace(VAR_TEXT, "text-signal"), BEFORE.EYEBROW, "the eyebrow changed beyond its colour");
ok(CTA_PRIMARY.includes(VAR_BG) && CTA_INLINE.includes(VAR_TEXT) && EYEBROW_CLASS.includes(VAR_TEXT), "each reads the variable");
checks += 4;

// 2. The default is the colour the old utility drew.
const signal = ((config.theme?.extend?.colors ?? {}) as Record<string, Record<string, string>>).signal.DEFAULT;
assert.equal(signal.toUpperCase(), "#00D4FF");
assert.equal(ACCENT_DEFAULT.toUpperCase(), signal.toUpperCase());
ok(VAR_BG.includes(`,${signal.toUpperCase()})`), "the class default is signal");

// 3. Nothing on the marketing site sets --accent.
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(full);
  }
  return out;
}
const marketingFiles = [...walk(join(ROOT, "app", "(marketing)")), ...walk(join(ROOT, "components", "marketing"))];
ok(marketingFiles.length > 15, `only ${marketingFiles.length} marketing files walked`);
for (const f of marketingFiles) {
  const src = readFileSync(f, "utf8");
  // A declaration of the variable: "--accent:" in CSS, or a style key in TSX.
  ok(!/--accent\s*:/.test(src) && !/["']--accent["']\s*[:\]]/.test(src), `${relative(ROOT, f)} sets --accent, so the marketing site would not draw its default`);
}

// 4. The eyebrow's rule falls back to signal.
const css = readFileSync(join(ROOT, "app", "(marketing)", "marketing.css"), "utf8");
const rule = /\.m-eyebrow::before\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
ok(/linear-gradient\(to right, var\(--accent, theme\("colors\.signal\.DEFAULT"\)\), transparent\)/.test(rule), "the eyebrow's rule does not fall back to signal");

// 5. No copies of the CTA string: one definition, imported everywhere.
for (const f of marketingFiles.filter((x) => !x.endsWith("Cta.tsx"))) {
  const src = readFileSync(f, "utf8");
  ok(!src.includes("rounded-md bg-[color:var(--accent") && !src.includes("gap-2 rounded-md bg-signal px-6 py-3"), `${relative(ROOT, f)} carries its own copy of the primary CTA classes`);
}

// 6. The offer faces are the marketing faces, and never preload.
type Face = { files: string[]; variable: string; display: string; preloadOff: boolean };
const facesOf = (src: string): Face[] =>
  [...src.matchAll(/localFont\(\{([\s\S]*?)\n\}\);/g)].map((m) => ({
    files: [...m[1].matchAll(/path:\s*"(?:\.\.\/fonts\/|\.\/)([\w.-]+\.woff2)",\s*weight:\s*"(\d+)",\s*style:\s*"(\w+)"/g)].map((f) => `${f[1]}|${f[2]}|${f[3]}`),
    variable: /variable:\s*"(--font-[a-z]+)"/.exec(m[1])?.[1] ?? "",
    display: /display:\s*"(\w+)"/.exec(m[1])?.[1] ?? "",
    preloadOff: /preload:\s*false/.test(m[1]),
  }));
const siteFaces = facesOf(readFileSync(join(ROOT, "app", "(marketing)", "layout.tsx"), "utf8"));
const offerFaces = facesOf(readFileSync(join(ROOT, "app", "fonts", "offer-fonts.ts"), "utf8"));
ok(
  siteFaces.length === 3 && offerFaces.length === 3 && siteFaces.every((f) => f.files.length >= 2 && f.variable && f.display),
  `expected three complete faces on each side, found ${siteFaces.length} and ${offerFaces.length}`,
);
const shapeOf = (faces: Face[]) => JSON.stringify(faces.map(({ files, variable, display }) => ({ files, variable, display })));
assert.equal(shapeOf(offerFaces), shapeOf(siteFaces), "the offer page's faces drifted from the marketing site's (files, weights, styles, variables or display)");
checks += 1;
ok(offerFaces.every((f) => f.preloadOff), "an offer face preloads, so every plain form page on /f/ would download it");
ok(siteFaces.every((f) => !f.preloadOff), "the marketing site stopped preloading its own faces");

console.log(`marketing-accent-parity: OK - ${checks} checks over ${marketingFiles.length} marketing files`);
