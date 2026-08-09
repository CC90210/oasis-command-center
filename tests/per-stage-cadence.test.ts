/**
 * tests/per-stage-cadence.test.ts — the per-lead weekly cap varies BY STAGE.
 *
 * Adon, 2026-08-06: hot stages need materially more contact than a flat
 * 2/week allows. A merchant mid-application is expecting to hear from us; a
 * lead sitting in follow-up for six weeks is not. Applying one number to both
 * either starves the hot stages or over-mails the cold ones.
 *
 * The cap is raised BY STAGE, never globally, so the extra frequency lands only
 * where engagement is likely to justify it. That distinction is what keeps the
 * complaint budget intact: at ~150 Gmail inbox deliveries/day, 0.1% is one
 * complaint per WEEK.
 */

import assert from "node:assert/strict";
import { perLeadCapForStage, emailGateReason, type EmailBudget } from "../lib/drips/drip-rules-core";

// ── Defaults come from the measured cadence matrix ─────────────────────────
assert.equal(perLeadCapForStage("uw_sheet"), 7, "live subs: hottest stage, daily in week 1");
assert.equal(perLeadCapForStage("signed_application"), 7, "signed: chasing statements, daily");
assert.equal(perLeadCapForStage("sent_application"), 7, "started an application, daily");
assert.equal(perLeadCapForStage("viewed_application"), 4, "opened the app, warm");
assert.equal(perLeadCapForStage("missing_info"), 4, "actively blocked on us");
assert.equal(perLeadCapForStage("follow_up"), 3, "general nurture");
assert.equal(perLeadCapForStage("declined"), 1, "cold, long-cycle re-engagement");
assert.equal(perLeadCapForStage("default"), 1);

// An unknown or absent stage falls back to the CONSERVATIVE default, never the
// permissive one. A stage we do not recognise is not a licence to send more.
assert.equal(perLeadCapForStage("some_new_stage"), 2, "unknown stage uses the safe default");
assert.equal(perLeadCapForStage(undefined), 2);
assert.equal(perLeadCapForStage(null), 2);
assert.equal(perLeadCapForStage(""), 2);

// Case and whitespace tolerant — stage strings are hand-entered in places.
assert.equal(perLeadCapForStage("  UW_Sheet "), 7);

// ── Env override, per stage ────────────────────────────────────────────────
{
  const saved = process.env.DRIPS_WEEKLY_CAP_FOLLOW_UP;
  process.env.DRIPS_WEEKLY_CAP_FOLLOW_UP = "5";
  assert.equal(perLeadCapForStage("follow_up"), 5, "per-stage env override wins");
  assert.equal(perLeadCapForStage("declined"), 1, "and does not leak to other stages");

  // A nonsensical override must not disable the cap.
  process.env.DRIPS_WEEKLY_CAP_FOLLOW_UP = "not-a-number";
  assert.equal(perLeadCapForStage("follow_up"), 3, "a bad override falls back to the built-in");
  process.env.DRIPS_WEEKLY_CAP_FOLLOW_UP = "0";
  assert.equal(perLeadCapForStage("follow_up"), 0, "an explicit 0 is honored — it pauses the stage");

  if (saved === undefined) delete process.env.DRIPS_WEEKLY_CAP_FOLLOW_UP;
  else process.env.DRIPS_WEEKLY_CAP_FOLLOW_UP = saved;
}

// ── The gate uses it ───────────────────────────────────────────────────────
const budget = (sent: number): EmailBudget => ({
  dailyRemaining: { sunbiz: 100, bluerise: 100 },
  hourlyRemaining: { sunbiz: 20, bluerise: 20 },
  perLeadSent7d: new Map([["lead-a", sent]]),
  perLeadCap: 2, // the legacy flat value; stage must take precedence
  degraded: false,
  perLeadDegraded: false,
});

// 3 sends this week: over the flat default, under the live-subs cap.
assert.equal(
  emailGateReason(budget(3), "lead-a", "sunbiz", "uw_sheet"),
  null,
  "a live sub at 3 sends is still under its stage cap of 7",
);
assert.equal(
  emailGateReason(budget(3), "lead-a", "sunbiz", "follow_up"),
  "per_lead_weekly_cap",
  "the same 3 sends is AT the follow-up cap of 3",
);
assert.equal(
  emailGateReason(budget(7), "lead-a", "sunbiz", "uw_sheet"),
  "per_lead_weekly_cap",
  "even the hottest stage stops at its own ceiling",
);
assert.equal(
  emailGateReason(budget(1), "lead-a", "sunbiz", "declined"),
  "per_lead_weekly_cap",
  "declined caps at 1/week",
);

// No stage supplied: falls back to the budget's flat cap, preserving the
// pre-change behaviour for any caller not yet passing a stage.
assert.equal(emailGateReason(budget(2), "lead-a", "sunbiz"), "per_lead_weekly_cap");
assert.equal(emailGateReason(budget(1), "lead-a", "sunbiz"), null);

// The opt-out and degraded guards still take precedence over any stage cap.
{
  const b = budget(0);
  b.perLeadDegraded = true;
  assert.equal(
    emailGateReason(b, "lead-a", "sunbiz", "uw_sheet"),
    "per_lead_budget_unavailable",
    "FAIL CLOSED still wins over a generous stage cap",
  );
}

console.log("per-stage-cadence.test.ts — all assertions passed ✓");
