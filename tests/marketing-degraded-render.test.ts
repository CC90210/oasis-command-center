/**
 * A degraded read must not be rendered as a measured zero — on ANY surface.
 *
 * lib/founders/marketing-queries.ts documents why `degraded` exists: a made-up
 * zero is "the worst possible answer", because "no assets" and "we could not
 * find out" look identical on screen and only one of them is true.
 *
 * The Studio page honoured that in two places out of seven. An adversarial
 * audit found the other five: a failed read showed "No assets registered yet."
 * about a library holding thirteen assets, "Nothing queued.", "Nothing yet.
 * Drop links in Train and they land here." and 0/0/0/0 track tiles — directly
 * beneath the panel announcing that the query had failed. I fixed the tiles
 * first and left the three cards, which is how a defect class survives its own
 * fix.
 *
 * This test reads the source because the property is "no zero-check is reached
 * without first asking whether the read succeeded" — a property of the code, not
 * of one rendered snapshot.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const PAGE = join(process.cwd(), "app", "founders", "marketing", "page.tsx");
const SRC = readFileSync(PAGE, "utf8");
const LINES = SRC.split("\n");

/** Counts whose zero value is ambiguous between "none" and "unknown". */
const AMBIGUOUS = /summary\.(total|open_requests|corpus_indexed|corpus_pending)\s*===\s*0/;

/** How far back a `summary.degraded` guard may sit and still cover the check. */
const WINDOW = 6;

test("the page actually reads the summary — otherwise this suite is vacuous", () => {
  assert.ok(SRC.includes("summary.degraded"), "no degraded branch at all in the Studio page");
  const checks = LINES.filter((l) => AMBIGUOUS.test(l));
  assert.ok(
    checks.length >= 3,
    `expected several zero-checks to police, found ${checks.length} — the detector is probably broken`,
  );
});

test("every ambiguous zero-check is guarded by a degraded branch", () => {
  const unguarded: string[] = [];

  LINES.forEach((line, i) => {
    if (!AMBIGUOUS.test(line)) return;
    const before = LINES.slice(Math.max(0, i - WINDOW), i + 1).join("\n");
    if (!before.includes("summary.degraded")) {
      unguarded.push(`line ${i + 1}: ${line.trim()}`);
    }
  });

  assert.deepEqual(
    unguarded,
    [],
    "these render a zero without first asking whether the read succeeded:\n  " +
      unguarded.join("\n  ") +
      "\nA fallback zero shown as a fact is the exact failure `degraded` exists to prevent.",
  );
});

test("the track tiles do not render raw counts", () => {
  // by_track has no `=== 0` to catch, so it is checked by shape: the tiles must
  // go through the helper that substitutes an em dash on a degraded read.
  const tiles = LINES.filter((l) => l.includes("<Stat label=") && l.includes("value="));
  assert.ok(tiles.length >= 4, `expected the four track tiles, found ${tiles.length}`);
  const raw = tiles.filter((l) => /value=\{summary\.by_track\./.test(l));
  assert.deepEqual(
    raw.map((l) => l.trim()),
    [],
    "a track tile reads summary.by_track directly, so a failed read prints 0 as a measurement",
  );
});
