/**
 * tests/sequence-volume.test.ts — per-sequence daily volume, and its cap.
 *
 * Adon, 2026-08-11: see how many email drips each sequence sends per day, and
 * change it from the software.
 *
 * The chart and the cap are one feature, so the properties that matter are the
 * ones where they could disagree with each other or with the engine.
 */

import assert from "node:assert/strict";
import {
  sequenceNameFromSource,
  dayKey,
  dayWindow,
  bucketBySequenceDay,
  parseSequenceDailyCap,
  sequenceRemaining,
  sequenceCapReached,
  MAX_SEQUENCE_DAILY_CAP,
  joinVolumeToSequences,
} from "../lib/drips/sequence-volume-core";
import {
  emailGateReason,
  consumeEmail,
  sequenceBudgetKeys,
  holdUntilIso,
  msUntilNextLocalDay,
  type EmailBudget,
} from "../lib/drips/drip-rules-core";

const TZ = "America/Toronto";

// ── agent_source parsing ──────────────────────────────────────────────────
assert.equal(sequenceNameFromSource("sequence:Cold Outreach"), "Cold Outreach");
// A colon is legal inside a name, so only the FIRST one separates.
assert.equal(sequenceNameFromSource("sequence:Renewals: 90 day"), "Renewals: 90 day");
assert.equal(sequenceNameFromSource("shop_out"), null, "shop-out mail is not a drip send");
assert.equal(sequenceNameFromSource("sequence:"), null, "an empty name is not a sequence");
assert.equal(sequenceNameFromSource(null), null);
assert.equal(sequenceNameFromSource(undefined), null);

// ── Calendar days, in the OPERATOR's zone ─────────────────────────────────
// The global caps use rolling 24h because that is how Gmail enforces. This cap
// is a calendar day, because "40 a day" means a day you can point at, and a
// chart of rolling windows has no bars to draw.
{
  // 03:30 UTC on the 12th is still the 11th in Toronto (UTC-4). Bucketing this
  // as the 12th would move a send into tomorrow's allowance and let the
  // sequence exceed its cap every single evening.
  assert.equal(dayKey("2026-08-12T03:30:00Z", TZ), "2026-08-11");
  assert.equal(dayKey("2026-08-12T12:00:00Z", TZ), "2026-08-12");

  // An unparseable stamp is null, NOT today. Defaulting to today would file
  // unknown sends into the live bucket -- the one the cap reads -- and make the
  // most load-bearing number on the chart the least trustworthy.
  assert.equal(dayKey("not-a-date", TZ), null);
  assert.equal(dayKey(null, TZ), null);
}

// ── The window includes empty days ────────────────────────────────────────
{
  const now = Date.parse("2026-08-11T15:00:00Z");
  const w = dayWindow(5, TZ, now);
  assert.equal(w.length, 5);
  assert.deepEqual(w, ["2026-08-07", "2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11"]);
  // Sorted oldest-first, and lexical order IS chronological order (en-CA), so
  // nothing downstream has to parse a date to sort bars.
  assert.deepEqual([...w].sort(), w);
}

// ── DST must not duplicate or skip a day ──────────────────────────────────
// A local day is 23 or 25 hours across a transition, so stepping back a fixed
// 86,400,000 ms from an arbitrary instant can format the same calendar day
// twice or skip one. A duplicate produces duplicate React keys in the chart; a
// skip silently drops a real day of sends.
{
  // Around both 2026 transitions in Toronto (spring forward Mar 8, fall back
  // Nov 1), sampled at several times of day including close to local midnight.
  for (const iso of [
    "2026-03-08T04:30:00Z",
    "2026-03-08T12:00:00Z",
    "2026-03-09T03:30:00Z",
    "2026-11-01T05:30:00Z",
    "2026-11-01T12:00:00Z",
    "2026-11-02T04:30:00Z",
  ]) {
    const w = dayWindow(14, TZ, Date.parse(iso));
    assert.equal(w.length, 14, `window must be 14 days at ${iso}, got ${w.length}`);
    assert.equal(new Set(w).size, 14, `no duplicate day at ${iso}: ${w.join(",")}`);
    assert.deepEqual([...w].sort(), w, `still chronological at ${iso}`);
    // The last bucket is TODAY — the one the cap reads.
    assert.equal(w[w.length - 1], dayKey(iso, TZ), `today must be the last bucket at ${iso}`);
  }

  // Zones far from UTC, where the anchor matters most. `${today}T12:00:00Z` is
  // 1am TOMORROW in Auckland during DST (UTC+13), which would end the window on
  // tomorrow and read today as zero — and today is the bucket the cap gates on,
  // so the sequence would send its whole allowance a second time.
  for (const tz of [
    "Pacific/Auckland",
    "Pacific/Kiritimati", // UTC+14, the furthest ahead there is
    "America/Los_Angeles",
    "Asia/Kolkata", // a half-hour offset
    "Pacific/Chatham", // +12:45, both far ahead AND off the hour
    "UTC",
  ]) {
    for (const iso of ["2026-11-01T05:30:00Z", "2026-03-08T04:30:00Z", "2026-06-15T23:45:00Z", "2026-06-16T00:15:00Z"]) {
      const w = dayWindow(30, tz, Date.parse(iso));
      assert.equal(w.length, 30, `${tz} @ ${iso}: window must be 30 days`);
      assert.equal(new Set(w).size, 30, `${tz} @ ${iso}: no duplicate day`);
      assert.deepEqual([...w].sort(), w, `${tz} @ ${iso}: chronological`);
      assert.equal(
        w[w.length - 1],
        dayKey(iso, tz),
        `${tz} @ ${iso}: the window must END on today — the bucket the cap reads`,
      );
    }
  }
}

// ── Bucketing ─────────────────────────────────────────────────────────────
{
  const now = Date.parse("2026-08-11T15:00:00Z");
  const rows = [
    { sequenceId: "s1", sequenceName: "Cold", at: "2026-08-11T13:00:00Z" },
    { sequenceId: "s1", sequenceName: "Cold", at: "2026-08-11T14:00:00Z" },
    { sequenceId: "s1", sequenceName: "Cold", at: "2026-08-10T14:00:00Z" },
    { sequenceId: "s2", sequenceName: "Renewals", at: "2026-08-11T14:00:00Z" },
    // A dry run is not a send.
    { sequenceId: "s1", sequenceName: "Cold", at: "2026-08-11T14:30:00Z", dryRun: true },
    // Outside the window.
    { sequenceId: "s1", sequenceName: "Cold", at: "2026-07-01T14:00:00Z" },
  ];
  const vols = bucketBySequenceDay(rows, { days: 3, timeZone: TZ, nowMs: now });

  assert.equal(vols.length, 2);
  assert.equal(vols[0].key, "s1", "busiest sequence first -- its cap is the one that matters");
  assert.equal(vols[0].today, 2, "the dry run must not count toward the day");
  assert.equal(vols[0].total, 3);
  assert.equal(vols[0].peak, 2);
  assert.equal(vols[0].days.length, 3, "every day in the window is present");
  // A day with no sends is a visible ZERO, not a missing bar. A gap reads as
  // "no data"; a zero reads as "nothing sent", and those are different findings.
  assert.equal(vols[0].days[0].count, 0);
  assert.equal(vols[0].days[0].day, "2026-08-09");
  assert.equal(vols[1].today, 1);
}

// ── ID is the key, name is only a fallback ────────────────────────────────
// agent_source has always been `sequence:<name>`, and names are editable. Keying
// on the name means renaming a sequence silently resets its day to zero -- a cap
// that quietly stops applying, which is worse than no cap.
{
  const now = Date.parse("2026-08-11T15:00:00Z");
  const rows = [
    // Same sequence, renamed halfway through the day.
    { sequenceId: "s1", sequenceName: "Old Name", at: "2026-08-11T12:00:00Z" },
    { sequenceId: "s1", sequenceName: "New Name", at: "2026-08-11T13:00:00Z" },
  ];
  const vols = bucketBySequenceDay(rows, { days: 1, timeZone: TZ, nowMs: now });
  assert.equal(vols.length, 1, "a rename must not split one sequence into two");
  assert.equal(vols[0].today, 2);

  // Historical rows carry no id. They must still be attributable to something
  // rather than silently dropped, so the name becomes the key.
  const legacy = bucketBySequenceDay(
    [{ sequenceName: "Cold", at: "2026-08-11T12:00:00Z" }],
    { days: 1, timeZone: TZ, nowMs: now },
  );
  assert.equal(legacy[0].key, "name:Cold");
  assert.equal(legacy[0].sequenceId, null);

  // A row attributable to NEITHER is dropped, not filed under a blank key.
  assert.equal(bucketBySequenceDay([{ at: "2026-08-11T12:00:00Z" }], { days: 1, timeZone: TZ, nowMs: now }).length, 0);
}

// ── A partly-stamped history is ONE sequence, not two ─────────────────────
// Found by running the real rules over production, not by a fixture: 119 of
// 183 rows carried metadata.sequence_id and 64 did not, because id stamping
// began partway through the retained history. Keying each row on whatever it
// happened to carry split ONE sequence into two chart lines — and split the
// cap's counter with it, so a sequence capped at 40 could send 40 under the id
// key and 40 more under the name key.
{
  const now = Date.parse("2026-08-11T15:00:00Z");
  const vols = bucketBySequenceDay(
    [
      { sequenceId: "s1", sequenceName: "Nag", at: "2026-08-11T12:00:00Z" }, // stamped
      { sequenceName: "Nag", at: "2026-08-11T13:00:00Z" }, // older, unstamped
      { sequenceName: "Nag", at: "2026-08-10T13:00:00Z" },
    ],
    { days: 2, timeZone: TZ, nowMs: now },
  );
  assert.equal(vols.length, 1, "one sequence must render as one row");
  assert.equal(vols[0].sequenceId, "s1", "and under its DURABLE key, so the cap finds it");
  assert.equal(vols[0].today, 2, "unstamped sends count toward the same day");
  assert.equal(vols[0].total, 3);
}

// ...but an AMBIGUOUS name is never merged. If one name has belonged to two
// sequences, guessing would attribute one sequence's mail to another — worse
// than an extra row a human can recognise.
{
  const now = Date.parse("2026-08-11T15:00:00Z");
  const vols = bucketBySequenceDay(
    [
      { sequenceId: "s1", sequenceName: "Shared", at: "2026-08-11T12:00:00Z" },
      { sequenceId: "s2", sequenceName: "Shared", at: "2026-08-11T12:30:00Z" },
      { sequenceName: "Shared", at: "2026-08-11T13:00:00Z" }, // which one? unknowable
    ],
    { days: 1, timeZone: TZ, nowMs: now },
  );
  assert.equal(vols.length, 3, "an ambiguous name is left alone, not guessed at");
  assert.ok(vols.some((v) => v.key === "name:Shared"));
}

// ── Only an EXPLICIT dry run is excluded ──────────────────────────────────
// Matching governor.ts. A second sender (the VPS send_gateway) wrote 105 emails
// over 30 days without a dry_run key; treating "absent" as a dry run made those
// invisible to the cap. An unknown writer must make the number BIGGER.
{
  const now = Date.parse("2026-08-11T15:00:00Z");
  const rows = [
    { sequenceId: "s1", at: "2026-08-11T12:00:00Z" }, // no dryRun key at all
    { sequenceId: "s1", at: "2026-08-11T12:30:00Z", dryRun: false },
    { sequenceId: "s1", at: "2026-08-11T13:00:00Z", dryRun: true },
  ];
  assert.equal(bucketBySequenceDay(rows, { days: 1, timeZone: TZ, nowMs: now })[0].today, 2);
}

// ── The cap value ─────────────────────────────────────────────────────────
assert.deepEqual(parseSequenceDailyCap(null), { ok: true, value: null });
assert.deepEqual(parseSequenceDailyCap(""), { ok: true, value: null }, "an empty box means no cap");
assert.deepEqual(parseSequenceDailyCap(undefined), { ok: true, value: null });
assert.deepEqual(parseSequenceDailyCap(40), { ok: true, value: 40 });
assert.deepEqual(parseSequenceDailyCap("40"), { ok: true, value: 40 });

// ZERO IS NOT NULL. It means "send nothing from this sequence" -- a pause an
// operator may want without disabling the sequence and losing its enrolments.
// Coercing it to null would turn "stop" into "unlimited", the worst available
// misreading of this box.
assert.deepEqual(parseSequenceDailyCap(0), { ok: true, value: 0 });
assert.deepEqual(parseSequenceDailyCap("0"), { ok: true, value: 0 });
assert.notEqual(parseSequenceDailyCap(0).ok && parseSequenceDailyCap(0).value, null);

// Whitespace is EMPTY, not zero. Checking `=== ""` before trimming let " "
// fall through to Number(" ".trim()) === 0 — a box that looks blank becoming
// "send nothing from this sequence", the exact inversion this guards against.
assert.deepEqual(parseSequenceDailyCap(" "), { ok: true, value: null });
assert.deepEqual(parseSequenceDailyCap("   \t "), { ok: true, value: null });

assert.equal(parseSequenceDailyCap(-1).ok, false);
assert.equal(parseSequenceDailyCap(2.5).ok, false, "half an email is not a thing");
assert.equal(parseSequenceDailyCap("abc").ok, false);
assert.equal(parseSequenceDailyCap(MAX_SEQUENCE_DAILY_CAP + 1).ok, false, "a typo guard, not a safety limit");
assert.equal(parseSequenceDailyCap(MAX_SEQUENCE_DAILY_CAP).ok, true);

// ── Remaining, and the block ──────────────────────────────────────────────
assert.equal(sequenceRemaining(5, 40), 35);
assert.equal(sequenceRemaining(45, 40), 0, "never negative");
assert.equal(sequenceRemaining(5, null), null, "uncapped is UNKNOWN remaining, not zero");
assert.equal(sequenceRemaining(5, undefined), null);

assert.equal(sequenceCapReached(39, 40), false);
assert.equal(sequenceCapReached(40, 40), true, "the cap is the count you may not exceed");
assert.equal(sequenceCapReached(41, 40), true);
assert.equal(sequenceCapReached(0, 0), true, "a cap of 0 blocks immediately");
// The default must be inert. Every existing sequence has no cap, so this ships
// changing nothing.
assert.equal(sequenceCapReached(9999, null), false);
assert.equal(sequenceCapReached(9999, undefined), false);

// ── Joining volume to the configured sequences ────────────────────────────
{
  const now = Date.parse("2026-08-11T15:00:00Z");
  const vols = bucketBySequenceDay(
    [
      { sequenceId: "s1", sequenceName: "Cold", at: "2026-08-11T12:00:00Z" },
      { sequenceId: "s1", sequenceName: "Cold", at: "2026-08-11T13:00:00Z" },
      // A sequence that no longer exists, but whose mail reached real people.
      { sequenceId: "gone", sequenceName: "Deleted One", at: "2026-08-11T12:00:00Z" },
    ],
    { days: 2, timeZone: TZ, nowMs: now },
  );

  const rows = joinVolumeToSequences(
    [
      { id: "s1", name: "Cold", enabled: true, daily_email_cap: 40 },
      // Configured but silent. Must still appear, at zero: "this sequence sent
      // nothing today" is a finding, and the four-day dispatcher outage in
      // August looked exactly like this with no surface saying so.
      { id: "s2", name: "Quiet", enabled: true, daily_email_cap: null },
    ],
    vols,
  );

  assert.equal(rows.length, 3, "configured sequences AND orphaned volume both appear");
  assert.equal(rows[0].name, "Cold", "busiest first");
  assert.equal(rows[0].cap, 40);
  assert.equal(rows[0].volume?.today, 2);

  const quiet = rows.find((r) => r.name === "Quiet");
  assert.ok(quiet, "a sequence with no sends is still listed");
  assert.equal(quiet.volume, null);
  assert.equal(quiet.cap, null);

  // Mail that went out is mail that went out. Hiding it would make this chart
  // disagree with the brand ceiling for reasons nobody could see.
  const orphan = rows.find((r) => r.name === "Deleted One");
  assert.ok(orphan, "volume with no matching sequence is shown, not swallowed");
  assert.equal(orphan.sequenceId, null, "and is not editable, because there is nothing to edit");
}

// ── A rename must not steal another sequence's history ────────────────────
// Matching on name first would attach a renamed sequence's sends to whichever
// OTHER sequence now happens to hold that name.
{
  const now = Date.parse("2026-08-11T15:00:00Z");
  const vols = bucketBySequenceDay(
    [{ sequenceId: "s1", sequenceName: "Old Name", at: "2026-08-11T12:00:00Z" }],
    { days: 1, timeZone: TZ, nowMs: now },
  );
  const rows = joinVolumeToSequences(
    [
      { id: "s1", name: "Renamed", enabled: true },
      { id: "s2", name: "Old Name", enabled: true },
    ],
    vols,
  );
  const renamed = rows.find((r) => r.sequenceId === "s1");
  const impostor = rows.find((r) => r.sequenceId === "s2");
  assert.equal(renamed?.volume?.today, 1, "the id owns its history through a rename");
  assert.equal(impostor?.volume, null, "the sequence that merely inherited the name gets nothing");
}

// ══ THE GATE ═══════════════════════════════════════════════════════════════

const TENANT = "t1";
function budget(over: Partial<EmailBudget> = {}): EmailBudget {
  return {
    dailyRemaining: { sunbiz: 100, bluerise: 100 },
    hourlyRemaining: { sunbiz: 100, bluerise: 100 },
    perLeadSent7d: new Map(),
    perLeadCap: 99,
    perSequenceSentToday: new Map(),
    perSequenceCap: new Map(),
    perSequenceDegraded: new Set<string>(),
    degraded: false,
    perLeadDegraded: false,
    ...over,
  };
}
const seq = { tenantId: TENANT, id: "s1", name: "Cold" };

// ── Uncapped is the default, and it changes nothing ───────────────────────
// Every existing sequence has no cap, so this whole feature must ship inert.
{
  const b = budget({ perSequenceSentToday: new Map([[`${TENANT}|s1`, 9999]]) });
  assert.equal(emailGateReason(b, "lead-1", "sunbiz", "follow_up", seq), null);
  // Omitting the sequence entirely is the pre-2026-08-11 call shape.
  assert.equal(emailGateReason(b, "lead-1", "sunbiz", "follow_up"), null);
}

// ── The cap blocks AT the cap, not after it ───────────────────────────────
{
  const at = budget({
    perSequenceCap: new Map([[`${TENANT}|s1`, 40]]),
    perSequenceSentToday: new Map([[`${TENANT}|s1`, 40]]),
  });
  assert.equal(emailGateReason(at, "lead-1", "sunbiz", "follow_up", seq), "sequence_daily_cap");

  const under = budget({
    perSequenceCap: new Map([[`${TENANT}|s1`, 40]]),
    perSequenceSentToday: new Map([[`${TENANT}|s1`, 39]]),
  });
  assert.equal(emailGateReason(under, "lead-1", "sunbiz", "follow_up", seq), null);

  // A cap of 0 stops the sequence dead without disabling it or losing enrolments.
  const zero = budget({ perSequenceCap: new Map([[`${TENANT}|s1`, 0]]) });
  assert.equal(emailGateReason(zero, "lead-1", "sunbiz", "follow_up", seq), "sequence_daily_cap");
}

// ── Tenant namespacing ────────────────────────────────────────────────────
// A dispatch batch can span tenants; executor.ts has been corrected for this
// twice already. A sequence id is a uuid and would survive a shared map, but a
// NAME is not unique: two tenants with a "Cold Outreach" would share one
// counter and one would silently eat the other's daily allowance.
{
  const b = budget({
    perSequenceCap: new Map([["t2|name:Cold", 5]]),
    perSequenceSentToday: new Map([["t2|name:Cold", 99]]),
  });
  assert.equal(
    emailGateReason(b, "lead-1", "sunbiz", "follow_up", { tenantId: "t1", name: "Cold" }),
    null,
    "another tenant's exhausted cap must not block this tenant",
  );
  assert.equal(
    emailGateReason(b, "lead-1", "sunbiz", "follow_up", { tenantId: "t2", name: "Cold" }),
    "sequence_daily_cap",
  );
  // No tenant means no keys, rather than a global bucket everyone shares.
  assert.deepEqual(sequenceBudgetKeys({ id: "s1", name: "Cold" }), []);
  assert.deepEqual(sequenceBudgetKeys({ tenantId: "t1", id: "s1", name: "Cold" }), ["t1|s1", "t1|name:Cold"]);
}

// ── The name mirror covers rows written before id stamping ────────────────
{
  const b = budget({
    perSequenceCap: new Map([[`${TENANT}|name:Cold`, 10]]),
    perSequenceSentToday: new Map([[`${TENANT}|name:Cold`, 10]]),
  });
  assert.equal(
    emailGateReason(b, "lead-1", "sunbiz", "follow_up", { tenantId: TENANT, name: "Cold" }),
    "sequence_daily_cap",
    "a cap must still apply to sends attributable only by name",
  );
}

// ── A failed read holds ONLY capped sequences ─────────────────────────────
// Failing closed for everyone would stall the whole engine over a feature
// almost nothing uses yet. Failing closed where a human actually asked for a
// limit is the entire point of them having asked.
{
  const degraded = budget({
    perSequenceDegraded: new Set([TENANT]),
    perSequenceCap: new Map([[`${TENANT}|s1`, 40]]),
  });
  assert.equal(emailGateReason(degraded, "lead-1", "sunbiz", "follow_up", seq), "sequence_budget_unavailable");

  const uncappedDegraded = budget({ perSequenceDegraded: new Set([TENANT]) });
  assert.equal(
    emailGateReason(uncappedDegraded, "lead-1", "sunbiz", "follow_up", seq),
    null,
    "an uncapped sequence must not be held because a cap read failed",
  );

  // ...and ONE tenant's failed read must not halt another's. A batch spans
  // tenants, so a single boolean here would let one broken query stop email for
  // every capped sequence in the estate.
  const otherTenantBroken = budget({
    perSequenceDegraded: new Set(["t2"]),
    perSequenceCap: new Map([[`${TENANT}|s1`, 40]]),
  });
  assert.equal(
    emailGateReason(otherTenantBroken, "lead-1", "sunbiz", "follow_up", seq),
    null,
    "a healthy tenant keeps sending when a different tenant's read fails",
  );
}

// ── Brand ceilings still win ──────────────────────────────────────────────
// A per-sequence cap only ever makes a sequence send LESS. It can never
// authorise a send the brand ceiling refuses.
{
  const b = budget({
    dailyRemaining: { sunbiz: 0, bluerise: 100 },
    perSequenceCap: new Map([[`${TENANT}|s1`, 999]]),
  });
  assert.equal(emailGateReason(b, "lead-1", "sunbiz", "follow_up", seq), "daily_cap");
}

// ── consumeEmail increments EVERY key ─────────────────────────────────────
// The gate reads the id's count when there is one and the name mirror
// otherwise. Incrementing only one would let a run of sends in a single batch
// sail past a cap the next run then reports as already exceeded.
{
  const b = budget({ perSequenceCap: new Map([[`${TENANT}|s1`, 2]]) });
  consumeEmail(b, "lead-1", "sunbiz", seq);
  assert.equal(b.perSequenceSentToday.get(`${TENANT}|s1`), 1);
  assert.equal(b.perSequenceSentToday.get(`${TENANT}|name:Cold`), 1);
  assert.equal(emailGateReason(b, "lead-2", "sunbiz", "follow_up", seq), null);
  consumeEmail(b, "lead-2", "sunbiz", seq);
  assert.equal(
    emailGateReason(b, "lead-3", "sunbiz", "follow_up", seq),
    "sequence_daily_cap",
    "the cap must bite WITHIN one dispatch run, not only on the next",
  );
  // The other budgets are still decremented exactly as before.
  assert.equal(b.dailyRemaining.sunbiz, 98);
  assert.equal(b.perLeadSent7d.get("lead-1"), 1);
}

// ── The hold runs to the next CALENDAR day ────────────────────────────────
// A flat 24h would push each send later than the last and slowly drift the
// sequence out of business hours: 9am becomes 11am becomes 2pm, until it is
// mailing merchants at night.
{
  const DAY_MS = 86_400_000;
  const at = (iso: string) => msUntilNextLocalDay(Date.parse(iso), TZ);
  // 13:00 in Toronto leaves 11h.
  assert.equal(at("2026-08-11T17:00:00Z"), 11 * 3_600_000);
  // Just before local midnight, a small remainder — never a fresh full day.
  assert.ok(at("2026-08-12T03:50:00Z") <= 10 * 60_000);
  // Never zero: a hold that expires instantly spins the row through the
  // dispatcher for no benefit.
  assert.ok(at("2026-08-12T03:59:59Z") >= 60_000);
  assert.ok(at("2026-08-11T04:00:01Z") <= DAY_MS);

  const held = Date.parse(holdUntilIso("sequence_daily_cap")) - Date.now();
  assert.ok(held > 0 && held <= DAY_MS);
  // A failed READ is infrastructure, not a decision about this sequence, so it
  // retries within the hour rather than parking until tomorrow.
  const unavailable = Date.parse(holdUntilIso("sequence_budget_unavailable")) - Date.now();
  assert.ok(unavailable <= 3_600_000 + 5_000);
}

console.log("sequence-volume.test.ts — all assertions passed");
