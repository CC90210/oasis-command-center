/**
 * alert-page-policy.test.ts — locks the rule that decides whether an operator
 * actually HEARS about a failure (2026-07-29, codex review P1).
 *
 * The `telegramOncePerOpen` suppression exists to stop notification storms, but
 * a naive "already open → stay silent" swallows escalations: an open card for a
 * live sub missing a credit score would absorb a later retry that came back
 * missing business_name. These assertions pin the boundary between "you already
 * know" and "it got worse while you weren't looking."
 */
import assert from "node:assert";
import { isSameNews, shouldPageTelegram } from "../lib/notify/alert-page-policy";

function run() {
  // ── isSameNews ───────────────────────────────────────────────────────────
  assert.strictEqual(
    isSameNews({
      existingSeverity: "warn",
      existingSignature: "applicant_fico",
      nextSeverity: "warn",
      nextSignature: "applicant_fico",
    }),
    true,
    "identical severity + signature is the same news",
  );

  assert.strictEqual(
    isSameNews({
      existingSeverity: "warn",
      existingSignature: "tax_id_ein",
      nextSeverity: "urgent",
      nextSignature: "business_name|monthly_revenue",
    }),
    false,
    "warn → urgent is an escalation, never the same news",
  );

  assert.strictEqual(
    isSameNews({
      existingSeverity: "warn",
      existingSignature: "tax_id_ein",
      nextSeverity: "warn",
      nextSignature: "position_count",
    }),
    false,
    "same severity but a DIFFERENT missing field is new news",
  );

  assert.strictEqual(
    isSameNews({
      existingSeverity: "warn",
      existingSignature: undefined, // card predates signatures (e.g. a FICO-era row)
      nextSeverity: "warn",
      nextSignature: "tax_id_ein",
    }),
    false,
    "a legacy card with no signature reads as CHANGED, so the page goes through",
  );

  assert.strictEqual(
    isSameNews({
      existingSeverity: "warn",
      existingSignature: undefined,
      nextSeverity: "warn",
      nextSignature: undefined, // caller does not fingerprint (e.g. drip outage)
    }),
    true,
    "no signature on either side → severity alone decides (legacy caller unchanged)",
  );

  // ── shouldPageTelegram ───────────────────────────────────────────────────
  const base = { severity: "warn" as const, refreshedExisting: false, refreshedUnchanged: false };

  assert.strictEqual(shouldPageTelegram(base), true, "warn pages by default");
  assert.strictEqual(
    shouldPageTelegram({ ...base, severity: "info" }),
    false,
    "info stays silent by default",
  );
  assert.strictEqual(
    shouldPageTelegram({ ...base, severity: "info", telegram: true }),
    true,
    "explicit telegram:true overrides the info default",
  );

  assert.strictEqual(
    shouldPageTelegram({
      ...base,
      telegramOncePerOpen: true,
      refreshedExisting: true,
      refreshedUnchanged: true,
    }),
    false,
    "same news on an already-open card stays silent (the storm fix)",
  );

  assert.strictEqual(
    shouldPageTelegram({
      ...base,
      severity: "urgent",
      telegramOncePerOpen: true,
      refreshedExisting: true,
      refreshedUnchanged: false,
    }),
    true,
    "ESCALATION on an already-open card MUST page (codex review P1 2026-07-29)",
  );

  assert.strictEqual(
    shouldPageTelegram({
      ...base,
      telegramOncePerOpen: true,
      refreshedExisting: false, // DB write failed → we don't know
      refreshedUnchanged: true,
    }),
    true,
    "an unverified refresh errs LOUD — monitoring never goes quiet on an error",
  );

  console.log("alert-page-policy.test.ts — all assertions passed ✓");
}

run();
