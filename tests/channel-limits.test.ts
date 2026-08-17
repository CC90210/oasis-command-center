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
  // A MULTI-TENANT batch must not silently revert to the env caps. The first
  // cut only applied stored limits when the batch held exactly one tenant, so
  // on any ordinary run the control saved happily and changed nothing — the
  // exact failure the feature exists to avoid, created by the guard meant to
  // be careful. Codex caught it.
  assert.ok(
    !gov.includes("tenantIds.length === 1"),
    "the single-tenant guard silently disabled the control on real batches",
  );
  assert.ok(gov.includes("tenantIds.map((t) => getChannelLimits(t))"), "resolve for every tenant in the batch");
  assert.ok(gov.includes("Math.min(...picked)"), "the lowest ceiling wins, so it can only ever send less");
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
  // custom_fields is shared with other features, so an unguarded
  // read-modify-write can discard a change made between the read and the
  // write. Written, read back, and retried onto the newer blob if we lost.
  assert.ok(store.includes("attempt < 3"), "bounded optimistic retry, not an unguarded write");
  assert.ok(store.includes("allApplied"), "the write is confirmed, not assumed");
  assert.ok(
    store.includes("saved but could not confirm"),
    "an unconfirmable write must say so rather than claim a value the engine may not have",
  );
  assert.ok(store.includes("resolveLimits(landed)"), "the caller is told what actually landed");
}

// ── The tab actually SHOWS both channels ──────────────────────────────────
// "make sure your results are posted on the drips tab for texts and emails so
// I can keep track of everything." The chart was email-only, so the channel
// that had just gone live with a 40/day ceiling had no meter at all.
{
  const vol = readFileSync(new URL("../lib/drips/sequence-volume.ts", import.meta.url), "utf8");
  assert.ok(vol.includes('opts.channel === "sms" ? "sms_sent" : "email_sent"'), "the meter must be channel-aware");
  assert.ok(!vol.includes('.eq("type", "email_sent")'), "the hardcoded email-only filter must be gone");

  const page = readFileSync(new URL("../app/sequences/page.tsx", import.meta.url), "utf8");
  assert.ok(page.includes('channel: "sms"'), "the page must load the text meter");
  assert.ok(page.includes("getChannelLimits(tenantId)"), "and the ceilings the editor opens on");

  const view = readFileSync(new URL("../components/sequences/SequenceVolumeView.tsx", import.meta.url), "utf8");
  assert.ok(view.includes("Text volume per sequence"), "and render it");
  assert.ok(view.includes("<ChannelLimitsEditor"), "and mount the editor");
  // A failed read must never render as zero. An empty chart is the most
  // reassuring picture available and, when the read broke, the least true one —
  // and an operator would set a ceiling against it.
  assert.ok(view.includes("These bars are UNKNOWN, not zero."), "a broken SMS read says so");
}

// ── The editor re-seeds from the SERVER's answer ──────────────────────────
// If the server clamps a value, the box must show the clamped number. Showing
// what was typed would leave the screen disagreeing with the engine, which is
// the specific way a dial lies.
{
  const ed = readFileSync(new URL("../components/sequences/ChannelLimitsEditor.tsx", import.meta.url), "utf8");
  assert.ok(ed.includes("const applied = j.limits ?? saved;"), "re-seed from what was stored");
  assert.ok(ed.includes("validateLimit"), "the form uses the same rules the server enforces");
  // Strings, not numbers: a numeric input bound to a number cannot represent a
  // cleared box, and an empty box read as 0 silently stops the channel.
  assert.ok(ed.includes("Record<LimitKey, string>"), "draft values are held as strings");
}

console.log("channel-limits.test.ts — all assertions passed");
