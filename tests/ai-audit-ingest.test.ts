/**
 * ai-audit-ingest.test.ts — the qualification rubric for the B2B funnel.
 *
 * The score decides whether CC's day gets interrupted, so the rubric is pure
 * and pinned here rather than left to a model call: an identical submission
 * must always produce an identical score, and CC must be able to read why.
 *
 * Run: npx tsx tests/ai-audit-ingest.test.ts
 */
import assert from "node:assert/strict";

import {
  scoreAiAuditLead,
  summarizeAiAuditLead,
  type AiAuditAnswers,
} from "../lib/forms/ai-audit-ingest";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// ── Realistic submissions ────────────────────────────────────────────────────

const DREAM: AiAuditAnswers = {
  name: "Dana Reyes", email: "dana@acmehvac.com", company: "Acme HVAC",
  automation_goal: "agent_fleet",
  bottleneck_detail: "Leads sit in the shared inbox for two days because nobody owns follow-up, and we lose maybe six jobs a month to slower response.",
  tried_before: "hired",
  monthly_revenue: "250k_plus", team_size: "21_100", budget: "15k_plus",
  timeframe: "immediate", wants_call: "yes",
};

const TIRE_KICKER: AiAuditAnswers = {
  name: "Sam Lee", email: "sam@idea.io", company: "Idea Labs",
  automation_goal: "customer_support",
  tried_before: "never",
  monthly_revenue: "pre_revenue", team_size: "solo", budget: "none_yet",
  timeframe: "exploring", wants_call: "audit_first",
};

const MIDDLE: AiAuditAnswers = {
  name: "Jo Patel", email: "jo@brightclinic.com", company: "Bright Clinic",
  automation_goal: "sales_leadgen",
  bottleneck_detail: "Front desk is drowning.",
  tried_before: "tools",
  monthly_revenue: "50k_250k", team_size: "6_20", budget: "2k_5k",
  timeframe: "30_days", wants_call: "audit_first",
};

console.log("ai-audit scoring rubric");

test("score is always within 0..100", () => {
  for (const a of [DREAM, TIRE_KICKER, MIDDLE, {}]) {
    const s = scoreAiAuditLead(a);
    assert.ok(s.score >= 0 && s.score <= 100, `out of range: ${s.score}`);
  }
});

test("deterministic — identical input, identical score", () => {
  assert.equal(scoreAiAuditLead(DREAM).score, scoreAiAuditLead(DREAM).score);
  assert.equal(scoreAiAuditLead(MIDDLE).score, scoreAiAuditLead(MIDDLE).score);
});

test("ranks dream > middle > tire-kicker", () => {
  const d = scoreAiAuditLead(DREAM).score;
  const m = scoreAiAuditLead(MIDDLE).score;
  const t = scoreAiAuditLead(TIRE_KICKER).score;
  assert.ok(d > m, `dream ${d} !> middle ${m}`);
  assert.ok(m > t, `middle ${m} !> tire-kicker ${t}`);
});

test("only money AND urgency together earn 'qualified'", () => {
  assert.equal(scoreAiAuditLead(DREAM).status, "qualified");

  // Rich but no urgency — must NOT interrupt CC.
  const richNoRush = { ...DREAM, timeframe: "exploring", wants_call: "audit_first" };
  assert.notEqual(scoreAiAuditLead(richNoRush).status, "qualified");

  // Urgent but broke — also not qualified.
  const urgentBroke = {
    ...TIRE_KICKER, timeframe: "immediate", automation_goal: "agent_fleet",
  };
  assert.notEqual(scoreAiAuditLead(urgentBroke).status, "qualified");
});

test("tire-kicker lands cold and says why", () => {
  const s = scoreAiAuditLead(TIRE_KICKER);
  assert.equal(s.status, "cold");
  assert.ok(
    s.reasons.some((r) => r.includes("nurture")),
    `expected a nurture reason, got ${JSON.stringify(s.reasons)}`,
  );
});

test("a prospect burned by a previous vendor scores ABOVE one who never tried", () => {
  const burned = { ...MIDDLE, tried_before: "hired" };
  const naive = { ...MIDDLE, tried_before: "never" };
  assert.ok(scoreAiAuditLead(burned).score > scoreAiAuditLead(naive).score);
});

test("writing out the bottleneck in their own words earns engagement points", () => {
  const withDetail = { ...MIDDLE, bottleneck_detail: "x".repeat(60) };
  const without = { ...MIDDLE, bottleneck_detail: "" };
  assert.ok(scoreAiAuditLead(withDetail).score > scoreAiAuditLead(without).score);
});

test("empty submission does not throw and is cold", () => {
  const s = scoreAiAuditLead({});
  assert.equal(s.status, "cold");
  assert.equal(s.score, 0);
});

test("unknown option values are ignored, not counted", () => {
  const junk = { ...MIDDLE, monthly_revenue: "not_a_real_band", budget: "???" };
  const s = scoreAiAuditLead(junk);
  assert.ok(s.score < scoreAiAuditLead(MIDDLE).score);
  assert.ok(s.score >= 0);
});

test("reasons are human-readable and non-empty for a strong lead", () => {
  const s = scoreAiAuditLead(DREAM);
  assert.ok(s.reasons.length >= 3, JSON.stringify(s.reasons));
  assert.ok(s.reasons.every((r) => r.length > 8));
});

test("summary carries company, goal and score", () => {
  const s = scoreAiAuditLead(DREAM);
  const line = summarizeAiAuditLead(DREAM, s);
  assert.ok(line.includes("Acme HVAC"));
  assert.ok(line.includes(`${s.score}/100`));
  assert.ok(line.includes("qualified"));
});

test("score parts sum to the score (no hidden weighting)", () => {
  // Run on EVERY fixture, not just the mid-tier one. The original version
  // tested MIDDLE alone, so the clamp never fired and a rubric that summed to
  // 115 passed — every strong lead saturated at 100 and top-end ranking was
  // meaningless. The E2E run caught it; this now would.
  for (const a of [DREAM, MIDDLE, TIRE_KICKER]) {
    const s = scoreAiAuditLead(a);
    const sum = Object.values(s.parts).reduce((x, y) => x + y, 0);
    assert.equal(sum, s.score, `parts ${sum} != score ${s.score}`);
  }
});

test("a maximal submission tops out at exactly 100 without clamping", () => {
  const maxed: AiAuditAnswers = {
    ...DREAM, monthly_revenue: "250k_plus", team_size: "100_plus",
    budget: "15k_plus", timeframe: "immediate", automation_goal: "agent_fleet",
    tried_before: "hired", wants_call: "yes",
    bottleneck_detail: "x".repeat(80),
  };
  assert.equal(scoreAiAuditLead(maxed).score, 100);
});

test("strong-but-not-perfect leads stay BELOW 100 (ranking survives at the top)", () => {
  const strongNoCall = { ...DREAM, wants_call: "audit_first" };
  const strongSmallTeam = { ...DREAM, team_size: "2_5" };
  for (const a of [strongNoCall, strongSmallTeam]) {
    const s = scoreAiAuditLead(a).score;
    assert.ok(s < 100, `expected < 100, got ${s} — top end is saturating again`);
    assert.ok(s >= 65, `expected still qualified-grade, got ${s}`);
  }
});

console.log(`\n${passed} passed`);
