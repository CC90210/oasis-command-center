/**
 * The hero of every public page is visible in the first frame.
 *
 * WHY. <Reveal> fades content in on scroll: marketing.css starts every
 * `.js .m-reveal` at opacity 0 and only the component's IntersectionObserver
 * (which needs the page's JavaScript to have loaded and hydrated) adds the
 * class that shows it, then a 0.7 s transition plus a stagger. That is fine
 * below the fold, where the visitor has to scroll first anyway. In the hero it
 * hid the headline the visitor came for: on a mid-range phone (CPU 4x, slow
 * network, 2026-10-18) /contact /about /pricing painted at ~1.6 s but the h1
 * stayed invisible until ~3.0 s and was fully shown at ~3.5 s, and PageSpeed's
 * Speed Index sat at 4.1 s.
 *
 * THE RULE. The first <section> a public page renders carries `m-hero`, and
 * marketing.css keeps every `.m-reveal` inside `.m-hero` visible with no
 * transition. Reveals further down still fade.
 *
 * Run: node --import tsx tests/hero-visible-first-frame.test.ts
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(__dirname, "..");
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

/** The opening tag of the first <section> in a file's JSX, or null. */
export function firstSectionTag(source: string): string | null {
  const m = source.match(/<section\b[^>]*>/);
  return m ? m[0] : null;
}

/** True when a class attribute on the tag names `m-hero` as a whole word. */
export function marksHero(tag: string): boolean {
  const cls = tag.match(/className=(?:"([^"]*)"|\{`([^`]*)`\})/);
  return !!cls && /(^|\s)m-hero(\s|$)/.test(cls[1] ?? cls[2] ?? "");
}

// Self-test the parser on known shapes, so a regex that matches nothing cannot pass.
assert.equal(marksHero(`<section className="m-edge m-hero relative">`), true);
assert.equal(marksHero(`<section className="m-edge relative overflow-hidden">`), false);
assert.equal(marksHero(`<section className="m-heroic">`), false);
assert.equal(firstSectionTag(`<>\n<section className="a">x</section><section className="b">`), `<section className="a">`);

// Every file that renders a page hero with <Reveal>: the marketing pages and the offer-page shell.
const candidates = [
  ...walk(join(ROOT, "app", "(marketing)")).filter((f) => f.endsWith("page.tsx")),
  join(ROOT, "components", "offer-pages", "OfferPage.tsx"),
];
const withReveal = candidates.filter((f) => /<Reveal\b/.test(readFileSync(f, "utf8")) || rel(f).endsWith("OfferPage.tsx"));
assert.ok(withReveal.length >= 7, `precondition: found the Reveal pages (got ${withReveal.length})`);

/**
 * One file can hold several pages: funnel/[funnel]/page.tsx renders /audit, /pricing,
 * /command-center, /onboarding and /checkout-success from five *Page functions, each
 * with its own hero. So the unit is the page FUNCTION, not the file.
 */
export function pageFunctions(source: string): { name: string; body: string }[] {
  // A *Page function, or the default export whatever its name (home's is MarketingHome).
  const starts = [...source.matchAll(/^(?:export\s+default\s+(?:async\s+)?function\s+(\w+)|(?:export\s+)?(?:async\s+)?function\s+(\w+Page)\b)/gm)]
    .map((m) => Object.assign(m, { 1: m[1] ?? m[2] }));
  return starts.map((m, i) => ({ name: m[1], body: source.slice(m.index!, starts[i + 1]?.index ?? source.length) }));
}
assert.deepEqual(
  pageFunctions(`function APage() {<section/>}\nexport default async function BPage() {}`).map((p) => p.name),
  ["APage", "BPage"],
);

const missing: string[] = [];
let checked = 0;
for (const f of withReveal) {
  for (const page of pageFunctions(readFileSync(f, "utf8"))) {
    // The offer-page shell fades through its section components (offer-pages/sections.tsx),
    // so it is checked whether or not <Reveal> appears in its own body.
    if (!/<Reveal\b/.test(page.body) && !rel(f).endsWith("OfferPage.tsx")) continue;
    checked++;
    const tag = firstSectionTag(page.body);
    if (!tag || !marksHero(tag)) missing.push(`${rel(f)} ${page.name}: ${tag ?? "(no <section>)"}`);
  }
}
assert.ok(checked >= 11, `precondition: found every page that fades content (got ${checked})`);
assert.deepEqual(missing, [], `a page's first <section> must carry m-hero so its text is in the first frame:\n  ${missing.join("\n  ")}`);

// The CSS half: inside .m-hero a reveal is shown, unmoved, and not transitioned.
const css = readFileSync(join(ROOT, "app", "(marketing)", "marketing.css"), "utf8");
const rule = css.match(/\.js\s+\.m-hero\s+\.m-reveal\s*\{([^}]*)\}/);
assert.ok(rule, "marketing.css must have a `.js .m-hero .m-reveal` rule");
const body = rule![1].replace(/\s+/g, " ");
assert.match(body, /opacity:\s*1\b/, "hero reveal must be opacity 1");
assert.match(body, /transform:\s*none\b/, "hero reveal must not be offset");
assert.match(body, /transition:\s*none\b/, "hero reveal must not transition");
// The hero rule is more specific than the start state, so it wins anyway; keeping it after the
// start state means the file reads in the order the cascade applies.
assert.ok(css.indexOf(rule![0]) > css.indexOf(".js .m-reveal {"), "hero rule sits after the hidden start state");

console.log(`hero-visible-first-frame: ${checked} pages in ${withReveal.length} files show their hero in the first frame`);
