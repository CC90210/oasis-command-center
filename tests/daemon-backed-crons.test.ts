/**
 * tests/daemon-backed-crons.test.ts — the parked cron twin stays parked.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Instagram DM setter runs as the `bravo-ig-dm` PM2 process. Its cron row,
 * "Instagram DM Closer", sits at `is_active = 0` deliberately: two live runners
 * on one script answer every prospect twice, which happened on 2026-08-20, and
 * the daemon reads that flag at startup and REFUSES to boot when it is armed
 * (scripts/integrations/ig_dm_daemon.py:cron_row_is_armed).
 *
 * Which made the Automations tab a loaded gun. It rendered the row from
 * `is_active`, so the operator's most important automation read OFF while it
 * was answering real people — and flipping the toggle to "fix" that would have
 * written 1, re-arming the scheduler's copy AND bricking the daemon's next
 * restart. One click, setter offline, prospects double-messaged on the way out.
 *
 * The fix is only a fix if arming is IMPOSSIBLE rather than merely unusual, so
 * this file executes the guard instead of reading it, and pins the two ways the
 * hole could quietly reopen: the UI toggling through PATCH again, or the API
 * running its write before the guard.
 *
 * Run: npx tsx tests/daemon-backed-crons.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DAEMON_BACKED_CRONS,
  DAEMON_HEALTH_STALE_MS,
  daemonBackedCronForName,
  deriveDaemonState,
  isDaemonBackedCronName,
} from "../lib/automations/daemon-backed-crons";
import { daemonToggleRefusal } from "../lib/automations/daemon-cron-guard";

// ── 1. The guard refuses the write that takes the setter offline ───────────
{
  const refusal = daemonToggleRefusal({ ok: true, name: "Instagram DM Closer" });
  assert.ok(refusal, "arming the Instagram DM Closer row must be refused");
  assert.equal(refusal.status, 409);
  assert.equal(refusal.body.error, "daemon_backed_cron_not_toggleable");
  assert.match(
    String(refusal.body.message),
    /bravo-ig-dm/,
    "the refusal must name the process the operator should use instead",
  );
}

// Name matching cannot be defeated by casing or stray whitespace — the row's
// name is operator-editable text, and a near-miss here means the guard silently
// stops guarding.
for (const variant of ["instagram dm closer", "  Instagram DM Closer  ", "INSTAGRAM DM CLOSER"]) {
  assert.ok(
    daemonToggleRefusal({ ok: true, name: variant }),
    `"${variant}" must still be recognised as the daemon-backed row`,
  );
}

// ── 2. Ordinary rows are untouched ─────────────────────────────────────────
//
// A guard that blocks everything is not a guard, it is an outage. Empire crons
// that really do run on the shared scheduler must keep their toggle.
for (const name of ["Daily Brief", "Stripe Revenue Sync", "OASIS Auto-Score Leads", ""]) {
  assert.equal(
    daemonToggleRefusal({ ok: true, name }),
    null,
    `"${name}" is a normal scheduler row and must stay toggleable`,
  );
}
// An absent row falls through to the UPDATE, which 404s on its own.
assert.equal(daemonToggleRefusal({ ok: true, name: null }), null);

// ── 3. Unreadable is not the same as safe ──────────────────────────────────
//
// The lookup failing tells us nothing about the row. Treating that as "not
// daemon-backed" would let a transient DB error open the exact path this guard
// closes — so it fails closed, the same way the daemon treats an unreadable
// registry as "do not start".
{
  const refusal = daemonToggleRefusal({ ok: false });
  assert.ok(refusal, "an unreadable lookup must refuse the write, not allow it");
  assert.equal(refusal.status, 503);
  assert.equal(refusal.body.error, "daemon_guard_unreadable");
}

// ── 4. The API runs the guard BEFORE it writes anything ────────────────────
//
// The pure function above can only refuse what it is asked about. If the route
// ever writes first and checks second, every test above passes while the flag
// still lands.
{
  const route = readFileSync("app/api/cron-jobs/[id]/route.ts", "utf8");
  const patchBody = route.slice(route.indexOf("export async function PATCH"));
  const guardAt = patchBody.indexOf("refuseDaemonBackedToggle(db");
  const firstUpdateAt = patchBody.indexOf(".update(");
  assert.ok(guardAt > -1, "PATCH must call refuseDaemonBackedToggle");
  assert.ok(firstUpdateAt > -1, "PATCH must still perform an update");
  assert.ok(
    guardAt < firstUpdateAt,
    "the daemon guard must run BEFORE the first .update() in PATCH — checking after the " +
      "write has already landed protects nothing",
  );
  // Both lanes are covered: the empire fallback further down writes is_active
  // on cron_jobs, and one guard call before both is what makes that safe.
  assert.ok(
    patchBody.includes("is_active: body.enabled"),
    "sanity: the empire fallback still writes is_active, so the guard above it is load-bearing",
  );
}

// ── 5. The UI never PATCHes a daemon-backed row ────────────────────────────
//
// Server-side refusal is the backstop, not the plan. If the toggle kept calling
// PATCH the operator would just get a 409 every time they tried to start their
// setter — correct, and useless. The row's toggle drives pm2 instead.
{
  const ui = readFileSync("components/automations/CronJobsManager.tsx", "utf8");
  const toggle = ui.slice(ui.indexOf("async function toggleEnabled"));
  const guardAt = toggle.indexOf("if (job.daemon)");
  const patchAt = toggle.indexOf("method: \"PATCH\"");
  assert.ok(guardAt > -1, "toggleEnabled must short-circuit daemon-backed rows");
  assert.ok(patchAt > -1, "toggleEnabled must still PATCH ordinary rows");
  assert.ok(
    guardAt < patchAt,
    "toggleEnabled must return for daemon-backed rows before it reaches the PATCH",
  );
  assert.ok(
    ui.includes("runWorkerAction("),
    "the daemon-backed toggle must drive pm2 through the shared worker-control path",
  );
}

// ── 6. Every daemon-backed cron is a worker the panel actually lists ───────
//
// Blocker that hid `bravo-ig-dm` for the whole time it has been running: the
// background-workers route filters health rows against EXPECTED_WORKERS, so a
// daemon missing from that list is dropped even while it reports in every 60s.
// A cron row pointing at a service nobody lists would be status-less by
// construction.
{
  const workersRoute = readFileSync("app/api/automations/background-workers/route.ts", "utf8");
  for (const def of DAEMON_BACKED_CRONS) {
    assert.ok(
      workersRoute.includes(`"${def.service}"`),
      `${def.service} backs the "${def.cronName}" row but is not in EXPECTED_WORKERS, so its ` +
        "health row would be filtered out and the row could never show a status",
    );
  }
}

// ── 7. A stale reading is never reported as running ────────────────────────
//
// The panel's whole purpose is telling the truth about background processes.
// A twenty-minute-old "healthy" is not a measurement, and showing it as green
// is the same defect as the OFF toggle wearing the opposite colour.
{
  const def = daemonBackedCronForName("Instagram DM Closer");
  assert.ok(def, "the Instagram row must resolve to a daemon definition");
  const now = Date.parse("2026-08-21T20:00:00.000Z");
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

  assert.equal(
    deriveDaemonState(def, { status: "healthy", last_ping_at: iso(30_000) }, now).state,
    "running",
    "a fresh healthy reading is the one case that may say running",
  );
  assert.equal(
    deriveDaemonState(def, { status: "down", last_ping_at: iso(30_000) }, now).state,
    "stopped",
  );

  const stale = deriveDaemonState(
    def,
    { status: "healthy", last_ping_at: iso(DAEMON_HEALTH_STALE_MS + 60_000) },
    now,
  );
  assert.equal(stale.state, "unknown", "a stale healthy must degrade to unknown, not stay green");
  assert.equal(stale.stale, true);
  assert.equal(
    stale.last_ping_at,
    iso(DAEMON_HEALTH_STALE_MS + 60_000),
    "the last-seen time must survive so the operator can judge how old the reading is",
  );

  // Nothing reported at all, and a timestamp we cannot parse. Both are the
  // absence of a measurement and both must read as such.
  assert.equal(deriveDaemonState(def, null, now).state, "unknown");
  assert.equal(deriveDaemonState(def, { status: null, last_ping_at: null }, now).state, "unknown");
  assert.equal(
    deriveDaemonState(def, { status: "healthy", last_ping_at: "not-a-date" }, now).state,
    "unknown",
    "an unparseable timestamp is not a fresh one",
  );
}

// ── 8. Registry sanity ─────────────────────────────────────────────────────
{
  assert.ok(DAEMON_BACKED_CRONS.length > 0);
  for (const def of DAEMON_BACKED_CRONS) {
    assert.ok(isDaemonBackedCronName(def.cronName));
    assert.equal(
      def.service,
      `pm2.${def.processName}`,
      "the health key and the pm2 name must agree, or Start/Stop drives a different process " +
        "than the status came from",
    );
    // The pm2 name reaches a shell as `pm2 <action> <name>`. runWorkerAction
    // allowlists the characters; a registry entry that could not survive that
    // check would be a control button that always fails.
    assert.match(def.processName, /^[a-z0-9._-]+$/i);
  }
}

console.log("daemon-backed-crons: all assertions passed");
