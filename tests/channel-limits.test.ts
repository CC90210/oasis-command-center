/**
 * tests/channel-limits.test.ts — the volume dials are real controls, not
 * decoration.
 *
 * Adon, 2026-08-17: "those tabs are actually functional where if I want to
 * increase or decrease the volume, I will be able to use the rest of the
 * software."
 *
 * Every send ceiling used to live in an env var, so "send more today" was a
 * redeploy and therefore a request to me. The per-SEQUENCE email cap was
 * already editable; the per-CHANNEL ones were not, and those are the ones that
 * gate the day.
 *
 * The failure worth pinning is not a bad number reaching the database. It is a
 * control that SAVES and does not move the engine — which reads as working and
 * is the worst possible outcome for a dial.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  resolveLimits, validateLimit, validateLimits,
  LIMIT_MAX, LIMIT_DEFAULT, LIMIT_KEYS,
} from "../lib/drips/channel-limits-core";

const NO_ENV: Record<string, string | undefined> = {};

// ── Precedence: stored → env → default ────────────────────────────────────
assert.deepEqual(resolveLimits(null, NO_ENV), LIMIT_DEFAULT, "nothing stored, nothing set: the defaults");
assert.equal(resolveLimits(null, { DRIPS_SMS_DAILY_CAP: "25" }).smsDaily, 25, "env beats the default");
assert.equal(
  resolveLimits({ smsDaily: 30 }, { DRIPS_SMS_DAILY_CAP: "25" }).smsDaily,
  30,
  "what the operator stored beats the env var",
);
// A partial store leaves the others alone rather than zeroing them.
{
  const r = resolveLimits({ smsDaily: 30 }, NO_ENV);
  assert.equal(r.smsDaily, 30);
  assert.equal(r.emailDailySunbiz, LIMIT_DEFAULT.emailDailySunbiz, "untouched keys keep their default");
}

// ── ZERO means stopped, and must survive every layer ──────────────────────
// The classic falsy bug: treating 0 as "unset" silently resumes sending at the
// default at the exact moment an operator tried to stop.
assert.equal(resolveLimits({ smsDaily: 0 }, { DRIPS_SMS_DAILY_CAP: "40" }).smsDaily, 0);
assert.equal(resolveLimits({ emailDailyBluerise: 0 }, NO_ENV).emailDailyBluerise, 0);
assert.deepEqual(validateLimit("smsDaily", 0), { ok: true, value: 0 });
assert.deepEqual(validateLimit("smsDaily", "0"), { ok: true, value: 0 }, "the form sends strings");

// ...but an EMPTY box is a missing answer, not an instruction to stop.
// Number("") and Number("   ") are both 0, so without trimming first a blank
// field would silently halt the channel and look deliberate.
for (const blank of ["", "   ", "\t", "\n"]) {
  const v = validateLimit("smsDaily", blank);
  assert.equal(v.ok, false, `${JSON.stringify(blank)} must be rejected, not read as stop`);
  assert.match(v.ok === false ? v.reason : "", /enter a number/);
}

// ── Ceilings are enforced in the RULES, not the form ──────────────────────
// A number input in a browser is not validation, and a typo of 5000 would burn
// a domain before anyone noticed.
for (const key of LIMIT_KEYS) {
  const over = validateLimit(key, LIMIT_MAX[key] + 1);
  assert.equal(over.ok, false, `${key} must reject above its ceiling`);
  assert.match(over.ok === false ? over.reason : "", /cannot exceed/);
  assert.equal(validateLimit(key, LIMIT_MAX[key]).ok, true, `${key} accepts exactly its ceiling`);
}
// Bluerise is deliberately capped lower than SunBiz: four days of sending
// history against months, and no reputation buffer to spend.
assert.ok(
  LIMIT_MAX.emailDailyBluerise < LIMIT_MAX.emailDailySunbiz,
  "the cold domain must not be allowed to match the warm one",
);

// ── A stored value over a LOWERED ceiling is clamped, not discarded ───────
// Ceilings can drop in a later deploy. A value that was legal when saved must
// not take the channel down, and must not silently resolve HIGHER than what the
// operator last chose.
{
  const r = resolveLimits({ emailDailyBluerise: LIMIT_MAX.emailDailyBluerise + 50 }, NO_ENV);
  assert.equal(r.emailDailyBluerise, LIMIT_MAX.emailDailyBluerise, "clamped to the ceiling");
}

// ── Junk falls back rather than becoming NaN ──────────────────────────────
// NaN compares false against every count, which would uncap the channel.
for (const junk of ["abc", "", "  ", -1, 2.5, null, undefined, {}, []]) {
  const r = resolveLimits({ smsDaily: junk }, NO_ENV);
  assert.equal(r.smsDaily, LIMIT_DEFAULT.smsDaily, `${JSON.stringify(junk)} must fall back`);
  assert.ok(Number.isInteger(r.smsDaily));
}
assert.equal(resolveLimits(null, { DRIPS_SMS_DAILY_CAP: "abc" }).smsDaily, LIMIT_DEFAULT.smsDaily,
  "a malformed env var falls back too");

// ── Every problem is reported, not just the first ─────────────────────────
// A form that surfaces one error at a time makes an operator submit four times.
{
  const v = validateLimits({ smsDaily: 9999, smsHourly: -1, emailDailySunbiz: 100 });
  assert.equal(v.ok, false);
  assert.equal(v.problems.length, 2, "both bad fields reported");
  assert.deepEqual(v.values, { emailDailySunbiz: 100 }, "the good field still parses");
}
// An empty patch is not a silent success.
assert.equal(validateLimits({}).ok, true);
assert.deepEqual(validateLimits({}).values, {});

// ── THE ENGINE ACTUALLY READS THEM ────────────────────────────────────────
// A dial that saves and does not move the engine reads as working, which is
// worse than no dial at all.
{
  const gov = readFileSync(new URL("../lib/drips/governor.ts", import.meta.url), "utf8");
  assert.ok(gov.includes("getChannelLimits("), "the email budget must resolve the stored ceilings");
  assert.ok(gov.includes("dailyCapFor(b)"), "and use them for the per-brand daily remaining");
  assert.ok(
    !/dailyRemaining\[b\] = today === null \? emailDailyCap\(b\)/.test(gov),
    "the env-only path must be gone from the daily ceiling",
  );

  const exec = readFileSync(new URL("../lib/drips/executor.ts", import.meta.url), "utf8");
  assert.ok(
    exec.includes("daily: stored.smsDaily, hourly: stored.smsHourly"),
    "SMS pacing must use the stored ceilings",
  );
  // Including the fail-closed value: holding against a ceiling the operator has
  // since raised is a silent throttle nobody can find.
  assert.equal(
    (exec.match(/daily: stored\.smsDaily, hourly: stored\.smsHourly/g) || []).length,
    2,
    "both the gate and the fail-closed count use the effective cap",
  );
}

// ── The store fails OPEN to env, and that is a deliberate choice ──────────
// Zero would be "safer" in the abstract and is wrong here: it is a silent full
// stop on every channel triggered by a database blip. These are throttles;
// suppression, consent and the carrier breaker are the interlocks, and those
// all fail closed.
{
  const store = readFileSync(new URL("../lib/drips/channel-limits.ts", import.meta.url), "utf8");
  assert.ok(store.includes("resolveLimits(stored)"), "an unreadable row still resolves through env");
  assert.ok(!/return\s*\{[^}]*smsDaily:\s*0/.test(store), "never fall back to a silent stop");
  // The blob holds other settings; a bare write would delete them.
  assert.ok(store.includes("{ ...cf, drip_limits:"), "must read-modify-write the whole blob");
  assert.ok(store.includes("if (w.error)"), "a failed save must not report success");
}

console.log("channel-limits.test.ts — all assertions passed");
