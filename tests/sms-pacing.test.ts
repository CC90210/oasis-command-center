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
  smsPacingCaps, pacingDecision, nextWindowStart, nextHourStart,
} from "../lib/drips/sms-pacing-core";

const CAPS = { daily: 40, hourly: 6, windowStartUtcHour: 14 };
const at = (iso: string) => new Date(iso);

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
  assert.ok(exec.includes("const pace = pacingDecision(run.smsCounts, caps, new Date());"),
    "the gate must run on the SMS send path");
  assert.ok(
    exec.indexOf("pacingDecision") < exec.indexOf("const result = await sendDripSms"),
    "the gate must be a ceiling, not an after-the-fact count",
  );
  // Counted once per run and incremented locally: a fresh read per row cannot
  // see this batch's in-flight sends, so 40/day would become 40/tick.
  assert.ok(exec.includes("run.smsCounts.sentToday += 1;"), "each send must count against the ceiling");
  assert.ok(exec.includes("run.smsCounts.sentThisHour += 1;"));

  // Fails closed: an unreadable count returns the cap, which holds.
  const core = readFileSync(new URL("../lib/drips/executor.ts", import.meta.url), "utf8");
  const fn = core.slice(core.indexOf("async function loadSmsCounts"), core.indexOf("SMS is blocked upstream"));
  assert.ok(
    (fn.match(/sentToday: caps\.daily/g) || []).length >= 2,
    "both the error and the throw path must fail closed at the cap",
  );
}

console.log("sms-pacing.test.ts — all assertions passed");
