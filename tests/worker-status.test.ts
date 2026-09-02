/**
 * tests/worker-status.test.ts — the worker tile must not lie about state.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two defects shipped past a green typecheck, because both were presentation
 * rules living inside a React component where nothing could execute them.
 *
 *   1. "Degraded — check logs" for a daemon the operator had switched off.
 *      fleet_watchdog.classify() keeps `disabled` distinct from `down` so a
 *      deliberate stop never pages anyone; the bridge then maps disabled onto
 *      the "degraded" health value, and the tile turned that into an alarm
 *      pointing at logs that do not exist. Live row at the time of writing:
 *        status="degraded", metadata.pm2_status="disabled by operator"
 *
 *   2. "last seen 7:31 PM" for a heartbeat from 18 May — 106 days earlier.
 *      toLocaleTimeString() prints no date, so a relic and a live outage
 *      rendered identically. That is what made four permanently-unreported
 *      workers read as a fresh incident.
 *
 * Both rules now live in lib/automations/worker-status.ts, and this file
 * executes them rather than reading them.
 *
 * Run: node --conditions=react-server --import tsx tests/worker-status.test.ts
 */

import assert from "node:assert/strict";

import {
  SUPERVISOR_DISABLED,
  countsTowardHealth,
  formatLastSeen,
  isOperatorStopped,
} from "../lib/automations/worker-status";

// ── 1. An operator stop is Off, not Degraded ──────────────────────────────
{
  // The exact shape the bridge wrote while bravo-ig-dm was stopped.
  assert.equal(
    isOperatorStopped({
      status: "degraded",
      metadata: {
        pm2_status: SUPERVISOR_DISABLED,
        supervisor: "fleet_watchdog",
        ident: "ig_dm_daemon.py",
      },
    }),
    true,
    "a daemon the operator stopped must read as Off",
  );
}

// ── 2. A REAL degradation must still read as degraded ─────────────────────
//
// The failure mode of fix #1 is over-reach: swallowing genuine faults into a
// reassuring "Off". Only the supervisor's own disabled marker may do that.
{
  assert.equal(
    isOperatorStopped({ status: "degraded", metadata: { pm2_status: "errored" } }),
    false,
    "a genuinely degraded daemon must NOT be relabelled Off",
  );
  assert.equal(
    isOperatorStopped({ status: "degraded", metadata: {} }),
    false,
    "degraded with no supervisor reading is not an operator stop",
  );
  assert.equal(
    isOperatorStopped({ status: "degraded", metadata: null }),
    false,
    "a missing metadata bag must not throw or read as Off",
  );
  // A stopped-reporting worker is forced to "down" server-side. Even carrying
  // a stale disabled marker it is NOT Off — nobody knows what it is doing.
  assert.equal(
    isOperatorStopped({ status: "down", metadata: { pm2_status: SUPERVISOR_DISABLED } }),
    false,
    "only a live degraded reading can mean Off",
  );
  assert.equal(
    isOperatorStopped({ status: "healthy", metadata: { pm2_status: SUPERVISOR_DISABLED } }),
    false,
    "a running daemon is never Off",
  );
}

// ── 3. last seen carries a date whenever it is not today ──────────────────
{
  const now = new Date("2026-09-02T19:00:00Z");

  // Today: time only. The common case stays short.
  const today = formatLastSeen(new Date("2026-09-02T18:30:00Z").toISOString(), now);
  assert.ok(
    !/\d{4}/.test(today.replace(/:\d\d/g, "")),
    `today's ping should carry no date, got ${today}`,
  );

  // The Skool daemon's real row. This is the regression: it used to render as
  // "7:31 PM", indistinguishable from twenty minutes ago.
  const relic = formatLastSeen("2026-05-18T23:31:48.529Z", now);
  assert.ok(
    /May/.test(relic),
    `a 106-day-old ping must name its date, got ${relic}`,
  );
  assert.notEqual(
    relic,
    new Date("2026-05-18T23:31:48.529Z").toLocaleTimeString(),
    "the relic must not render as a bare time",
  );

  // A previous year carries the year too.
  const older = formatLastSeen("2025-05-18T23:31:48.529Z", now);
  assert.ok(/2025/.test(older), `a prior-year ping must name the year, got ${older}`);

  // Today and the relic must never collide — the whole point of the fix.
  assert.notEqual(today, relic);
}

// ── 4. An unparseable timestamp shows itself, never "Invalid Date" ────────
{
  assert.equal(formatLastSeen("not-a-timestamp"), "not-a-timestamp");
  assert.equal(formatLastSeen(""), "");
}

// ── 5. The healthy/total pill must be able to read FULL ───────────────────
//
// Counting workers nobody intends to run here capped the board at 8/12 — its
// best possible score. An operator who learns that some red is normal stops
// reading the red that is not, and three genuinely dead daemons sat unnoticed
// behind exactly that number.
{
  const board = [
    { status: "healthy" as const },                                       // scheduler
    { status: "healthy" as const },                                       // bridge
    { status: "down" as const, not_expected_here: "Runs on the VPS" },     // email sender
    { status: "down" as const, not_expected_here: "Retired 2026-05-18" },  // skool
    { status: "archived" as const },
  ];
  const counted = board.filter(countsTowardHealth);
  assert.equal(counted.length, 2, "only workers meant to run here are counted");
  assert.equal(
    counted.filter((w) => w.status === "healthy").length,
    counted.length,
    "with both real workers healthy the pill must read FULL, not 2/4",
  );
}

// A genuinely dead worker is still counted. The point of the exclusion is to
// make real failures legible, not to hide them.
{
  assert.equal(countsTowardHealth({ status: "down" }), true,
    "a down worker with no reason string is a real outage and must count");
  assert.equal(countsTowardHealth({ status: "degraded" }), true,
    "a degraded worker must count");
  assert.equal(countsTowardHealth({ status: "healthy" }), true);
}

console.log("worker-status: all assertions passed");
