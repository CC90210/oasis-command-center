/**
 * restricted-state-preview-visible.test.ts — the restriction must reach the
 * OPERATOR, not merely the API response.
 *
 * WHY THIS EXISTS SEPARATELY FROM restricted-states.test.ts. The first pass of
 * the preview-gate fix made scoreLenderMatch raise `restricted_state` on the
 * match-lenders route, and that was still useless: ApplicationCardActions.tsx,
 * the sole consumer of that route, types the response as
 * { score, passes, checks } and renders `checks` plus a passes/total badge. A
 * restriction carried only in `warnings` is computed, returned, and invisible —
 * the operator sees a clean row and an enabled Shop out button. Codex
 * adversarial review 2026-09-07 caught it; "the gate fires" and "a human can see
 * that it fired" are different claims and this file pins the second one.
 *
 * Static assertions over source. The route is a Next.js handler that needs the
 * full server runtime plus a live DB to execute, so a behavioural test here
 * would be testing mocks. What must not regress is structural.
 *
 *   node --experimental-strip-types tests/restricted-state-preview-visible.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE = resolve(HERE, "../app/api/applications/[id]/match-lenders/route.ts");
const CONSUMER = resolve(HERE, "../components/manifest/ApplicationCardActions.tsx");

const route = readFileSync(ROUTE, "utf8");
const consumer = readFileSync(CONSUMER, "utf8");

// ── The restriction is pushed as a CHECK, which is what the UI renders ──────
assert.ok(
  /key:\s*"restricted_state"/.test(route),
  "the route must push a `restricted_state` entry into `checks`; a warning alone " +
    "never reaches the operator",
);
assert.ok(
  /key:\s*"restricted_industry"/.test(route),
  "the route must push a `restricted_industry` check for the same reason",
);

// ── The consumer still renders checks (if this changes, the above is moot) ──
assert.ok(
  /checks\s*:\s*CheckResult\[\]/.test(consumer),
  "ApplicationCardActions must still type `checks`; if the contract moved, the " +
    "restricted-state check has to move with it",
);
assert.ok(
  /\.checks\.map\(/.test(consumer),
  "ApplicationCardActions must still render the checks list",
);

// ── An unknown merchant state must FAIL the check, never pass quietly ───────
{
  const block = route.slice(route.indexOf('key: "restricted_state"'));
  const passedLine = block.slice(0, block.indexOf("});"));
  assert.ok(
    /passed:\s*merchantState\s*\?/.test(passedLine),
    "the restricted_state check must be conditional on a known merchant state",
  );
  assert.ok(
    /:\s*false/.test(passedLine),
    "an unknown merchant state must FAIL the check — a lender with a restricted " +
      "list and no state on file is not something to wave through",
  );
}

// ── Preview and send must read the SAME keys, including the legacy one ──────
assert.ok(
  /industry_restrictions/.test(route),
  "the preview must honour the legacy `industry_restrictions` key, as " +
    "lib/lenders/shop-out.ts does; reading only the new name shows a legacy " +
    "lender as clean in the preview and then flags it on the live send",
);

// ── The lender profile handed to scoreLenderMatch carries the lists ─────────
assert.ok(
  /restricted_states:\s*Array\.isArray\(raw\?\.restricted_states\)/.test(route),
  "the LenderProfile built for scoreLenderMatch must carry restricted_states, " +
    "or the narrative/bias layer scores a lender it should have flagged",
);

console.log("restricted-state-preview-visible.test.ts — all assertions passed");
