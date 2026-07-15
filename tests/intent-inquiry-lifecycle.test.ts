/**
 * intent-inquiry-lifecycle.test.ts — the form-driven stage-transition decision:
 * the forward-only guard + the ghost/declined reactivation policy (CC decision
 * 2026-06-18). Pure-logic test of lib/forms/stage-transition.isFormStageDowngrade.
 */
import {
  isFormStageDowngrade,
  REACTIVATABLE_TERMINAL_STAGES,
  HARD_TERMINAL_STAGES,
} from "../lib/forms/stage-transition";
import { LEAD_PIPELINE_STAGES } from "../lib/sunbiz-stage-meta";

const order = LEAD_PIPELINE_STAGES.map((s) => s.key);
let failures = 0;
function check(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failures += 1;
  }
}

// 2026-07-15 (Adon): "imported" is the new first lead stage (intent_inquiry
// removed). Form OPEN now writes viewed_application; this file still tests the
// pure downgrade/reactivation guard in lib/forms/stage-transition.
const ENTRY = "imported";

// Sanity: the new entry stage exists + is first.
check(order[0] === ENTRY, "imported is the first lead stage");

// New lead (no current stage) → apply (land at entry).
check(isFormStageDowngrade(null, ENTRY, order) === false, "new lead applies entry stage");

// Active, more-advanced lead re-submitting the interest form → DOWNGRADE (skip,
// preserve their progress). This is the Codex HIGH the guard fixed.
check(isFormStageDowngrade("sent_application", ENTRY, order) === true, "active lead not downgraded");
check(isFormStageDowngrade("follow_up", ENTRY, order) === true, "follow_up not downgraded to entry");
check(isFormStageDowngrade("funded", ENTRY, order) === true, "funded (advanced/unknown) preserved");

// 2026-07-15: ghost + declined left the lead board and REACTIVATABLE_TERMINAL is
// now empty. A stage no longer in the funnel fails closed (preserve), never
// silently resurfaces.
check(REACTIVATABLE_TERMINAL_STAGES.size === 0, "no reactivatable-terminal lead stages");
check(isFormStageDowngrade("ghost", ENTRY, order) === true, "removed ghost stage preserved (fail closed)");
check(isFormStageDowngrade("declined", ENTRY, order) === true, "removed declined stage preserved (fail closed)");

// Hard terminal: default/opted_out → never auto-changed (preserve).
check(isFormStageDowngrade("default", ENTRY, order) === true, "default preserved");
check(isFormStageDowngrade("opted_out", ENTRY, order) === true, "opted_out preserved (CASL)");

// Unknown / legacy current stage (not in the funnel) → FAIL CLOSED: preserve,
// don't overwrite a value we can't classify. (Codex audit 2026-06-18 [high].)
check(isFormStageDowngrade("some_custom_stage", "sent_application", order) === true, "unknown stage never overwritten");

// Forward move on an active lead → apply.
check(isFormStageDowngrade(ENTRY, "sent_application", order) === false, "forward move applies");
check(isFormStageDowngrade("sent_application", "signed_application", order) === false, "forward app step applies");

// Equal stage → not a downgrade (idempotent re-submit still writes the same value).
check(isFormStageDowngrade(ENTRY, ENTRY, order) === false, "equal stage is not a downgrade");

// Policy sets are disjoint + correct.
check([...REACTIVATABLE_TERMINAL_STAGES].every((s) => !HARD_TERMINAL_STAGES.has(s)), "terminal sets disjoint");
check(HARD_TERMINAL_STAGES.has("opted_out") && HARD_TERMINAL_STAGES.has("default"), "hard terminal = default+opted_out");

if (failures > 0) {
  console.error(`stage-transition-lifecycle: ${failures} failure(s)`);
  process.exit(1);
}
console.log("stage-transition-lifecycle ok");
