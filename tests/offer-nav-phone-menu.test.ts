/**
 * tests/offer-nav-phone-menu.test.ts - an offer page's sections are reachable
 * from the header on a phone (CC, 2026-10-16: "the nav must take you to the
 * different sections"; on a phone the header showed only the mark and the
 * button, and most ad traffic arrives on phones).
 *
 * Proves: the phone menu lists exactly the anchors the desktop nav draws; it
 * is a real disclosure (aria-expanded / aria-controls on the panel it opens)
 * and starts closed; it renders only below md; a page with no pinned sections
 * draws no menu button; choosing a section and Escape both close it.
 *
 * Run: node --conditions=react-server --import tsx tests/offer-nav-phone-menu.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${String((error as Error).message).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

console.log("offer nav phone menu");

const childEnv: NodeJS.ProcessEnv = { ...process.env, TSX_TSCONFIG_PATH: "tests/tsconfig.render.json" };
const kept = (process.env.NODE_OPTIONS ?? "").split(/\s+/).filter((t) => t && !/^(--conditions=|-C=)/.test(t) && t !== "--conditions" && t !== "-C");
if (kept.length) childEnv.NODE_OPTIONS = kept.join(" ");
else delete childEnv.NODE_OPTIONS;
const r = spawnSync(process.execPath, ["--import", "tsx", "tests/offer-nav-phone-menu.render.ts"], { encoding: "utf8", env: childEnv });
assert.equal(r.status, 0, `renderer failed:\n${r.stderr}`);
const html = JSON.parse(r.stdout) as { withNav: string; withoutNav: string };

const anchorsIn = (markup: string) => [...markup.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
const desktop = (html.withNav.match(/<nav aria-label="On this page" class="hidden[^"]*md:flex[^"]*">([\s\S]*?)<\/nav>/) || [])[1] ?? "";
const phone = (html.withNav.match(/<nav id="([^"]+)" aria-label="On this page" hidden=""[^>]*>([\s\S]*?)<\/nav>/) || []);

check("the phone menu lists exactly the sections the desktop nav draws", () => {
  assert.ok(desktop, "control: the desktop nav rendered");
  assert.ok(phone[2], "no closed phone panel rendered");
  assert.deepEqual(anchorsIn(phone[2]), anchorsIn(desktop));
  assert.deepEqual(anchorsIn(desktop), ["obstacles", "what-you-get", "pricing", "faq"]);
});

check("the menu button is a disclosure for that panel, closed until pressed", () => {
  const button = html.withNav.match(/<button type="button" aria-expanded="false" aria-controls="([^"]+)" aria-label="Open the page sections"/);
  assert.ok(button, "no closed menu button with aria-expanded / aria-controls");
  assert.equal(button[1], phone[1], "the button controls a different element than the panel");
});

check("the menu exists only below md, where the desktop nav is hidden", () => {
  assert.match(html.withNav, /<div class="md:hidden"><button type="button" aria-expanded/);
});

check("a page with no pinned sections draws no menu button", () => {
  assert.doesNotMatch(html.withoutNav, /aria-expanded/);
  assert.match(html.withoutNav, /href="#book"/, "control: the Book button is still there");
});

check("choosing a section, and Escape, close the menu; Escape gives focus back to the button", () => {
  const src = readFileSync(join(ROOT, "components/offer-pages/OfferNavMenu.tsx"), "utf8");
  assert.match(src, /href=\{`#\$\{n\.anchor\}`\}\s*onClick=\{\(\) => choose\(n\.anchor\)\}/, "a chosen section does not go through choose()");
  assert.match(src, /function choose\(anchor: string\) \{\s*setOpen\(false\);/, "a chosen section leaves the panel open over the page");
  assert.match(src, /getElementById\(anchor\)[\s\S]{0,160}target\.focus\(\{ preventScroll: true \}\)/, "a chosen section drops keyboard focus instead of moving it there");
  assert.match(src, /if \(e\.key !== "Escape"\) return;\s*setOpen\(false\);[\s\S]{0,160}trigger\.current\?\.focus\(\);/, "Escape does not close the panel and return focus");
  assert.match(src, /<button\s+ref=\{trigger\}/, "the focus target is not the menu button");
});

// Codex on #665 (second pass): the Book button or the mark's #top, pressed with
// the menu open, left the panel over the section they went to.
check("a tap or focus outside the menu, or a hash change, closes it", () => {
  const src = readFileSync(join(ROOT, "components/offer-pages/OfferNavMenu.tsx"), "utf8");
  assert.match(src, /root\.current && !root\.current\.contains\(e\.target as Node\)\) setOpen\(false\)/, "outside does not close");
  for (const ev of ['document.addEventListener("pointerdown", outside)', 'document.addEventListener("focusin", outside)', 'window.addEventListener("hashchange", onHash)']) {
    assert.ok(src.includes(ev), `missing listener: ${ev}`);
  }
  assert.match(src, /<div ref=\{root\} className="md:hidden">/, "the outside test is not anchored on the menu");
});

// Codex on #665 (third pass): the panel's room is measured from where it starts
// (an owner's preview banner pushes it down); rotating past md closes it; a
// hash change while a panel link has focus carries focus to where the page went.
check("the panel's height comes from where it starts; rotating past md and Back keep focus visible", () => {
  const src = readFileSync(join(ROOT, "components/offer-pages/OfferNavMenu.tsx"), "utf8");
  assert.match(src, /panel\.current\?\.getBoundingClientRect\(\)\.top[\s\S]{0,120}window\.innerHeight - top/, "the panel height ignores where it starts");
  assert.match(src, /style=\{maxHeight \? \{ maxHeight \} : undefined\}/, "the measured height is not applied");
  assert.match(src, /matchMedia\("\(min-width: 768px\)"\)[\s\S]{0,200}if \(!wide\.matches\) return;\s*const hadFocus[\s\S]{0,80}setOpen\(false\);/, "crossing md leaves a stale open panel");
  assert.match(src, /if \(hadFocus && !focusTarget\(window\.location\.hash\.slice\(1\)\)\) trigger\.current\?\.focus\(\);/, "a hash change drops focus");
  assert.ok(src.includes('wide.addEventListener("change", onWide);'), "the md breakpoint is never listened for");
  assert.ok(src.includes('wide.removeEventListener("change", onWide);'), "the md listener outlives the open menu");
});

// Codex on #665: a long menu on a short (landscape) phone ran past the screen,
// and a long CTA label beside the new button overflowed a 320px header.
check("the open panel scrolls within the screen under the bar", () => {
  assert.match(html.withNav, /<nav id="[^"]+" aria-label="On this page" hidden="" class="[^"]*max-h-\[calc\(100dvh-4rem\)\][^"]*overflow-y-auto/);
});

check("on a phone the Book label is capped with an ellipsis, in full from sm up", () => {
  assert.match(html.withNav, /<a href="#book" class="[^"]*min-w-0 max-w-\[10\.5rem\][^"]*sm:max-w-none"[^>]*><span class="min-w-0 truncate">Request the audit<\/span><\/a>/);
  assert.match(html.withNav, /<div class="flex min-w-0 items-center gap-1"><div class="md:hidden">/, "the button cluster cannot shrink");
});

if (failures) {
  console.log(`offer-nav-phone-menu: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("offer-nav-phone-menu: all passed");
