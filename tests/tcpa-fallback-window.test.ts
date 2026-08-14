/**
 * tests/tcpa-fallback-window.test.ts — an unmapped area code must eventually
 * SEND, not circle forever.
 *
 * THE BUG. When a phone's area code is not in the NANP map the executor cannot
 * prove it is daytime for the recipient, so it reschedules to 18:00 UTC — an
 * hour chosen because it is inside the 8am-9pm TCPA window for every US zone.
 * But the branch rescheduled UNCONDITIONALLY. The row came due at 18:00 UTC,
 * the area code was still unmapped, and it was pushed to the next 18:00 UTC.
 *
 * Measured in production 2026-08-14: 106 rows stuck, 98 of them created on
 * 2026-07-20. Twenty-five days. attempts still 0. Not one message ever sent,
 * with no error, no overdue row and nothing for a monitor to see. Computing a
 * safe hour and then refusing to send at it is the whole defect.
 *
 * These assertions pin the window arithmetic, because getting it wrong in the
 * other direction texts someone before 8am — which is the thing the fail-closed
 * behaviour was protecting against in the first place (audit H6, and the 17:00
 * UTC anchor that review HIGH-2 already caught once for being 07:00 in Hawaii).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkTcpaWindow } from "../lib/tcpa-window";

// ── US TERRITORIES MUST RESOLVE, not fall through to the safe hour ────────
// The 18:00 UTC anchor was justified as "inside 8am-9pm for every US zone",
// and that reasoning quietly meant every US STATE. It breaks in both
// directions for the territories: 18:00 UTC is 04:00 the next day in Guam and
// 07:00 in American Samoa, each on the wrong side of the 8am floor.
//
// Widening the window cannot fix it — Guam (UTC+10) and American Samoa
// (UTC-11) are 21 hours apart, so NO single UTC hour is inside the window for
// both. Mapping them does: a resolved zone never reaches the fallback and gets
// its own correct quiet hours. Codex caught this.
{
  const territories: Array<[string, string]> = [
    ["671", "Pacific/Guam"],
    ["670", "Pacific/Saipan"],
    ["684", "Pacific/Pago_Pago"],
    ["787", "America/Puerto_Rico"],
    ["939", "America/Puerto_Rico"],
    ["340", "America/St_Thomas"],
  ];
  for (const [areaCode, zone] of territories) {
    const c = checkTcpaWindow(`+1${areaCode}5550147`);
    assert.equal(c.usedFallback, false, `${areaCode} must resolve, not fall back to the safe hour`);
    assert.equal(c.timeZone, zone, `${areaCode} → ${zone}`);
  }

  // The arithmetic that makes a shared window impossible, asserted so nobody
  // "simplifies" the map away and reinstates the fallback for these.
  const at18Utc = new Date(Date.UTC(2026, 7, 14, 18, 0, 0));
  const localHour = (tz: string) =>
    parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(at18Utc), 10);
  assert.ok(localHour("Pacific/Guam") < 8, "18:00 UTC is pre-dawn in Guam");
  assert.ok(localHour("Pacific/Pago_Pago") < 8, "18:00 UTC is before 8am in American Samoa");
  assert.ok(localHour("America/Puerto_Rico") >= 8, "Puerto Rico would have been fine either way");
}

// The window as the executor defines it. Mirrored rather than imported because
// the executor is "server-only" and pulls the whole send stack with it.
const START = 18;
const END = 21;
const inside = (h: number) => h >= START && h < END;

// ── Every US zone must read as daytime across the whole window ────────────
// At UTC hour H a zone at UTC-N reads H-N locally. TCPA is [8, 21).
const US_ZONE_OFFSETS: Array<[string, number]> = [
  ["EDT", 4], ["EST", 5], ["CDT", 5], ["CST", 6], ["MDT", 6], ["MST", 7],
  ["PDT", 7], ["PST", 8], ["AKDT", 8], ["AKST", 9], ["HST", 10],
];
for (let h = START; h < END; h++) {
  for (const [zone, offset] of US_ZONE_OFFSETS) {
    const local = (h - offset + 24) % 24;
    assert.ok(
      local >= 8 && local < 21,
      `${h}:00 UTC is ${local}:00 in ${zone} — outside the 8am-9pm TCPA window`,
    );
  }
}

// ── The edges are the edges ───────────────────────────────────────────────
// 17:00 UTC is 07:00 in Hawaii, an hour before the floor. That exact mistake
// was shipped once and caught in review; it must not come back.
{
  const hawaiiAt = (h: number) => (h - 10 + 24) % 24;
  assert.equal(hawaiiAt(17), 7, "17:00 UTC really is 07:00 HST");
  assert.ok(!inside(17), "17:00 UTC must be OUTSIDE the window");
  assert.equal(hawaiiAt(START), 8, "the window opens exactly at the Hawaii floor");
  assert.ok(inside(START), "18:00 UTC is the first sendable hour");
  assert.ok(inside(END - 1), "20:00 UTC is still sendable");
  assert.ok(!inside(END), "21:00 UTC is past the window — the server-tz check downstream rejects it anyway");
}

// ── Outside the window we still wait ──────────────────────────────────────
// The fix must not become "send whenever". Overnight and morning UTC hours are
// the ones where an unmapped number could be pre-dawn somewhere.
for (const h of [0, 3, 6, 9, 12, 15, 17, 21, 22, 23]) {
  assert.equal(inside(h), false, `${h}:00 UTC must still reschedule`);
}

// ── The window is non-empty and long enough to drain a backlog ────────────
// A one-hour window plus a 5-minute tick and a per-run row cap would take days
// to clear 106 rows; three hours clears them in one afternoon.
assert.ok(END - START >= 3, "the window must be wide enough to drain a backlog in a day");

// ── The executor actually consults it ─────────────────────────────────────
// The arithmetic above is worthless if the branch still reschedules
// unconditionally, which is exactly what it did for twenty-five days.
{
  const exec = readFileSync(new URL("../lib/drips/executor.ts", import.meta.url), "utf8");
  assert.ok(
    exec.includes("if (tcpa.usedFallback && !insideSafeFallbackWindow())"),
    "the unmapped-timezone hold must be conditional on being outside the safe window",
  );
  assert.ok(
    !/if \(tcpa\.usedFallback\) \{\s*\n\s*return markRescheduled/.test(exec),
    "an unconditional reschedule here is the permanent loop",
  );
  assert.ok(exec.includes(`const SAFE_FALLBACK_UTC_START = ${START};`), "window start must match this test");
  assert.ok(exec.includes(`const SAFE_FALLBACK_UTC_END = ${END};`), "window end must match this test");
}

console.log("tcpa-fallback-window.test.ts — all assertions passed");
