/**
 * tests/worker-reporter-check.test.ts — the Health check that pages when
 * worker status stops reaching the dashboard (2026-09-24). Run:
 *   node --conditions=react-server --import tsx tests/worker-reporter-check.test.ts
 */

import assert from "node:assert/strict";
import { WORKER_REPORTER_CHECKS } from "../lib/health/worker-reporter-checks";
import { evaluate } from "../lib/health/checks-core";
import { recoveryDetail } from "../lib/health/runner";
import { pickLocalWorkerPairing } from "../lib/automations/worker-status";
import { WORKER_REPORTER_OFFLINE_REASON } from "../lib/automations/worker-status";
import { OASIS_SCRIPT_EXECUTOR } from "../lib/automations/tenant-script-lease";

const check = WORKER_REPORTER_CHECKS[0];
const NOW = Date.parse("2026-09-24T12:00:00Z");

type Rows = { pairing: unknown[] | null; reporter: unknown[] | null; error?: boolean; sourceId?: string | null };

/** Minimal stand-in for the two chained reads the check performs. */
function fakeDb(rows: Rows) {
  return {
    from(table: string) {
      let data = table === "bridge_pairings" ? rows.pairing : rows.reporter?.map((item) => ({
        ...(item as Record<string, unknown>),
        metadata: {
          ...((item as { metadata?: Record<string, unknown> }).metadata ?? {}),
          ...(rows.sourceId === null ? {} : { _source_pairing_id: rows.sourceId ?? "win" }),
        },
      }));
      const chain = {
        select: () => chain,
        eq: (field: string, value: string) => {
          if (table === "bridge_pairings" && field === "id") {
            data = data?.filter((item) => (item as { id?: string }).id === value);
          }
          // Rows without a user_id stand for CC's own computers.
          if (table === "bridge_pairings" && field === "user_id") {
            data = data?.filter((item) => {
              const owner = (item as { user_id?: string }).user_id;
              return owner === undefined || owner === value;
            });
          }
          return chain;
        },
        is: () => chain,
        order: () => chain,
        limit: async (n: number) => ({ data: data?.slice(0, n), error: rows.error ? { message: "boom" } : null }),
      };
      return chain;
    },
  } as never;
}

const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

async function run() {
  process.env.VERCEL_ENV = "production";
  const online = [{ id: "win", last_seen_at: minutesAgo(0.5) }];

  // Healthy reporter → 0.
  assert.equal(
    await check.observe(fakeDb({ pairing: online, reporter: [{ status: "healthy", last_ping_at: minutesAgo(1) }] }), "t", NOW),
    0,
  );
  // Fresh "down" row → failing (1). The heartbeat runs on this computer again
  // (2026-10-31), so the remedy names it instead of calling it retired.
  const failing = await check.observe(
    fakeDb({ pairing: online, reporter: [{ status: "down", metadata: { error: "x" }, last_ping_at: minutesAgo(1) }] }),
    "t",
    NOW,
  );
  assert.equal(failing, 1);
  const failingDescription = check.describe({ id: check.id, verdict: "failing", observed: 1, baseline: null, reason: "" });
  assert.match(failingDescription, /"Bridge heartbeat" \(claude-bridge-ping\)/);
  assert.doesNotMatch(failingDescription, /stay off by plan/);
  // Bridge online but the fleet report is 30 minutes old → silent (2).
  assert.equal(
    await check.observe(fakeDb({ pairing: online, reporter: [{ status: "healthy", last_ping_at: minutesAgo(30) }] }), "t", NOW),
    2,
  );
  const silentDescription = check.describe({ id: check.id, verdict: "failing", observed: 2, baseline: null, reason: "" });
  assert.match(silentDescription, /Restart "Bridge heartbeat" \(claude-bridge-ping\)/);
  assert.doesNotMatch(silentDescription, /stay off by plan/);
  // One missed tick (6 min) is NOT an alert — the threshold is 10 minutes.
  assert.equal(
    await check.observe(fakeDb({ pairing: online, reporter: [{ status: "healthy", last_ping_at: minutesAgo(6) }] }), "t", NOW),
    0,
  );
  // Bridge itself offline → not this check's alarm.
  assert.equal(
    await check.observe(
      fakeDb({ pairing: [{ id: "win", last_seen_at: minutesAgo(60) }], reporter: [{ status: "healthy", last_ping_at: minutesAgo(60) }] }),
      "t",
      NOW,
    ),
    0,
  );
  assert.equal((await check.observeDetailed!(
    fakeDb({ pairing: [{ id: "win", last_seen_at: minutesAgo(60) }], reporter: [{ status: "healthy", last_ping_at: minutesAgo(60) }] }),
    "t", NOW,
  )).reason, WORKER_REPORTER_OFFLINE_REASON);
  // Daemon VPS (`oasis-daemon-1 (Linux)`) and Mac online while CCPC (Windows) is off →
  // not this check's alarm (neither Linux nor Mac runs the Windows fleet_watchdog).
  assert.equal(
    await check.observe(
      fakeDb({
        pairing: [
          { id: "vps", label: "oasis-daemon-1 (Linux)", last_seen_at: minutesAgo(0.2) },
          { id: "mac", label: "192.168.11.27 (Mac)", last_seen_at: minutesAgo(0.4) },
          { id: "win", label: "CCPC (Windows)", last_seen_at: minutesAgo(60) },
        ],
        reporter: [{ status: "healthy", last_ping_at: minutesAgo(60) }],
      }),
      "t",
      NOW,
    ),
    0,
  );
  // CCPC (Windows) online behind the VPS pairing, with a stale fleet report → silent (2).
  assert.equal(
    await check.observe(
      fakeDb({
        pairing: [
          { id: "vps", label: "oasis-daemon-1 (Linux)", last_seen_at: minutesAgo(0.1) },
          { id: "win", label: "CCPC (Windows)", last_seen_at: minutesAgo(0.5) },
        ],
        reporter: [{ status: "healthy", last_ping_at: minutesAgo(30) }],
      }),
      "t",
      NOW,
    ),
    2,
  );
  assert.deepEqual(
    pickLocalWorkerPairing([
      { label: "oasis-daemon-1 (Linux)", id: "vps" },
      { label: "CC's MacBook Pro (Mac)", id: "mac" },
      { label: "CCPC (Windows)", id: "win" },
    ], "win"),
    { label: "CCPC (Windows)", id: "win" },
  );
  // The operator can rename any device. A new Mac label, or ten newer remote
  // pairings, cannot impersonate the Windows reporter's authenticated ID.
  assert.deepEqual(
    pickLocalWorkerPairing([
      { label: "CC's laptop", id: "mac" },
      ...Array.from({ length: 11 }, (_, i) => ({ label: "daemon", id: `remote-${i}` })),
      { label: "Any name at all", id: "win" },
    ], "win"),
    { label: "Any name at all", id: "win" },
  );
  assert.equal(pickLocalWorkerPairing([{ label: "CCPC (Windows)", id: "win" }], null), null);
  assert.equal(await check.observe(fakeDb({ pairing: online, reporter: [{ status: "healthy", last_ping_at: minutesAgo(1) }], sourceId: null }), "t", NOW), null,
    "an unattributed reporter is unverified, never a false all-clear");
  assert.equal(await check.observe(fakeDb({ pairing: [
    ...Array.from({ length: 11 }, (_, i) => ({ id: `remote-${i}`, label: "My PC", last_seen_at: minutesAgo(0.1) })),
    { id: "win", label: "CC's MacBook", last_seen_at: minutesAgo(0.5) },
  ], reporter: [{ status: "healthy", last_ping_at: minutesAgo(30) }] }), "t", NOW), 2,
    "filter by the authenticated ID before the database limit");
  // Only CC's own computers are graded (CodeRabbit, #805): a report stamped by
  // another member's online connector never makes CC's fleet read "silent".
  assert.equal(await check.observe(fakeDb({
    pairing: [{ id: "member-connector", user_id: "someone-else", last_seen_at: minutesAgo(0.2) }],
    reporter: [{ status: "healthy", last_ping_at: minutesAgo(600) }],
    sourceId: "member-connector",
  }), "t", NOW), 0);
  // ...while CC's own stamped computer, online with a stale report, still pages.
  assert.equal(await check.observe(fakeDb({
    pairing: [{ id: "win", user_id: OASIS_SCRIPT_EXECUTOR.userId, last_seen_at: minutesAgo(0.2) }],
    reporter: [{ status: "healthy", last_ping_at: minutesAgo(600) }],
  }), "t", NOW), 2);
  // Recovery wording uses check.describe(ok) instead of raw "none observed".
  const okResult = evaluate(check.id, check.rule, 0, []);
  assert.equal(
    recoveryDetail(check, okResult),
    "background-worker status is reaching the dashboard (or the bridge is offline, which its own banner reports).",
  );
  assert.equal(
    recoveryDetail({ describe: (r) => `${r.observed} SMS rejected by the carrier` }, okResult),
    "Back to normal (0 issues observed).",
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
