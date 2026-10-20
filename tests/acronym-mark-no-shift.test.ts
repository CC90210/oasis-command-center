/**
 * The home hero's O·A·S·I·S name does not push the page around while it plays.
 *
 * WHY. AcronymMark renders the full phrase on the server (readable with no
 * JavaScript), collapses it to "O A S I S" on mount, then unfolds it letter by
 * letter. On a phone the full phrase wraps to more lines than "O A S I S", so
 * the collapse pulled everything below it up and the unfold pushed it back
 * down. Once the hero became visible from the first frame (PR #707), those two
 * moves counted as layout shift: home CLS 0.55 on a 412 px phone (local and
 * prod, 2026-10-19), PageSpeed CLS 0.26-0.41, home performance 94 -> 72.
 *
 * THE RULE. Before the collapse, the mark holds its server-rendered height
 * (holdHeight); it lets go only after the last letter has finished unfolding,
 * when the height is the same again, and on unmount.
 *
 * Run: node --import tsx tests/acronym-mark-no-shift.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { holdHeight } from "../components/marketing/hold-height";

const ROOT = join(__dirname, "..");

// 1. holdHeight pins the element at its current height and gives it back.
{
  const el = { offsetHeight: 138, style: { minHeight: "" } };
  const release = holdHeight(el);
  assert.equal(el.style.minHeight, "138px", "held at the measured height");
  el.offsetHeight = 40; // the row collapses underneath the hold
  assert.equal(el.style.minHeight, "138px", "the hold does not follow the collapse");
  release();
  assert.equal(el.style.minHeight, "", "release restores the element's own sizing");
  release(); // a second release (timer + unmount) is harmless
  assert.equal(el.style.minHeight, "");
}
{
  const el = { offsetHeight: 50, style: { minHeight: "10px" } };
  holdHeight(el)();
  assert.equal(el.style.minHeight, "10px", "release restores a min-height that was already there");
}
{
  const release = holdHeight(null);
  release(); // no element (ref not attached): a no-op, never a throw
}

// 2. AcronymMark holds before it collapses, and lets go after the unfold and on unmount.
const src = readFileSync(join(ROOT, "components", "marketing", "AcronymMark.tsx"), "utf8");
const effect = src.slice(src.indexOf("useEffect("), src.indexOf("const toggle"));
assert.ok(effect.length > 0, "precondition: found AcronymMark's mount effect");

const hold = effect.search(/holdHeight\(/);
const collapse = effect.indexOf("setOpen(LETTERS.map(() => false))");
assert.ok(collapse > 0, "precondition: found the collapse");
assert.ok(hold > 0 && hold < collapse, "the height is held BEFORE the mark collapses");

const cleanup = effect.slice(effect.lastIndexOf("return () => {"));
assert.match(cleanup, /release\(\)/, "unmount lets go of the height");

const releaseTimer = effect.match(/setTimeout\(\s*release\s*,\s*([^)]*)\)/);
assert.ok(releaseTimer, "a timer lets go of the height after the unfold");
assert.match(releaseTimer[1], /LETTERS\.length/, "the release waits for the LAST letter");
assert.match(releaseTimer[1], /UNFOLD_MS/, "the release waits for the last letter's transition");

// The unfold duration in TS must match the CSS transition it waits for.
const css = readFileSync(join(ROOT, "app", "(marketing)", "marketing.css"), "utf8");
const cssMs = Number(css.match(/\.m-acr-word\s*\{[^}]*transition:\s*grid-template-columns\s+([\d.]+)s/)?.[1]) * 1000;
const tsMs = Number(src.match(/const UNFOLD_MS = (\d+)/)?.[1]);
assert.ok(cssMs > 0, "precondition: read the .m-acr-word transition from marketing.css");
assert.equal(tsMs, cssMs, "UNFOLD_MS equals the .m-acr-word transition in marketing.css");

console.log("acronym-mark-no-shift: ok");
