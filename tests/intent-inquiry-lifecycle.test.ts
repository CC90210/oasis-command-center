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

const ENTRY = "intent_inquiry_submitted";

// Sanity: the new entry stage exists + is first.
check(order[0] === ENTRY, "intent_inquiry_submitted is the first lead stage");

// New lead (no current stage) → apply (land at entry).
check(isFormStageDowngrade(null, ENTRY, order) === false, "new lead applies entry stage");

// Active, more-advanced lead re-submitting the interest form → DOWNGRADE (skip,
// preserve their progress). This is the Codex HIGH the guard fixed.
check(isFormStageDowngrade("sent_application", ENTRY, order) === true, "active lead not downgraded");
check(isFormStageDowngrade("hot_lead", ENTRY, order) === true, "hot_lead not downgraded");
check(isFormStageDowngrade("funded", ENTRY, order) === true, "funded not downgraded");

// Reactivatable terminal: ghost/declined re-engaging → APPLY (resurface).
check(isFormStageDowngrade("ghost", ENTRY, order) === false, "ghost reactivates to entry");
check(isFormStageDowngrade("declined", ENTRY, order) === false, "declined reactivates to entry");
// ...even via a later form (full app) → apply that target, not skip.
check(isFormStageDowngrade("ghost", "sent_application", order) === false, "ghost reactivates via full app");

// Hard terminal: default/opted_out → never auto-changed (preserve).
check(isFormStageDowngrade("default", ENTRY, order) === true, "default preserved");
check(isFormStageDowngrade("opted_out", ENTRY, order) === true, "opted_out preserved (CASL)");

// Unknown / legacy current stage (not in the funnel) → FAIL CLOSED: preserve,
// don't overwrite a value we can't classify. (Codex audit 2026-06-18 [high].)
check(isFormStageDowngrade("imported", ENTRY, order) === true, "unknown/legacy stage preserved");
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
  console.error(`intent-inquiry-lifecycle: ${failures} failure(s)`);
  process.exit(1);
}
console.log("intent-inquiry-lifecycle ok (17 cases)");
