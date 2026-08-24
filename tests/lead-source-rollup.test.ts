import assert from "node:assert/strict";
import {
  clampDays,
  bucketDay,
  denseDayAxis,
  percentages,
  rollup,
  emptyTotals,
  DEFAULT_DAYS,
  MAX_DAYS,
  MIN_DAYS,
  type LeadRow,
} from "../lib/metrics/lead-source-rollup";
import { LEAD_SOURCE_KEY } from "../lib/forms/lead-source";

// The two quiet-wrong failure modes this pins:
//   A. Day buckets computed in UTC instead of the operator's timezone, which
//      silently moves every evening lead to the next day.
//   B. Percentages that do not sum to 100, which renders as a visibly broken
//      donut.

// ── clampDays: untrusted input, never rejected ───────────────────────────────

assert.equal(clampDays(null), DEFAULT_DAYS, "no param falls back to the default");
assert.equal(clampDays(undefined), DEFAULT_DAYS);
assert.equal(clampDays(""), DEFAULT_DAYS);
assert.equal(clampDays("banana"), DEFAULT_DAYS, "garbage falls back, it does not 400");
assert.equal(clampDays("7"), 7);
assert.equal(clampDays("0"), MIN_DAYS, "below the floor clamps up");
assert.equal(clampDays("-30"), MIN_DAYS, "a negative window would invert the axis");
assert.equal(clampDays("100000"), MAX_DAYS, "an unbounded window would scan the whole table");
assert.equal(clampDays("30.9"), 30, "parseInt truncates rather than throwing");

// ── A. day bucketing happens in America/New_York, not UTC ────────────────────
// 2026-08-24T01:30:00Z is 2026-08-23 21:30 EDT. The rep worked that lead on the
// 23rd. Bucketing in UTC would file it under the 24th and the daily bars would
// disagree with what the rep remembers.

assert.equal(
  bucketDay("2026-08-24T01:30:00.000Z"),
  "2026-08-23",
  "a late-evening ET lead belongs to the ET day, not the UTC day",
);
assert.equal(
  bucketDay("2026-08-24T04:30:00.000Z"),
  "2026-08-24",
  "00:30 ET is already the new ET day",
);
assert.equal(bucketDay("2026-08-24T16:00:00.000Z"), "2026-08-24", "midday is unambiguous");
assert.equal(bucketDay("not-a-date"), null, "an unparseable timestamp yields null, not a throw");
assert.equal(bucketDay(""), null);

// ── denseDayAxis: contiguous, oldest-first, no gaps ──────────────────────────

{
  const now = Date.parse("2026-08-24T16:00:00.000Z");
  const axis = denseDayAxis(5, now);
  assert.deepEqual(
    axis,
    ["2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24"],
    "the axis is contiguous and ends today",
  );
  assert.equal(new Set(axis).size, axis.length, "no duplicate days");
  assert.equal(denseDayAxis(1, now).length, 1);
  assert.equal(denseDayAxis(90, now).length, 90, "the max window produces 90 columns");
}

// ── B. percentages sum to exactly 100 ────────────────────────────────────────

assert.deepEqual(percentages(emptyTotals(), 0), emptyTotals(), "zero denominator is all zeros");

{
  // The classic naive-rounding failure: three equal thirds render 33.3 x 3 = 99.9.
  const p = percentages({ text: 1, dial: 1, unknown: 1 }, 3);
  const sum = p.text + p.dial + p.unknown;
  assert.equal(
    Math.round(sum * 10) / 10,
    100,
    `three equal shares must still sum to 100, got ${sum}`,
  );
}

for (const [t, d, u] of [
  [1, 1, 1],
  [1, 2, 0],
  [7, 3, 0],
  [1, 0, 0],
  [0, 0, 5],
  [333, 333, 334],
  [1, 999, 0],
  [17, 41, 3],
] as Array<[number, number, number]>) {
  const total = t + d + u;
  const p = percentages({ text: t, dial: d, unknown: u }, total);
  const sum = Math.round((p.text + p.dial + p.unknown) * 10) / 10;
  assert.equal(sum, 100, `percentages for ${t}/${d}/${u} must sum to 100, got ${sum}`);
  // Apportionment must never invert the ordering of the underlying counts.
  if (t > d) assert.equal(p.text >= p.dial, true, "a larger count must not get a smaller share");
}

{
  // A single non-zero bucket takes the whole ring.
  const p = percentages({ text: 4, dial: 0, unknown: 0 }, 4);
  assert.deepEqual(p, { text: 100, dial: 0, unknown: 0 });
}

// ── rollup: the fold ─────────────────────────────────────────────────────────

const AXIS = ["2026-08-22", "2026-08-23", "2026-08-24"];

{
  const rows: LeadRow[] = [
    { created_at: "2026-08-24T16:00:00.000Z", data: { [LEAD_SOURCE_KEY]: "text" } },
    { created_at: "2026-08-24T17:00:00.000Z", data: { [LEAD_SOURCE_KEY]: "text" } },
    { created_at: "2026-08-24T18:00:00.000Z", data: { [LEAD_SOURCE_KEY]: "dial" } },
    // 01:30Z on the 24th is 21:30 ET on the 23rd.
    { created_at: "2026-08-24T01:30:00.000Z", data: { [LEAD_SOURCE_KEY]: "dial" } },
    // Untagged: a link that lost its query string. Counted, never dropped.
    { created_at: "2026-08-23T16:00:00.000Z", data: { business_name: "Acme" } },
    // Legacy pre-migration lead: no data at all.
    { created_at: "2026-08-22T16:00:00.000Z", data: null },
  ];

  const r = rollup(rows, AXIS);

  assert.deepEqual(r.totals, { text: 2, dial: 2, unknown: 2 });
  assert.equal(r.counted, 6, "every dated in-window row is counted");
  assert.equal(r.undated, 0);
  assert.equal(r.outOfWindow, 0);

  assert.equal(r.daily.length, 3, "the daily series matches the axis exactly");
  assert.deepEqual(r.daily.map((d) => d.date), AXIS, "days come back oldest-first");

  const d24 = r.daily.find((d) => d.date === "2026-08-24")!;
  assert.deepEqual(
    { text: d24.text, dial: d24.dial, unknown: d24.unknown, total: d24.total },
    { text: 2, dial: 1, unknown: 0, total: 3 },
    "the 21:30 ET dial must NOT land on the 24th",
  );

  const d23 = r.daily.find((d) => d.date === "2026-08-23")!;
  assert.deepEqual(
    { text: d23.text, dial: d23.dial, unknown: d23.unknown, total: d23.total },
    { text: 0, dial: 1, unknown: 1, total: 2 },
    "it lands on the 23rd, alongside the untagged lead",
  );

  // The invariant that makes the chart trustworthy: the bars sum to the donut.
  const barSum = r.daily.reduce((s, d) => s + d.total, 0);
  assert.equal(barSum, r.counted, "daily totals must reconcile with the headline count");
  assert.equal(
    r.totals.text + r.totals.dial + r.totals.unknown,
    r.counted,
    "the three buckets must partition the counted set with no leakage",
  );
}

// ── rollup: rows that must NOT silently inflate or vanish ────────────────────

{
  const rows: LeadRow[] = [
    { created_at: null, data: { [LEAD_SOURCE_KEY]: "text" } }, // undated
    { created_at: "garbage", data: { [LEAD_SOURCE_KEY]: "text" } }, // unparseable
    { created_at: "2026-01-01T12:00:00.000Z", data: { [LEAD_SOURCE_KEY]: "dial" } }, // outside
    { created_at: "2026-08-23T16:00:00.000Z", data: { [LEAD_SOURCE_KEY]: "dial" } }, // kept
  ];
  const r = rollup(rows, AXIS);

  assert.equal(r.counted, 1, "only the in-window dated row counts");
  assert.equal(r.undated, 2, "undated and unparseable are reported, not hidden");
  assert.equal(r.outOfWindow, 1, "out-of-window rows are reported separately");
  assert.deepEqual(r.totals, { text: 0, dial: 1, unknown: 0 });
  assert.equal(
    r.daily.reduce((s, d) => s + d.total, 0),
    1,
    "excluded rows must not leak into any bar",
  );
}

// An empty result set still yields a full, zero-filled axis (no chart gaps).
{
  const r = rollup([], AXIS);
  assert.equal(r.counted, 0);
  assert.equal(r.daily.length, 3);
  assert.equal(r.daily.every((d) => d.total === 0), true, "every day present and zeroed");
  assert.deepEqual(percentages(r.totals, r.counted), emptyTotals());
}

console.log("lead-source-rollup: all assertions passed");
