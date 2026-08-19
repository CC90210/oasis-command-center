/**
 * tests/audience-narrowing.test.ts — two sequences can share a stage without
 * double-contacting the same merchant.
 *
 * THE SITUATION. follow_up now carries a Bluerise EMAIL sequence and, from
 * 2026-08-19, an SMS one for the phone-only leads. The enroller only skips on a
 * MISSING contact method, and measured that day ALL 164 emailable follow_up
 * leads also have a phone. Without narrowing, every one of them enrols in both
 * and gets emailed AND texted for the same stage — from two different brands.
 *
 * `trigger_filter.requires` is the narrowing, and it is opt-in per sequence
 * rather than a global rule about SMS sequences: a Live Sub who happens to have
 * an email should still be texted, because that cohort is SMS-only by decision.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const enroller = readFileSync(new URL("../lib/drips/enroller.ts", import.meta.url), "utf8");

// ── The guard exists, and sits with the other PERMANENT guards ────────────
// A lead it rejects must not consume a slot under the enrollment limit and
// starve the leads queued behind it — the same reason the contact-method
// checks live there rather than downstream.
assert.ok(
  enroller.includes('if (requires === "no_email" && hasEmail) return "covered_by_other_channel";'),
  "an emailable lead must be left to the email sequence",
);
assert.ok(
  enroller.includes('if (requires === "no_phone" && hasPhone) return "covered_by_other_channel";'),
  "and the mirror rule exists so the concept is not one-directional",
);
{
  const start = enroller.indexOf("function staticSkipReason");
  const fn = enroller.slice(start, enroller.indexOf("\n}", start));
  assert.ok(fn.includes("covered_by_other_channel"), "the narrowing is a static skip, not a late filter");
  assert.ok(
    fn.indexOf('return "no_contact_method"') < fn.indexOf("covered_by_other_channel"),
    "contact method is still checked first: no phone beats any audience rule",
  );
}

// ── It is actually PASSED, not just defined ───────────────────────────────
// A guard the call site never supplies is a guard that never fires — the exact
// shape of every silent failure in this engine.
assert.ok(
  enroller.includes("staticSkipReason(lead.data || {}, stage, firstChannel, seq.trigger_filter?.requires)"),
  "the call site must thread the sequence's own requires through",
);

// ── OPT-IN, never inferred from the channel ───────────────────────────────
// Inferring "SMS sequence => skip emailable leads" would break Live Subs, which
// is SMS-only by decision and contains a lead who does have an email.
assert.ok(
  !/firstChannel === "sms" && hasEmail/.test(enroller),
  "must not infer the narrowing from the channel; Live Subs would lose its emailable lead",
);

// ── Declared in the type, not smuggled through an untyped blob ────────────
assert.ok(
  /requires\?: "no_email" \| "no_phone";/.test(enroller),
  "the key is declared on trigger_filter so a typo is a compile error",
);

// ── The skip is counted, so a silent mass-skip is visible in the run ──────
// 164 leads quietly vanishing from a run with no counter is how you discover a
// mistake a week later from the send volume.
assert.ok(enroller.includes('| "covered_by_other_channel"'), "the reason is in the SkipReason union");
assert.ok(enroller.includes("covered_by_other_channel: 0,"), "and initialised in the counter");

console.log("audience-narrowing.test.ts — all assertions passed");
