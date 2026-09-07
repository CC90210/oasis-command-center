/**
 * A manager who also carries a book gets their own chip, pinned and marked.
 *
 * WHY THIS EXISTS
 * The operator, about a sales manager who also closes his own deals: "when they
 * click on their specific section, like Yaacov, they can see only their leads so
 * they can focus on only his."
 *
 * The filter already worked — a screenshot shows his chip selected and the board
 * correctly reading "2 shown / 2 matches". What did not work was FINDING it: his
 * name sat in a row of ten colleagues, in the same weight as everyone else's, so
 * "just show me mine" was a visual search rather than a click.
 *
 * Two things this deliberately does NOT do:
 *
 *   1. It does not put counts on the chips. That existed and was removed on
 *      purpose — the counts came from the current row slice, so they looked
 *      exact while omitting old deals. The page.tsx comment records it. A
 *      confident wrong number is worse than no number.
 *   2. It does not render the viewer twice. The pinned chip IS their name chip,
 *      carrying the roster's own key, so the filter it produces is identical to
 *      the one it replaces.
 *
 * THE TRAP THIS GUARDS
 * The two roster paths key differently. managerRepRoster lowercases
 * auth_user_id; buildMemberNameMap — the admin path, lib/assigned-names.ts:34 —
 * stores it raw. Matching on either spelling alone renders the chip for one
 * audience and silently never renders it for the other. A control that is simply
 * absent gives nobody anything to report, so this asserts the comparison stays
 * case-insensitive.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync("app/pipeline/page.tsx", "utf8");
const names = readFileSync("lib/assigned-names.ts", "utf8");

// ── 1. the two rosters really do key differently ───────────────────────────
// If this ever stops being true the case-insensitive match becomes belt-and-
// braces rather than load-bearing, and the reader should know which it is.

assert.match(
  page,
  /auth_user_id!\.trim\(\)\.toLowerCase\(\)/,
  "the manager roster is expected to lowercase auth_user_id",
);
assert.match(
  names,
  /map\.set\(m\.auth_user_id, name\)/,
  "buildMemberNameMap is expected to store auth_user_id RAW — this asymmetry is why the lookup below must be case-insensitive",
);

// ── 2. the viewer lookup tolerates both spellings ──────────────────────────

assert.match(
  page,
  /id\.trim\(\)\.toLowerCase\(\) === viewerId\.toLowerCase\(\)/,
  "the viewer's own chip must be matched case-insensitively, or it renders for admins or for managers but never both",
);

// ── 3. pinned, marked, and not duplicated ──────────────────────────────────

assert.match(
  page,
  /\{viewerRepEntry && repChip\(`\$\{viewerRepEntry\[1\]\} \(you\)`, viewerRepEntry\[0\]\)\}/,
  "the viewer's chip must be pinned and marked '(you)'",
);
assert.match(
  page,
  /\.filter\(\(\[id\]\) => id !== viewerRepEntry\?\.\[0\]\)/,
  "the viewer must not also appear in the unpinned list — two chips, one filter",
);

// It carries the ROSTER's key, not the session's spelling, so the filter it
// sends is byte-identical to the chip it replaces.
const pinned = page.slice(page.indexOf("{repChip(\"Everyone\", null)}"));
assert(
  pinned.indexOf("viewerRepEntry[0]") < pinned.indexOf("repRoster.entries()"),
  "the viewer's chip must be rendered BEFORE the rest of the roster",
);
assert(
  !/repChip\(`\$\{viewerRepEntry\[1\]\} \(you\)`,\s*viewerId\)/.test(page),
  "the chip must send the roster's key, not the raw session id, or an admin's chip filters on a different spelling than everyone else's",
);

// ── 4. counts stay off the chips ───────────────────────────────────────────

assert.match(
  page,
  /Counts on the old rep chips came from the current row slice/,
  "the reason counts are absent must stay recorded next to the chips, or someone re-adds them",
);

console.log("pipeline-own-book-chip: OK");
