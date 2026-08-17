/**
 * tests/sms-only-and-brand-lock.test.ts — two channel/brand promises that are
 * easy to break by being helpful.
 *
 * Adon, 2026-08-17:
 *   "that's why live subs is going to be just SMS only"
 *   "The Bluerise should only be for follow-ups."
 *
 * Both are the kind of rule that holds until some other correct-looking
 * behaviour quietly overrides it, which is why they are pinned rather than
 * left to the configuration that happens to be in place today.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isSmsOnly, smsOnlyStages, aiWireStages } from "../lib/drips/ai-wire-core";
import { brandForSend, brandForStage } from "../lib/drips/brand-routing";
import { resolveChannel, onProviderGap, contactabilityOf } from "../lib/drips/channel-fallback";

const NO_ENV: Record<string, string | undefined> = {};

// ── Live Subs are SMS-only ────────────────────────────────────────────────
for (const stage of ["uw_sheet", "live_sub", "live_subs", "UW_Sheet"]) {
  assert.equal(isSmsOnly({ stage }, NO_ENV), true, `${stage} must never be emailed`);
}
for (const stage of ["follow_up", "viewed_application", "signed_application", "declined", ""]) {
  assert.equal(isSmsOnly({ stage }, NO_ENV), false, `${stage} still uses both channels`);
}
assert.equal(isSmsOnly({}, NO_ENV), false, "no stage is not a claim about the channel");

// Defaults track the AI wire, because they are the same cohort by construction.
assert.deepEqual(smsOnlyStages(NO_ENV), aiWireStages(NO_ENV).filter((s) => s !== "*"));

// ── The two mechanisms that would otherwise email them ────────────────────
// Both are correct everywhere else, and both already fire in production: 127
// rows carry channel='sms' with an EMAIL address in from_identity, the oldest
// from 2026-07-20.
{
  const both = contactabilityOf({ email: "a@b.com", phone: "3055550147" });

  // 1. resolveChannel substitutes when the authored channel has no detail.
  //    Locking is what stops it — and with a phone present it still texts.
  const locked = resolveChannel("sms", both, { channelLocked: true });
  assert.equal(locked.send && locked.channel, "sms");
  assert.equal(locked.send && locked.substituted, false, "a locked SMS step is never rewritten to email");

  // A locked SMS step with no phone reports unreachable rather than emailing.
  const noPhone = contactabilityOf({ email: "a@b.com" });
  const d = resolveChannel("sms", noPhone, { channelLocked: true });
  assert.equal(d.send, false);
  assert.match(d.send === false ? d.detail : "", /locked to sms/);

  // 2. onProviderGap falls back to email when SMS is blocked upstream. Locked,
  //    it must hold instead — the AI wire exists precisely because the main
  //    wire is carrier-dead, so "fall back until SMS recovers" is indefinite.
  const gap = onProviderGap({ blocked: "sms", contact: both, channelLocked: true, gap: "carrier halt" });
  assert.equal(gap.action, "hold");
  assert.match(gap.reason, /locked to sms/);

  // Unlocked, the same call still falls back — the Live Subs rule must not
  // have quietly reverted the fix that unstalled the queue.
  const unlocked = onProviderGap({ blocked: "sms", contact: both, gap: "carrier halt" });
  assert.equal(unlocked.action, "fallback", "non-Live-Subs leads still get the email fallback");
}

// ── The executor applies the lock at BOTH leak points ─────────────────────
{
  const exec = readFileSync(new URL("../lib/drips/executor.ts", import.meta.url), "utf8");
  assert.ok(
    /const smsOnly = isSmsOnly\(data\);/.test(exec),
    "the step router must compute the SMS-only rule",
  );
  assert.ok(
    /channel_locked\) \|\| smsOnly;/.test(exec),
    "substitution is blocked by locking the channel",
  );
  // Locking cannot express "an email step must not run here" — a locked email
  // step is locked TO email — so the stage rule needs its own check.
  assert.ok(
    exec.includes('if (smsOnly && decision.channel === "email")'),
    "an email step authored against an SMS-only stage must be skipped, not sent",
  );
  assert.ok(
    /channelLocked:\s*\n?\s*isTruthyFlag\(\(step as unknown as Record<string, unknown>\)\.channel_locked\) \|\| isSmsOnly\(data\)/.test(exec),
    "the provider-gap fallback must honour the SMS-only rule too",
  );
}

// ── Bluerise sends only for follow-ups ────────────────────────────────────
assert.equal(brandForSend({ stage: "follow_up" }), "bluerise");
for (const stage of ["viewed_application", "signed_application", "sent_application"]) {
  assert.equal(brandForSend({ stage }), "sunbiz", `${stage} is the transactional funnel`);
}

// THE REGRESSION. The call site used to read
//   brandForStage(stage) ?? stampedBrand ?? "sunbiz"
// so a stage with NO rule fell through to the stamp — and initialBrandFor
// stamps `bluerise` on any cold-sourced lead. That is Bluerise speaking for a
// stage nobody assigned it to. Measured 2026-08-17 it had not happened yet
// (all 92 stamped leads are sunbiz, zero bluerise), which is exactly the sort
// of accident that stops holding quietly.
for (const stage of ["declined", "default", "uw_sheet", "dead_file", "funded", "unknown_stage"]) {
  assert.equal(brandForStage(stage), null, `${stage} genuinely has no stage rule`);
  assert.equal(
    brandForSend({ stage, stampedBrand: "bluerise" }),
    "sunbiz",
    `a bluerise STAMP must not promote ${stage} onto the Bluerise domain`,
  );
}

// An unassigned stage resolves rather than blocking. Holding would be the
// silent-stall failure this engine has already produced three times.
assert.equal(brandForSend({ stage: "brand_new_stage" }), "sunbiz");
assert.equal(brandForSend({ stage: "" }), "sunbiz");
assert.equal(brandForSend({ stage: undefined }), "sunbiz");

// ── The executor uses it ──────────────────────────────────────────────────
{
  const exec = readFileSync(new URL("../lib/drips/executor.ts", import.meta.url), "utf8");
  assert.ok(
    !/brandForStage\(data\.stage\) \?\? run\.brandByLead\.get\(row\.lead_id\) \?\? "sunbiz"[\s\S]{0,400}resolveStepCopy/.test(exec),
    "the email path must not fall through a stamp to Bluerise",
  );
  assert.ok(exec.includes("brandForSend({"), "the email path resolves the brand through brandForSend");
}

console.log("sms-only-and-brand-lock.test.ts — all assertions passed");
