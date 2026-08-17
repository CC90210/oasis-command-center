/**
 * Every paged read must ORDER BY a unique key before it RANGEs.
 *
 * `.range(from, to)` on an unordered query has no defined row order. Page 2 may
 * repeat rows from page 1 and skip others, silently, in either direction. The
 * caller sees a plausible result set and a count that is simply wrong.
 *
 * This repo has now hit that bug three separate times:
 *   - getMarketingSummary paged without .order() — the loop was copied from the
 *     brands reader and the line was dropped. CodeRabbit caught it.
 *   - getMarketingFacets ordered by `brand_name`, which 43 rows share, so the
 *     page boundary was arbitrary. NOT unique is the same defect as not ordered.
 *   - collect-outreach-intel's buildStageMap paged `tenant_records` unordered
 *     across 1,266 lead + 1,096 application rows — genuinely more than one page,
 *     so leads were droppable from the stage map on an hourly cron.
 *   - drips/governor counted a daily send ceiling from unordered pages, where an
 *     undercount lets MORE mail out than the cap allows.
 *
 * Three of those were found by review rather than by a test, which is why this
 * exists: the fix is one line and the failure is invisible, so the only reliable
 * defence is refusing to let a new one land.
 *
 * Run: npx tsx tests/paged-reads-ordered.test.ts
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN = ["lib", "app"];
/** How far back an `.order()` may sit and still plausibly govern this `.range()`. */
const WINDOW = 30;

/**
 * Call sites reviewed by hand and found safe, each with the reason.
 *
 * An allowlist rather than a cleverer parser: these builders are assembled across
 * many lines and conditionals, so any regex smart enough to follow them would be
 * wrong in its own quiet way. A short list a human has read beats a heuristic
 * nobody trusts — and adding to it requires writing down why.
 */
const REVIEWED: Record<string, string> = {
  "lib/manifest/data.ts":
    "single page per request (offset+limit come from the caller's pagination UI), " +
    "and the sort is applied to the same builder further up from a user-chosen column",
  "lib/lead-interactions-queries.ts":
    "ordered by created_at on the same builder above; one page per request, not a full-table walk",
  "app/api/manifest/[slug]/cold-outreach/campaigns/[campaign_id]/recipients/route.ts":
    "one page per request for a paginated table view, ordered on the same builder above",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const offenders: string[] = [];

for (const base of SCAN) {
  for (const file of walk(join(ROOT, base))) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      // The call, not prose about it — skip comment lines so this file's own
      // docstrings and the explanatory comments at each fixed site do not trip it.
      if (!/\.range\s*\(/.test(line)) return;
      const trimmed = line.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;
      if (REVIEWED[rel]) return;
      const before = lines.slice(Math.max(0, i - WINDOW), i + 1).join("\n");
      if (!/\.order\s*\(/.test(before)) {
        offenders.push(`${rel}:${i + 1}  ${trimmed}`);
      }
    });
  }
}

assert.deepEqual(
  offenders,
  [],
  "these page with .range() but never .order() — page 2 can repeat or skip rows " +
    "from page 1, silently:\n  " +
    offenders.join("\n  ") +
    "\n\nAdd `.order(\"id\", { ascending: true })` before the .range(). Order by a " +
    "UNIQUE column — a non-unique one (brand_name, created_at with ties) leaves the " +
    "page boundary arbitrary and is the same bug. If the read is genuinely one page " +
    "per request and cannot walk a table, add it to REVIEWED with the reason.",
);

// The scan has to actually be looking at something. Without this a broken walk()
// or a bad regex would report zero offenders and read as a clean bill of health —
// the same false-comfort failure the assertions above exist to prevent.
const scanned = SCAN.flatMap((b) => walk(join(ROOT, b))).length;
assert.ok(scanned > 100, `expected to scan the codebase, only saw ${scanned} files`);

const rangeSites = SCAN.flatMap((b) => walk(join(ROOT, b))).filter((f) =>
  /\.range\s*\(/.test(readFileSync(f, "utf8")),
).length;
assert.ok(
  rangeSites >= 5,
  `expected to find paged reads to police, found ${rangeSites} — the detector is probably broken`,
);

console.log(`paged-reads-ordered: ${scanned} files scanned, ${rangeSites} paged readers, all ordered`);
