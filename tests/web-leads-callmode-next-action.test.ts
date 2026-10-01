/**
 * Call Mode must send a callback date for every outcome that keeps a lead open.
 *
 * #488 (2026-09-30) made the outcome route REQUIRE a future nextActionAt for
 * no_answer, connected and interested. Call Mode kept posting
 * { outcome, note, requestId }, so keys 1-3 returned 400 next_action_required
 * on every press. This runs the client's body builder through the SERVER's
 * validator, so the two can never disagree again.
 *
 * Run: node --conditions=react-server --import tsx tests/web-leads-callmode-next-action.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CALL_OUTCOMES, validateNextAction } from "../lib/web-leads/outcome";
import {
  DEFAULT_NEXT_ACTION_PRESET,
  NEXT_ACTION_PRESETS,
  nextActionForOutcome,
} from "../lib/web-leads/next-action-presets";

const NOW = Date.parse("2026-10-05T14:00:00.000Z");

for (const outcome of CALL_OUTCOMES) {
  for (const preset of [...NEXT_ACTION_PRESETS.map((p) => p.key), "not-a-preset"]) {
    const at = nextActionForOutcome(outcome, preset, new Date(NOW));
    const verdict = validateNextAction(outcome, at, NOW);
    assert.equal(
      verdict.ok,
      true,
      `${outcome} with preset ${preset} produced ${String(at)}, which the outcome route rejects: ${JSON.stringify(verdict)}`,
    );
  }
}
assert.equal(DEFAULT_NEXT_ACTION_PRESET, "3d");

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const callMode = strip(readFileSync("components/web-leads/CallMode.tsx", "utf8"));
assert.match(callMode, /nextActionForOutcome\(/, "Call Mode must compute the callback with the shared helper");
assert.match(
  callMode,
  /JSON\.stringify\(\{[^}]*\bnextActionAt\b[^}]*\}\)/,
  "Call Mode's outcome POST body must carry nextActionAt",
);
// A retry must resend the first attempt's date. The call-history row keeps the
// first date while the lead takes the latest request's, so a recomputed date on
// retry splits the two (review finding on #518, Claude + CodeRabbit).
assert.match(
  callMode,
  /submissionRef\.current = \{ signature, requestId, nextActionAt \}/,
  "Call Mode must remember the date it sent alongside the requestId",
);
assert.match(
  callMode,
  /\? prior\.nextActionAt\s*:/,
  "a retry under the same requestId must reuse the first attempt's date while it is still in the future",
);
assert.match(
  callMode,
  /t\.tagName === "SELECT"/,
  "Call Mode's typing guard must include SELECT, or a focused dropdown logs an outcome",
);

const log = strip(readFileSync("components/web-leads/CallOutcomeLog.tsx", "utf8"));
assert.doesNotMatch(log, /const NEXT_ACTION_PRESETS\s*=/, "CallOutcomeLog must import the presets, not keep a second copy");

console.log("web-leads-callmode-next-action: OK");
