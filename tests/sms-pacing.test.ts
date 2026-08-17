/**
 * tests/sms-pacing.test.ts — a drip through the day, not a blast.
 *
 * Adon, 2026-08-17: "Start sending them out slowly. Don't do it as a blast.
 * Just do it as a drip throughout the day. Let's start off with doing 40 a day."
 *
 * There was NO SMS volume governor before this — the governor caps email only.
 * Enabling the Live Subs sequence without it pushes every due row in one
 * dispatch tick: 40 texts from one number inside five minutes, which is the
 * shape carriers filter on.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  smsPacingCaps, pacingDecision, nextWindowStart, nextHourStart, windowStartFor,
} from "../lib/drips/sms-pacing-core";

const at = (iso: string) => new Date(iso);

// ── The count window and the resume boundary must AGREE ───────────────────
// Codex: with a rolling 24h count against a fixed 14:00 resume, reaching the
// cap at 20:00 means yesterday's 14:00-20:00 sends are still inside the window
// when the row wakes, so it re-holds for another full day. 40/day quietly
// becomes 40 every two days. windowStartFor is what keeps the two aligned.
{
  // Before today's opening, the current sending day started YESTERDAY.
  assert.equal(windowStartFor(at("2026-08-17T10:00:00Z"), 14).toISOString(), "2026-08-16T14:00:00.000Z");
  // At and after it, today.
  assert.equal(windowStartFor(at("2026-08-17T14:00:00Z"), 14).toISOString(), "2026-08-17T14:00:00.000Z");
  assert.equal(windowStartFor(at("2026-08-17T20:00:00Z"), 14).toISOString(), "2026-08-17T14:00:00.000Z");

  // The load-bearing property: nothing counted in the current window is still
  // counted after the resume time, so a capped row actually gets a fresh
  // allowance instead of re-holding.
  const cappedAt = at("2026-08-17T20:00:00Z");
  const resume = nextWindowStart(cappedAt, 14);
  assert.equal(resume.toISOString(), "2026-08-18T14:00:00.000Z");
  assert.ok(
    windowStartFor(resume, 14).getTime() >= resume.getTime() - 1000,
    "at the resume instant the counting window has rolled over, so the tally is empty",
  );
  assert.ok(
    windowStartFor(resume, 14).getTime() > cappedAt.getTime(),
    "every send that filled yesterday's cap is OUTSIDE the new window",
  );
}

const CAPS = { daily: 40, hourly: 6, windowStartUtcHour: 14 };

// ── Under both ceilings, it sends ─────────────────────────────────────────
assert.equal(pacingDecision({ sentToday: 0, sentThisHour: 0 }, CAPS, at("2026-08-17T15:00:00Z")).send, true);
assert.equal(pacingDecision({ sentToday: 39, sentThisHour: 5 }, CAPS, at("2026-08-17T15:00:00Z")).send, true);

// ── The daily ceiling holds until the next WINDOW, not midnight ───────────
// Resuming at midnight would land a held backlog at 3am local, which is both a
// TCPA problem and the fastest way to get a number reported.
{
  const d = pacingDecision({ sentToday: 40, sentThisHour: 0 }, CAPS, at("2026-08-17T15:00:00Z"));
  assert.equal(d.send, false);
  assert.match(d.send === false ? d.reason : "", /sms_daily_cap \(40\/40\)/);
  assert.equal(d.send === false ? d.resumeAt.toISOString() : "", "2026-08-18T14:00:00.000Z");
}

// ── The hourly ceiling is what makes it a drip ────────────────────────────
// 40/day with no hourly limit is still 40 in the first five minutes.
{
  const d = pacingDecision({ sentToday: 6, sentThisHour: 6 }, CAPS, at("2026-08-17T15:20:00Z"));
  assert.equal(d.send, false);
  assert.match(d.send === false ? d.reason : "", /sms_hourly_cap/);
  assert.equal(d.send === false ? d.resumeAt.toISOString() : "", "2026-08-17T16:00:00.000Z", "top of the next hour");
}

// Daily is checked FIRST: at both ceilings the honest answer is tomorrow, not
// the next hour, or the row would wake hourly all evening and re-hold each time.
{
  const d = pacingDecision({ sentToday: 40, sentThisHour: 6 }, CAPS, at("2026-08-17T15:00:00Z"));
  assert.match(d.send === false ? d.reason : "", /daily/);
}

// ── Every resume time is STRICTLY in the future ───────────────────────────
// A resume time equal to now is the permanent-loop bug this engine has already
// produced three times: the row comes due, re-evaluates, and re-holds forever.
{
  for (const iso of [
    "2026-08-17T14:00:00Z", // exactly the window start
    "2026-08-17T13:59:59Z",
    "2026-08-17T23:59:59Z",
    "2026-08-17T00:00:00Z",
  ]) {
    const now = at(iso);
    assert.ok(nextWindowStart(now, 14).getTime() > now.getTime(), `window start must be future from ${iso}`);
    assert.ok(nextHourStart(now).getTime() > now.getTime(), `hour start must be future from ${iso}`);
  }
  // And on the hour exactly, not the same instant back again.
  assert.equal(nextHourStart(at("2026-08-17T15:00:00Z")).toISOString(), "2026-08-17T16:00:00.000Z");
}

// ── Caps come from env so the ramp moves without a deploy ─────────────────
assert.deepEqual(smsPacingCaps({}), { daily: 40, hourly: 6, windowStartUtcHour: 14 });
assert.equal(smsPacingCaps({ DRIPS_SMS_DAILY_CAP: "80" }).daily, 80);
assert.equal(smsPacingCaps({ DRIPS_SMS_HOURLY_CAP: "10" }).hourly, 10);
// Garbage falls back rather than becoming NaN, which would compare false
// against every count and uncap the channel entirely.
for (const junk of ["", "abc", "-5", " "]) {
  assert.equal(smsPacingCaps({ DRIPS_SMS_DAILY_CAP: junk }).daily, 40, `"${junk}" must fall back`);
}
// Zero is a real operator choice — a full stop — and must NOT be read as unset.
{
  const stopped = smsPacingCaps({ DRIPS_SMS_DAILY_CAP: "0" });
  assert.equal(stopped.daily, 0);
  assert.equal(pacingDecision({ sentToday: 0, sentThisHour: 0 }, stopped, at("2026-08-17T15:00:00Z")).send, false,
    "a cap of 0 stops the channel");
}

// ── The executor consults it, and counts its own sends ────────────────────
{
  const exec = readFileSync(new URL("../lib/drips/executor.ts", import.meta.url), "utf8");
  assert.ok(exec.includes("const pace = pacingDecision(counts, caps, new Date());"),
    "the gate must run on the SMS send path");
  assert.ok(
    exec.indexOf("pacingDecision") < exec.indexOf("const result = await sendDripSms"),
    "the gate must be a ceiling, not an after-the-fact count",
  );

  // PER TENANT. A dispatch batch spans tenants, and a single shared counter
  // governs every later tenant by the FIRST one's history — holding valid
  // sends or letting a tenant exceed its own cap. Codex caught it.
  assert.ok(
    !/run\.smsCounts\b(?!ByTenant)/.test(exec),
    "a single shared counter must not come back",
  );
  assert.ok(exec.includes("run.smsCountsByTenant.get(row.tenant_id)"), "counts are keyed by tenant");
  assert.ok(exec.includes("run.smsCountsByTenant.set(row.tenant_id, counts)"));

  // Counted once per tenant per run and incremented locally: a fresh read per
  // row cannot see this batch's in-flight sends, so 40/day would be 40/tick.
  assert.ok(exec.includes("paced.sentToday += 1;"), "each send must count against the ceiling");
  assert.ok(exec.includes("paced.sentThisHour += 1;"));

  // The daily tally must be measured from the sending window, not a rolling
  // 24h, or it disagrees with the resume boundary and yields 40 every two days.
  assert.ok(
    exec.includes("windowStartFor(new Date(now), caps.windowStartUtcHour)"),
    "the daily count must align with the resume boundary",
  );
  assert.ok(!exec.includes("now - 24 * 3_600_000"), "the rolling 24h count must be gone");

  // Fails closed: an unreadable count returns the cap, which holds.
  const core = readFileSync(new URL("../lib/drips/executor.ts", import.meta.url), "utf8");
  const fn = core.slice(core.indexOf("async function loadSmsCounts"), core.indexOf("SMS is blocked upstream"));
  assert.ok(
    (fn.match(/sentToday: caps\.daily/g) || []).length >= 2,
    "both the error and the throw path must fail closed at the cap",
  );
}

console.log("sms-pacing.test.ts — all assertions passed");
