/**
 * The Ignite button must reach the funnel, whatever the render loop does.
 *
 * 2026-09-18, all reproduced on production:
 *
 *   BLACK SCREEN. CarStage's frame loop opened `if (!visible) return`. Reaching
 *   the Ignite button means scrolling, which pushes the stage off-screen, so
 *   the launch sequence stopped advancing the moment it started. The curtain is
 *   wall-clocked and the car is frame-counted, so the screen went fully black
 *   at ~5.35s and stayed black forever — no car, no navigation, no error.
 *
 *   FLASH OF THE OLD CAR. The 2D blueprint is the SSR fallback and rendered at
 *   opacity-70 until the 3D stage was ready, then cross-faded over 700ms. Every
 *   visitor watched the wrong car first: ~800ms on desktop, 5.6s on a phone.
 *
 *   DEAD CHUNK. `await import("three")` was unguarded, so after a deploy a
 *   browser holding the old HTML got a 404, the scene never built, and Ignite
 *   led to a curtain nothing was left running to finish.
 *
 * These are source assertions, not a browser run — the behaviour lives in an
 * animation frame loop and a WebGL context that jsdom cannot exercise. They are
 * written to fail if the specific mechanism is removed, not merely if a word
 * changes: each one names a distinct control-flow guarantee.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const stage = readFileSync("components/marketing/CarStage.tsx", "utf8");
const builder = readFileSync("components/marketing/HarnessBuilder.tsx", "utf8");

// ── the loop keeps running while a launch is in flight ─────────────────────

assert.doesNotMatch(
  stage,
  /const tick = \(\) => \{\s*raf = requestAnimationFrame\(tick\);\s*if \(!visible\) return;/,
  "the frame loop idles on !visible again — scrolling to Ignite strands the launch on a black screen",
);
assert.match(
  stage,
  /if \(!visible && launchFrame === 0 && !launchRef\.current\) return;/,
  "the off-screen guard no longer exempts an in-flight launch",
);

// ── navigation does not depend on the render loop ──────────────────────────

assert.match(
  builder,
  /launchGuard\.current = window\.setTimeout\(/,
  "the Ignite watchdog is gone — if the frame loop stalls, the visitor never reaches the funnel",
);
assert.match(
  builder,
  /LAUNCH_MS\.total \+ 1000/,
  "the watchdog no longer derives its deadline from the sequence length",
);
// Cleared on the normal path, or a reduced-motion visitor (who completes on the
// first frame) would be navigated twice.
assert.match(
  builder,
  /onLaunchComplete=\{\(\) => \{[\s\S]{0,200}clearTimeout\(launchGuard\.current\)/,
  "onLaunchComplete no longer clears the watchdog — double navigation",
);

// ── a stage that can never run says so ─────────────────────────────────────

assert.match(stage, /onFailRef\.current\?\.\(\)/, "CarStage no longer reports failure");
assert.match(
  stage,
  /try \{\s*THREE = await import\("three"\);\s*\} catch/,
  "the three.js import is unguarded again — a 404 chunk strands the page silently",
);
assert.match(
  builder,
  /onFail=\{\(\) => setStageFailed\(true\)\}/,
  "HarnessBuilder ignores stage failure",
);
// With no 3D coming, Ignite must navigate directly rather than play a curtain
// that has nothing behind it to finish.
assert.match(
  builder,
  /if \(stageFailed\) \{\s*window\.location\.href = AUDIT_FUNNEL\.path;/,
  "a failed stage still runs the curtain on Ignite",
);
// The click reads stageFailed ONCE. A chunk that 404s after the curtain is
// already falling leaves that read seconds stale, and the visitor waits out the
// whole watchdog behind a black screen for a car that is never coming. The
// watchdog bounds that wait; it does not make serving it correct.
assert.match(
  builder,
  /if \(!launching \|\| !stageFailed\) return;[\s\S]{0,160}window\.location\.href = AUDIT_FUNNEL\.path;/,
  "a stage that dies mid-launch no longer short-circuits — the visitor sits out the full watchdog on a black screen",
);

// ── the old 2D car is not shown to someone about to get the real one ───────

assert.match(
  builder,
  /stageFailed \|\| webglOk === false/,
  "the blueprint no longer renders at full opacity for visitors who will never get the car",
);
assert.doesNotMatch(
  builder,
  /stageReady \? "opacity-0" : "opacity-70"/,
  "the blueprint is visible again by default — every visitor sees the wrong car first",
);
// It must still be in the SSR output: it is the real artwork for no-JS visitors.
assert.match(builder, /<svg/, "the SVG fallback was deleted — no-JS visitors get an empty box");
assert.doesNotMatch(
  builder,
  /transition-opacity duration-700/,
  "the 700ms cross-fade is back — the ghosted overlap is a wobble, not a blink",
);

// ── three.js is not on the critical path of every homepage visit ───────────

// The file's own docstring claimed the runtime loaded on scroll. It did not:
// the import ran on mount, so every visitor paid 193KB gzip / 734KB raw — 43%
// of the page's JavaScript — parsed on the main thread while they read the
// hero, for a feature most of them never scrolled to.
assert.match(
  stage,
  /await nearViewport\(\);/,
  "the three.js import no longer waits for the stage to approach the viewport",
);
assert.match(
  stage,
  /new IntersectionObserver\(/,
  "the fetch is no longer gated on intersection",
);
// Degrade to the OLD behaviour where the API is missing. A feature detection
// that failed closed here would cost the car entirely, which is worse than the
// bug it guards against.
assert.match(
  stage,
  /typeof IntersectionObserver === "undefined"\) return resolve\(\);/,
  "a browser without IntersectionObserver would now never load the car",
);
// A visitor who leaves before scrolling must not strand an observer on the node.
assert.match(
  stage,
  /observerRef\.current\?\.disconnect\(\)/,
  "the observer is never disconnected on unmount",
);

console.log("marketing-car-launch: all assertions passed");
