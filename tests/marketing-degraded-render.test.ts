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

test("no metric tile renders a raw count", () => {
  // by_track / facets.brands have no `=== 0` to catch, so this is checked by
  // shape: every tile must go through a helper that substitutes an em dash on a
  // degraded read.
  //
  // THIS USED TO ASSERT `tiles.length >= 4`, counting the four hardcoded track
  // tiles. That is a proxy for the property, not the property, and it broke the
  // moment the tiles became a .map() over BRAND_GROUPS on 2026-08-16 — one
  // source line, four rendered tiles. A count-based guard fails on a refactor
  // that preserves the property and, worse, would have PASSED a refactor to six
  // hardcoded tiles that read the counts raw. So it now asserts the real thing:
  // no tile may name a count source directly.
  const tiles = LINES.filter((l) => l.includes("<Stat ") && l.includes("value="));
  assert.ok(tiles.length >= 1, `expected metric tiles on the Studio page, found ${tiles.length}`);

  // Every source of a count that could be zero-because-broken rather than
  // zero-because-empty. Reading one of these straight into `value=` is the bug.
  const RAW_SOURCE = /value=\{\s*(summary\.by_track|summary\.by_status|summary\.total|facets\.brands)/;
  const raw = tiles.filter((l) => RAW_SOURCE.test(l));
  assert.deepEqual(
    raw.map((l) => l.trim()),
    [],
    "a tile reads a count source directly, so a failed read prints 0 as a measurement",
  );

  // …and the helpers they DO go through must actually have a degraded branch.
  // Without this, renaming the raw read to `const brandCount = () => facets...`
  // would satisfy the check above while changing nothing.
  // THE PIPELINE TILES ARE METRIC TILES TOO. They render `by_status` into plain
  // <div>s, so every `<Stat>`-shaped check above walked straight past them —
  // and they carried the exact defect this file exists to prevent, in the one
  // section that does not use the component the detector keys on. A guard with a
  // hole reads as coverage. Found by an adversarial audit, not by this suite,
  // which is the whole reason the assertion is now about the DATA SOURCE rather
  // than the component name.
  // THE LINCHPIN. `pipelineTotal` is the aggregate the whole section is gated on,
  // so its own degraded-guard is what protects every per-stage read inside it. If
  // this one line loses its guard, the section renders on a partial summary and
  // the per-tile reads below become fabricated zeros again — which is exactly the
  // state this was found in.
  const totalLine = LINES.findIndex((l) => /const pipelineTotal\s*=/.test(l));
  assert.ok(totalLine >= 0, "expected a pipelineTotal aggregate on the Studio page");
  assert.ok(
    /summary\.degraded/.test(LINES.slice(totalLine, totalLine + WINDOW).join("\n")),
    "pipelineTotal must consult summary.degraded — it is the gate that keeps the " +
      "pipeline section off the screen when the counts behind it are a floor rather " +
      "than a total",
  );
  const sectionGate = LINES.findIndex((l) => /pipelineTotal > 0 &&/.test(l));
  assert.ok(sectionGate > totalLine, "the pipeline section must render only when pipelineTotal > 0");

  // Now every by_status read must be covered by EITHER a nearby degraded check or
  // that section gate. Reads before the gate have no section protecting them.
  const statusReads = LINES
    .map((l, i) => [l, i] as const)
    .filter(([l, i]) => /summary\.by_status\[/.test(l) && i !== totalLine);
  assert.ok(statusReads.length >= 1, "expected the pipeline to read by_status");
  for (const [line, i] of statusReads) {
    const nearby = LINES.slice(Math.max(0, i - WINDOW), i + 1).join("\n");
    const insideGatedSection = i > sectionGate;
    assert.ok(
      /summary\.degraded/.test(nearby) || insideGatedSection,
      `line ${i + 1} turns by_status into a rendered number without first asking ` +
        `whether the read succeeded, and sits outside the gated pipeline section:\n  ${line.trim()}\n` +
        `A partial summary keeps the pages it DID read, so "Approved 0" here can ` +
        `mean "the page carrying the approved assets failed to load".`,
    );
  }

  for (const helper of ["trackCount", "brandCount"]) {
    const declared = LINES.findIndex((l) => new RegExp(`const ${helper}\\s*=`).test(l));
    assert.ok(declared >= 0, `${helper} must exist — a tile references it`);
    const body = LINES.slice(declared, declared + 10).join("\n");
    assert.ok(
      /degraded/.test(body),
      `${helper} must ask whether the read succeeded before returning a number; ` +
        `otherwise the em dash it exists to render never appears`,
    );
  }
});
