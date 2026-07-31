/**
 * The ai-audit funnel scored leads and told nobody until 2026-07-30.
 *
 * These pin the two things that make the alert worth receiving: it carries the
 * decision-driving facts (score, budget, timeline, their own words), and it
 * cannot be used to inject markup into CC's Telegram client.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildAiAuditAlert, composeAiAuditWelcome } from "../lib/forms/ai-audit-format";
import { scoreAiAuditLead } from "../lib/forms/ai-audit-ingest";
import { AI_AUDIT_STEP_COUNT } from "../lib/forms/oasis-ai-audit-seed";

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

/**
 * The public marketing site tells a visitor how many questions they are
 * committing to before they type anything. Until 2026-07-31 every one of
 * those statements said five against a four-step funnel — the number a
 * visitor uses to decide whether to start, wrong on the homepage.
 *
 * The server side is now derived from AI_AUDIT_STEP_COUNT and cannot drift.
 * The marketing copy is prose ("Four questions, two minutes") and cannot
 * take a template without wrecking the sentence, so this scans the real
 * files instead. Adding a step to the funnel fails here, with the list of
 * files that carry the number.
 */
const NUMBER_WORD: Record<number, string> = {
  2: "Two", 3: "Three", 4: "Four", 5: "Five", 6: "Six", 7: "Seven",
};

const COPY_FILES = [
  "app/(marketing)/home/page.tsx",
  "app/(marketing)/work/page.tsx",
  "app/(marketing)/contact/page.tsx",
  "components/marketing/AuditForm.tsx",
];

test("marketing copy states the real number of funnel steps", () => {
  const total = NUMBER_WORD[AI_AUDIT_STEP_COUNT];
  const remaining = NUMBER_WORD[AI_AUDIT_STEP_COUNT - 1];
  assert.ok(total && remaining, `add ${AI_AUDIT_STEP_COUNT} to NUMBER_WORD`);

  const wrongTotals = Object.entries(NUMBER_WORD)
    .filter(([n]) => Number(n) !== AI_AUDIT_STEP_COUNT)
    .map(([, word]) => word);

  for (const rel of COPY_FILES) {
    const src = readFileSync(join(process.cwd(), rel), "utf8");

    // "Step 1 of N" — the literal count, wherever it appears.
    for (const m of src.matchAll(/Step 1 of (\d+)/g)) {
      assert.equal(
        Number(m[1]),
        AI_AUDIT_STEP_COUNT,
        `${rel} says "${m[0]}" but the funnel has ${AI_AUDIT_STEP_COUNT} steps`,
      );
    }

    // "<Word> questions" — the total, spelled out.
    for (const bad of wrongTotals) {
      assert.ok(
        !src.includes(`${bad} questions`),
        `${rel} says "${bad} questions" but the funnel has ${AI_AUDIT_STEP_COUNT} steps (expected "${total} questions")`,
      );
    }

    // "<Word> more screens/questions" — what is left AFTER step 1.
    for (const [n, word] of Object.entries(NUMBER_WORD)) {
      if (Number(n) === AI_AUDIT_STEP_COUNT - 1) continue;
      assert.ok(
        !new RegExp(`${word} more (screens|questions)`, "i").test(src),
        `${rel} promises "${word} more" after step 1, but ${remaining} remain`,
      );
    }
  }
});
