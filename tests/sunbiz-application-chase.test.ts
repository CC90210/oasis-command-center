import assert from "node:assert/strict";
import {
  SUNBIZ_VIEWED_APPLICATION_STEPS as STEPS,
  APPLICATION_LINK_TOKEN,
} from "../lib/drips/sunbiz-application-chase";
import { matchPositioningPhrases, matchLenderNames } from "../lib/integrations/blast-safety-core";

/**
 * The Form 2 completion chase. Every assertion here corresponds to a rule that
 * was violated in production, so each one is a regression guard rather than a
 * style preference.
 */

/** Every piece of merchant-facing text in a step: body, subject, all variants. */
function allCopy(step: (typeof STEPS)[number]): string[] {
  return [
    step.subject || "",
    step.body || "",
    ...(step.subject_variants || []),
    ...(step.body_variants || []),
  ].filter(Boolean);
}
const everyString = STEPS.flatMap(allCopy);

// ---------------------------------------------------------------------------
// 1. EMAIL ONLY (Adon, 2026-08-20)
//    "there shouldn't be text drips sent to people to complete their
//    application. No not even if it's a live sub."
// ---------------------------------------------------------------------------
assert.ok(STEPS.length >= 5, `expected a real chase, got ${STEPS.length} steps`);
for (const [i, step] of STEPS.entries()) {
  assert.equal(step.channel, "email", `step ${i} must be email; SMS is banned on this chase`);
}
assert.equal(
  STEPS.filter((s) => (s.channel as string) === "sms").length,
  0,
  "no SMS step may ever be added back to the application chase",
);

// ---------------------------------------------------------------------------
// 2. EVERY step carries the per-lead link.
//    The token is what arms executor.ts's mint-and-halt guard. A step without
//    it can send a merchant a message they have no way to act on.
// ---------------------------------------------------------------------------
for (const [i, step] of STEPS.entries()) {
  assert.ok(
    (step.body || "").includes(APPLICATION_LINK_TOKEN),
    `step ${i} body is missing ${APPLICATION_LINK_TOKEN}`,
  );
  for (const [vi, v] of (step.body_variants || []).entries()) {
    assert.ok(
      v.includes(APPLICATION_LINK_TOKEN),
      `step ${i} body_variant ${vi} is missing ${APPLICATION_LINK_TOKEN} — the executor picks variants deterministically per lead, so ONE bad variant silently strands a slice of the audience`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Direct-funder positioning. The executor runs sanitizeBlastMessage over
//    this copy at send time and BLOCKS on a hit, so a violation here does not
//    reach a merchant — it silently kills the step instead.
// ---------------------------------------------------------------------------
for (const text of everyString) {
  const hits = matchPositioningPhrases(text);
  assert.deepEqual(hits, [], `broker-positioning phrase ${JSON.stringify(hits)} in: ${text.slice(0, 90)}`);
}

// A realistic slice of the tenant's lender table, including the junk "TEST n"
// records that live there and legitimately trip the guard.
const LENDERS = [
  "DLP Funding", "Breeze Advance", "Flow Capital", "Fratello Capital", "GFE",
  "Avanza Capital Holdings", "Mint Funding", "NewCo Capital Group",
  "CFG Merchant Solutions", "Retro Advance", "Eminent Funding", "Overton Funding",
  "Meged Funding", "Monday Funding", "JRG Funding", "Apex MCA", "Zlur Funding",
  "Oakwood Business Funding", "Credit Capital Partners", "Instafund Advance",
  "CashFlow Capital", "TenFF", "CapWorks", "TEST 1", "TEST 2", "Test 3",
];
for (const text of everyString) {
  const hits = matchLenderNames(text, LENDERS);
  assert.deepEqual(hits, [], `lender name ${JSON.stringify(hits)} in: ${text.slice(0, 90)}`);
}

// ---------------------------------------------------------------------------
// 4. No em dashes in merchant copy.
// ---------------------------------------------------------------------------
for (const text of everyString) {
  assert.ok(!/[—–]/.test(text), `em/en dash in merchant copy: ${text.slice(0, 90)}`);
}

// ---------------------------------------------------------------------------
// 5. Shape the executor depends on.
// ---------------------------------------------------------------------------
for (const [i, step] of STEPS.entries()) {
  assert.ok(step.subject && step.subject.trim(), `step ${i} needs a subject (email channel)`);
  assert.ok(Number.isFinite(step.delay_minutes) && step.delay_minutes >= 0, `step ${i} delay invalid`);
  // resolveStepCopy pairs subject_variants to body_variants BY INDEX; a
  // mismatched length silently pairs the wrong subject with the wrong body.
  if (step.subject_variants?.length && step.body_variants?.length) {
    assert.ok(
      step.subject_variants.length >= step.body_variants.length,
      `step ${i}: ${step.body_variants.length} body variants but only ${step.subject_variants.length} subjects — index pairing would fall off the end`,
    );
  }
}

// Step 0 stays the proven opener: it is the only message in this arc with a
// measured conversion history, so the rebuild extends the chase rather than
// restarting it from unproven copy.
assert.equal(STEPS[0].role, "opener");
assert.equal(STEPS[0].delay_minutes, 30, "opener still fires 30 minutes after the stage change");
assert.match(STEPS[0].subject || "", /Heads up on the application/);

// The arc ends by letting go rather than nagging forever.
assert.equal(STEPS[STEPS.length - 1].role, "last_call");

// ---------------------------------------------------------------------------
// 6. Cadence: a hard chase over roughly five days, then stop (Adon's call).
// ---------------------------------------------------------------------------
const totalMinutes = STEPS.reduce((sum, s) => sum + s.delay_minutes, 0);
const totalDays = totalMinutes / 1440;
assert.ok(
  totalDays >= 4 && totalDays <= 6,
  `chase should span about 5 days, got ${totalDays.toFixed(1)}`,
);
// Nothing may fire twice in one day: delays are measured from the PREVIOUS
// step, so a small value here means two emails land back to back.
for (const [i, step] of STEPS.slice(1).entries()) {
  assert.ok(
    step.delay_minutes >= 1440,
    `step ${i + 1} fires only ${step.delay_minutes} minutes after the previous one`,
  );
}

console.log(`ok sunbiz-application-chase (${STEPS.length} email steps, ${totalDays.toFixed(1)} days)`);
