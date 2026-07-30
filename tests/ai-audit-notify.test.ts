/**
 * The ai-audit funnel scored leads and told nobody until 2026-07-30.
 *
 * These pin the two things that make the alert worth receiving: it carries the
 * decision-driving facts (score, budget, timeline, their own words), and it
 * cannot be used to inject markup into CC's Telegram client.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAiAuditAlert, composeAiAuditWelcome } from "../lib/forms/ai-audit-format";
import { scoreAiAuditLead } from "../lib/forms/ai-audit-ingest";

const HOT = {
  name: "Dana Whitfield",
  company: "Whitfield Logistics",
  email: "dana@whitfield.co",
  phone: "+1 514 555 0134",
  website: "whitfield.co",
  automation_goal: "agent_fleet",
  bottleneck_detail:
    "Three dispatchers spend their whole morning re-keying load data between our TMS and QuickBooks.",
  tried_before: "hired",
  monthly_revenue: "250k_plus",
  team_size: "21_100",
  budget: "15k_plus",
  timeframe: "immediate",
  wants_call: "yes",
};

const COLD = {
  name: "Sam",
  email: "sam@example.com",
  automation_goal: "customer_support",
  monthly_revenue: "pre_revenue",
  team_size: "solo",
  budget: "none_yet",
  timeframe: "exploring",
  wants_call: "no",
};

test("hot lead alert leads with score and status", () => {
  const s = scoreAiAuditLead(HOT);
  const msg = buildAiAuditAlert(HOT, s);
  assert.equal(s.status, "qualified", "a max-signal lead must qualify");
  assert.match(msg.split("\n")[0], /AI Audit Lead — \d+\/100 \(qualified\)/);
  assert.ok(msg.includes("🔥"), "qualified leads need to survive a glance");
});

test("alert carries every fact CC needs to decide to call", () => {
  const msg = buildAiAuditAlert(HOT, scoreAiAuditLead(HOT));
  for (const needle of [
    "Dana Whitfield",
    "Whitfield Logistics",
    "dana@whitfield.co",
    "$15K+",            // budget, humanized — not "15k_plus"
    "IMMEDIATE",        // timeline
    "$250K+/mo",        // revenue
    "full agent fleet", // goal
    "re-keying load data", // their own words
    "ASKED TO BOOK A CALL",
  ]) {
    assert.ok(msg.includes(needle), `alert is missing "${needle}"\n---\n${msg}`);
  }
});

test("enum values are humanized, never leaked raw", () => {
  const msg = buildAiAuditAlert(HOT, scoreAiAuditLead(HOT));
  for (const raw of ["15k_plus", "250k_plus", "agent_fleet", "21_100"]) {
    assert.ok(!msg.includes(raw), `raw enum "${raw}" leaked into the alert`);
  }
});

test("cold lead is marked cold and does not shout", () => {
  const s = scoreAiAuditLead(COLD);
  const msg = buildAiAuditAlert(COLD, s);
  assert.equal(s.status, "cold");
  assert.ok(msg.includes("⚪"));
  assert.ok(!msg.includes("ASKED TO BOOK A CALL"));
});

test("user-supplied text is HTML-escaped", () => {
  // A crafted company name must not close CC's bold tag and inject markup.
  const evil = {
    ...COLD,
    name: "<b>injected</b>",
    company: "Acme</b><a href='http://evil'>click</a>",
    bottleneck_detail: "<script>alert(1)</script>",
  };
  const msg = buildAiAuditAlert(evil, scoreAiAuditLead(evil));
  assert.ok(!msg.includes("<script>"), "raw script tag survived escaping");
  assert.ok(!msg.includes("<a href="), "raw anchor survived escaping");
  assert.ok(msg.includes("&lt;"), "nothing was escaped at all");
});

test("missing optional fields never render blank rows", () => {
  const sparse = { name: "Jo", email: "jo@x.co" };
  const msg = buildAiAuditAlert(sparse, scoreAiAuditLead(sparse));
  assert.ok(!/Budget:\s*$/m.test(msg), "empty budget row rendered");
  assert.ok(!/Timeline:\s*$/m.test(msg), "empty timeline row rendered");
  assert.ok(!msg.includes("undefined"));
  assert.ok(msg.includes("Jo"));
});

// ── the lead's confirmation email ────────────────────────────────────────────

test("welcome email is deterministic — identical input, identical output", () => {
  // No model call, by design: ANTHROPIC_API_KEY is banned on this fleet and a
  // confirmation that differs per submission is a support burden.
  const a = composeAiAuditWelcome(HOT);
  const b = composeAiAuditWelcome(HOT);
  assert.deepEqual(a, b);
});

test("welcome email addresses them by first name and states the next step", () => {
  const { subject, body } = composeAiAuditWelcome(HOT);
  assert.ok(subject.includes("Dana"), subject);
  assert.ok(body.startsWith("Dana,"), body.slice(0, 40));
  assert.ok(/booking your AI audit call|asked for a call/i.test(subject + body));
  assert.ok(body.includes("— CC"));
});

test("welcome email degrades gracefully with no name", () => {
  const { subject, body } = composeAiAuditWelcome({ email: "x@y.co" });
  assert.ok(subject.includes("there"), subject);
  assert.ok(!subject.includes("undefined"));
  assert.ok(!body.includes("undefined"));
});

test("a no-call lead gets a different next step than a call-requester", () => {
  const called = composeAiAuditWelcome(HOT).body;
  const quiet = composeAiAuditWelcome(COLD).body;
  assert.notEqual(called, quiet, "the email ignores what they actually asked for");
});
