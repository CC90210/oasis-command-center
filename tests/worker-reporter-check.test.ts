/**
 * tests/worker-reporter-check.test.ts — the Health check that pages when
 * worker status stops reaching the dashboard (2026-09-24). Run:
 *   node --conditions=react-server --import tsx tests/worker-reporter-check.test.ts
 */

import assert from "node:assert/strict";
import { WORKER_REPORTER_CHECKS } from "../lib/health/worker-reporter-checks";

const check = WORKER_REPORTER_CHECKS[0];
const NOW = Date.parse("2026-09-24T12:00:00Z");

type Rows = { pairing: unknown[] | null; reporter: unknown[] | null; error?: boolean };

/** Minimal stand-in for the two chained reads the check performs. */
function fakeDb(rows: Rows) {
  return {
    from(table: string) {
      const data = table === "bridge_pairings" ? rows.pairing : rows.reporter;
      const chain = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        order: () => chain,
        limit: async () => ({ data, error: rows.error ? { message: "boom" } : null }),
      };
      return chain;
    },
  } as never;
}

const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

async function run() {
  process.env.VERCEL_ENV = "production";
  const online = [{ last_seen_at: minutesAgo(0.5) }];

  // Healthy reporter → 0.
  assert.equal(
    await check.observe(fakeDb({ pairing: online, reporter: [{ status: "healthy", last_ping_at: minutesAgo(1) }] }), "t", NOW),
    0,
  );
  // Fresh "down" row → failing (1), and the description names the remedy.
  const failing = await check.observe(
    fakeDb({ pairing: online, reporter: [{ status: "down", metadata: { error: "x" }, last_ping_at: minutesAgo(1) }] }),
    "t",
    NOW,
  );
  assert.equal(failing, 1);
  assert.match(check.describe({ id: check.id, verdict: "failing", observed: 1, baseline: null, reason: "" }), /claude-bridge-ping/);
  // Bridge online but the fleet report is 30 minutes old → silent (2).
  assert.equal(
    await check.observe(fakeDb({ pairing: online, reporter: [{ status: "healthy", last_ping_at: minutesAgo(30) }] }), "t", NOW),
    2,
  );
  // One missed tick (6 min) is NOT an alert — the threshold is 10 minutes.
  assert.equal(
    await check.observe(fakeDb({ pairing: online, reporter: [{ status: "healthy", last_ping_at: minutesAgo(6) }] }), "t", NOW),
    0,
  );
  // Bridge itself offline → not this check's alarm.
  assert.equal(
    await check.observe(
      fakeDb({ pairing: [{ last_seen_at: minutesAgo(60) }], reporter: [{ status: "healthy", last_ping_at: minutesAgo(60) }] }),
      "t",
      NOW,
    ),
    0,
  );
  // A failed read is check_broken (null), never a quiet OK.
  assert.equal(await check.observe(fakeDb({ pairing: online, reporter: [], error: true }), "t", NOW), null);

  // Outside production the check never grades the operator's fleet.
  process.env.VERCEL_ENV = "preview";
  assert.equal(
    await check.observe(fakeDb({ pairing: online, reporter: [{ status: "down", last_ping_at: minutesAgo(1) }] }), "t", NOW),
    0,
  );
  console.log("worker-reporter-check: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
