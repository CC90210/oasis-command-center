/**
 * tests/optout-cooloff.test.ts — someone who says stop does not hear from the
 * other channel the next morning.
 *
 * Adon, 2026-08-17: "we need to ensure that someone that says stop is not
 * texted from that account for, let's do, like a week, maybe two-week cool-off
 * period... and then we have to be alerted about this as well."
 *
 * THE GAP THIS CLOSES. An SMS opt-out writes to sunbiz_phone_suppressions,
 * keyed by NUMBER. The email drip reads email_suppressions. Two different
 * lists, so a merchant could reply STOP to a text at 4pm and receive a Bluerise
 * follow-up at 9am — technically two channels, obviously the same company
 * ignoring them.
 *
 * WHAT IT IS NOT. It is not a timer on the SMS opt-out. Texting stays suppressed
 * permanently; under the TCPA an opt-out does not expire, and resuming texts
 * after fourteen days would be a statutory claim per message rather than a
 * cadence choice. Nothing here touches the phone suppression.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { emailCooloff, cooloffDays } from "../lib/drips/optout-cooloff-core";

const now = new Date("2026-08-17T18:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

// ── Never opted out: the overwhelmingly common case, and it must be cheap ──
for (const empty of [null, undefined, ""]) {
  assert.equal(emailCooloff(empty, now, 14).held, false, `${String(empty)} is not an opt-out`);
}

// ── Inside the window, email holds ────────────────────────────────────────
{
  const c = emailCooloff(daysAgo(1), now, 14);
  assert.equal(c.held, true);
  assert.match(c.held ? c.reason : "", /said stop by text/);
  assert.match(c.held ? c.reason : "", /13d of 14 left/);
  // Resume is measured from the OPT-OUT, not from now, or every dispatch tick
  // would push it another fortnight into the future and it would never lift.
  assert.equal(c.held ? c.until.toISOString() : "", "2026-08-30T18:00:00.000Z");
}

// ── The boundary lifts, and lifting is what makes it a pause not a deletion ─
assert.equal(emailCooloff(daysAgo(13.9), now, 14).held, true, "still inside");
assert.equal(emailCooloff(daysAgo(14), now, 14).held, false, "exactly at the boundary, released");
assert.equal(emailCooloff(daysAgo(30), now, 14).held, false, "long past");

// ── A repeated hold must not ratchet forward ──────────────────────────────
// The same opt-out evaluated on three successive days yields the SAME resume
// time. A resume computed from `now` would slide daily and never release.
{
  const optedOut = daysAgo(2);
  const a = emailCooloff(optedOut, now, 14);
  const b = emailCooloff(optedOut, new Date(now.getTime() + 86_400_000), 14);
  const c = emailCooloff(optedOut, new Date(now.getTime() + 2 * 86_400_000), 14);
  assert.ok(a.held && b.held && c.held);
  assert.equal(a.until.toISOString(), b.until.toISOString());
  assert.equal(b.until.toISOString(), c.until.toISOString());
}

// ── An unreadable timestamp HOLDS ─────────────────────────────────────────
// We know an opt-out was recorded, that is why the field exists, and we cannot
// tell when. Sending on "the date looks odd" is the wrong way to resolve it.
for (const junk of ["not-a-date", "yesterday", {}, []]) {
  const c = emailCooloff(junk, now, 14);
  assert.equal(c.held, true, `${JSON.stringify(junk)} must hold, not send`);
  assert.match(c.held ? c.reason : "", /timestamp unreadable/);
  // Held for the FULL period from now: the only safe assumption is that it
  // just happened.
  assert.equal(c.held ? c.until.toISOString() : "", "2026-08-31T18:00:00.000Z");
}
// Epoch millis are a legitimate shape and must not be read as unreadable.
{
  const c = emailCooloff(Date.parse(daysAgo(1)), now, 14);
  assert.equal(c.held, true);
  assert.equal(c.held ? c.until.toISOString() : "", "2026-08-30T18:00:00.000Z");
}

// ── Zero days is a deliberate "off", not an accident ──────────────────────
assert.equal(emailCooloff(daysAgo(0), now, 0).held, false, "0 days disables the cool-off");

// ── The period is configurable; garbage falls back to two weeks ───────────
assert.equal(cooloffDays({}), 14);
assert.equal(cooloffDays({ DRIPS_OPTOUT_COOLOFF_DAYS: "7" }), 7, "Adon offered a week as the short end");
assert.equal(cooloffDays({ DRIPS_OPTOUT_COOLOFF_DAYS: "0" }), 0, "explicit off is honoured");
for (const junk of ["", "  ", "abc", "-3"]) {
  assert.equal(cooloffDays({ DRIPS_OPTOUT_COOLOFF_DAYS: junk }), 14,
    `"${junk}" must fall back, not become NaN and disable the hold`);
}

// ── The executor consults it, on the EMAIL path, after suppression ────────
{
  const exec = readFileSync(new URL("../lib/drips/executor.ts", import.meta.url), "utf8");
  assert.ok(
    exec.includes("const cool = emailCooloff(data.sms_opt_out_at, new Date(), cooloffDays());"),
    "the email path must consult the cool-off",
  );
  // After the hard suppression check: a genuine unsubscribe is a permanent
  // fail, and must not be downgraded into a temporary hold.
  assert.ok(
    exec.indexOf('markPermanentFail(db, row, "suppressed (unsubscribed)")') < exec.indexOf("emailCooloff("),
    "the permanent unsubscribe check must still come first",
  );
  // Rescheduled, never failed: this is a pause, not a deletion.
  assert.ok(
    /if \(cool\.held\) return markRescheduled\(db, row, cool\.until\.toISOString\(\), cool\.reason\);/.test(exec),
    "a cool-off holds the row rather than killing the sequence",
  );
}

// ── The handoff stamps what the cool-off reads ────────────────────────────
// The stamp and the reader are in different files; if the writer stops writing,
// the reader silently never holds and nothing fails.
{
  const handoff = readFileSync(new URL("../lib/drips/reply-handoff.ts", import.meta.url), "utf8");
  assert.ok(handoff.includes("patch.sms_opt_out_at ="), "an opt-out must stamp the lead");
  assert.ok(handoff.includes("patch.sms_opt_out_kind ="), "and record which kind it was");
  // ONE write. Two sequential read-modify-writes both spreading `data` means
  // the second silently discards the first, and the field discarded would be
  // the opt-out stamp itself.
  assert.equal(
    (handoff.match(/\.from\("tenant_records"\)\s*\n\s*\.update\(/g) || []).length,
    1,
    "exactly one record update, or the stamp gets clobbered",
  );
}

console.log("optout-cooloff.test.ts — all assertions passed");
