import assert from "node:assert/strict";
import {
  consumeEmail,
  emailGateReason,
  holdUntilIso,
  isPaused,
  isReEntryEligible,
  type EmailBudget,
} from "../lib/drips/drip-rules-core";

/**
 * Regression guard for the 2026-07-29 drip engine repair.
 *
 * Three production defects are pinned here. Each assertion below fails against
 * the pre-fix code, which is the only reason to keep it.
 *
 *   E1  A lead could enter a sequence once per lifetime. Re-entering the trigger
 *       stage never re-dripped, which is why follow-ups appeared dead.
 *   E5  /api/leads/[id]/drip-toggle wrote `drip_paused` and NOTHING read it, so
 *       pausing a lead did nothing and the drip kept sending.
 *   D4  There was no per-recipient email cap. Only a global ~30/hour system
 *       ceiling existed, which says nothing about what one human receives.
 */

const DAY = 24 * 3_600_000;
const NOW = 1_800_000_000_000; // fixed clock; these are pure functions
const COOLDOWN = 14 * DAY;

// ── E1: the stage-entry edge ────────────────────────────────────────────────

assert.equal(
  isReEntryEligible({
    lastRunAtMs: NOW - 30 * DAY,
    stageEnteredAt: new Date(NOW - 1 * DAY).toISOString(),
    nowMs: NOW,
    cooldownMs: COOLDOWN,
  }),
  true,
  "THE REPORTED BUG: re-entering the stage after the cooldown must re-drip",
);

assert.equal(
  isReEntryEligible({
    lastRunAtMs: NOW - 30 * DAY,
    stageEnteredAt: new Date(NOW - 40 * DAY).toISOString(),
    nowMs: NOW,
    cooldownMs: COOLDOWN,
  }),
  false,
  "a lead SITTING in the stage since before its run is not a re-entry",
);

assert.equal(
  isReEntryEligible({
    lastRunAtMs: NOW - 2 * DAY,
    stageEnteredAt: new Date(NOW - 1 * DAY).toISOString(),
    nowMs: NOW,
    cooldownMs: COOLDOWN,
  }),
  false,
  "re-entry inside the cooldown is suppressed (stage ping-pong cannot re-drip)",
);

assert.equal(
  isReEntryEligible({
    lastRunAtMs: NOW - 30 * DAY,
    stageEnteredAt: undefined,
    nowMs: NOW,
    cooldownMs: COOLDOWN,
  }),
  false,
  "SAFETY: no stage_entered_at is NOT a re-entry — must not re-drip the back catalogue on deploy",
);

assert.equal(
  isReEntryEligible({
    lastRunAtMs: NOW - 30 * DAY,
    stageEnteredAt: "not-a-date",
    nowMs: NOW,
    cooldownMs: COOLDOWN,
  }),
  false,
  "an unparseable stage_entered_at is NOT a re-entry",
);

// ── E5: the pause toggle ────────────────────────────────────────────────────

assert.equal(isPaused({ drip_paused: true }), true, "THE REPORTED BUG: boolean pause must be honored");
assert.equal(isPaused({ drip_paused: "true" }), true, "string 'true' from JSONB must be honored");
assert.equal(isPaused({ drip_paused: false }), false, "explicitly unpaused sends");
assert.equal(isPaused({}), false, "absent flag is not paused");

// ── D4: per-recipient and global email caps ─────────────────────────────────

function budget(over: Partial<EmailBudget> = {}): EmailBudget {
  return {
    dailyRemaining: 100,
    hourlyRemaining: 20,
    perLeadSent7d: new Map(),
    perLeadCap: 2,
    degraded: false,
    perLeadDegraded: false,
    ...over,
  };
}

assert.equal(emailGateReason(budget(), "lead-a"), null, "a fresh lead under every cap sends");

assert.equal(
  emailGateReason(budget({ perLeadSent7d: new Map([["lead-a", 2]]) }), "lead-a"),
  "per_lead_weekly_cap",
  "THE REPORTED BUG: a lead at its weekly cap must be held, not sent again",
);
assert.equal(
  emailGateReason(budget({ perLeadSent7d: new Map([["lead-a", 2]]) }), "lead-b"),
  null,
  "one lead hitting its cap must not block a different lead",
);

assert.equal(emailGateReason(budget({ dailyRemaining: 0 }), "lead-a"), "daily_cap", "daily cap holds");
assert.equal(emailGateReason(budget({ hourlyRemaining: 0 }), "lead-a"), "hourly_cap", "hourly cap holds");

// Fail-closed: an unreadable per-lead count must HOLD, never send. This is the
// deliberate 2026-07-29 change from the original governor, which returned full
// budget on a read error and so re-opened the exact hole the cap closes.
assert.equal(
  emailGateReason(budget({ perLeadDegraded: true }), "lead-a"),
  "per_lead_budget_unavailable",
  "FAIL CLOSED: cannot prove this recipient's volume, so hold",
);
assert.equal(
  emailGateReason(budget({ degraded: true }), "lead-a"),
  null,
  "a GLOBAL count failure fails soft — only the per-lead check is load-bearing enough to stall on",
);

// consumeEmail decrements all three dimensions so later rows in the same run
// see the spend without re-querying.
{
  const b = budget();
  consumeEmail(b, "lead-a");
  assert.equal(b.dailyRemaining, 99, "daily decremented");
  assert.equal(b.hourlyRemaining, 19, "hourly decremented");
  assert.equal(b.perLeadSent7d.get("lead-a"), 1, "per-lead recorded");
  consumeEmail(b, "lead-a");
  assert.equal(
    emailGateReason(b, "lead-a"),
    "per_lead_weekly_cap",
    "two sends in one run trip the per-lead cap without a re-query",
  );
}

// Hold windows: a per-lead hold must be long enough that 2/week is real, and a
// transient budget failure must retry soon rather than park for days.
{
  const perLead = new Date(holdUntilIso("per_lead_weekly_cap")).getTime() - Date.now();
  assert.ok(perLead > 2 * DAY, "per-lead hold spaces sends by ~3 days");
  const unavailable = new Date(holdUntilIso("per_lead_budget_unavailable")).getTime() - Date.now();
  assert.ok(unavailable <= 3_600_000 + 5_000, "an unavailable budget retries within the hour");
}

console.log("drip-engine-repair.test.ts — all assertions passed ✓");
