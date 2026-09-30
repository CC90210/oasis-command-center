/**
 * OASIS's own background workers: the processes CC's machine supervises for
 * the OASIS workspace, keyed by their integrations_health service name.
 *
 * Moved out of app/api/automations/background-workers/route.ts (2026-09-30) so
 * three readers share one list instead of three copies drifting apart:
 *   - GET /api/automations/background-workers (the Automations board),
 *   - POST /api/automations/background-workers/control (the allowlist for
 *     Start/Stop/Restart, which now goes through the server for OASIS too:
 *     the bridge answers 401 to a browser since its bearer went on, 09-29),
 *   - lib/admin/system-health.ts (System health's "Background work" card).
 *
 * Mirrors ecosystem.config.js on the operator's machine. Adding a supervised
 * daemon there without adding it here means the board shows it as unknown.
 * Imported by server code only; no secrets, no fetch.
 */

import type { WorkerControlMode, WorkerRuntime, WorkerStatusSource } from "@/lib/automations/worker-status";

export type OasisWorker = {
  service: string;
  label: string;
  purpose: string;
  runtime?: WorkerRuntime;
  control_mode?: WorkerControlMode;
  status_source?: WorkerStatusSource;
  /** Rolling-deploy compatibility for the former PM2-only UI contract. */
  manageable_via_pm2?: boolean;
  archived_on?: string;
  archived_reason?: string;
  /**
   * Set when this worker is NOT supposed to be running on the operator's
   * machine. The string is the reason, shown on the tile.
   *
   * Retained for rolling compatibility. New rows use runtime="retired" as the
   * explicit source of truth instead of encoding lifecycle in prose.
   */
  not_expected_here?: string;
};

export const OASIS_WORKERS: OasisWorker[] = [
  {
    service: "pm2.bravo-scheduler",
    label: "Empire scheduler",
    purpose: "Polls cron_jobs every 60s on the operator's machine and executes due jobs.",
  },
  {
    // The setter. Absent from this list until 2026-08-21, which meant its
    // health row was filtered out of the response even while the bridge was
    // reporting it healthy every 60s — the operator's most important
    // background process was invisible on the page that exists to show
    // background processes. Its parked cron twin is wired up in
    // lib/automations/daemon-backed-crons.ts.
    service: "pm2.bravo-ig-dm",
    label: "Instagram DM setter",
    purpose: "Answers Instagram DMs on its own tick so a reply never queues behind the scheduler's batch jobs.",
  },
  {
    service: "pm2.bravo-telegram",
    label: "Telegram bridge",
    purpose: "Bridges Telegram messages to the chat backbone. Windows-default, Mac cold-standby.",
  },
  {
    service: "pm2.bravo-coord",
    label: "OASIS coordination bridge",
    purpose: "Group-scoped Telegram bridge for the shared OASIS boardroom (CC + Adon + Bravo + APEX). Separate bot token from the DM bridge.",
  },
  {
    service: "pm2.claude-bridge",
    label: "Local chat bridge",
    purpose: "localhost:9100 chat HTTP server — warm-pool Claude Code subprocess + tool proxy.",
  },
  {
    service: "pm2.claude-bridge-ping",
    label: "Bridge heartbeat + tenant cron poller",
    purpose: "Heartbeats to /api/bridge/ping every 60s and polls tenant_cron_jobs for due work.",
  },
  {
    service: "pm2.event-router",
    label: "Event router",
    purpose: "Tails Postgres agent_events into state/event_router.log — feeds /feed page.",
  },
  // Removed 2026-06-06 — three stale workers that aren't actually
  // running on CC's local machine for the OASIS personal Command Center:
  //   - pm2.override-consumer was deleted 2026-05-22 with the exec_guard
  //     approval-request system (see Business-Empire-Agent/ecosystem.config.js
  //     line 272 comment). Listing it was making the dashboard
  //     misreport phantom "running" daemons.
  //   - pm2.sequence-runner + pm2.lender-response-classifier are now
  //     SunBiz VPS-only daemons (sunbiz-sequence-runner,
  //     sunbiz-lender-response-classifier in SunBiz-Agent/ecosystem.config.js).
  //     They aren't on CC's local pm2 and don't apply to the OASIS
  //     personal Command Center. If a future SunBiz operator-facing
  //     panel ships on /t/sun, it should source from a tenant-scoped
  //     worker list, not this one.
  {
    service: "pm2.dashboard-email-consumer",
    label: "Dashboard email sender",
    purpose: "Sends emails queued from the Command Center's lead-drawer composer. Polls lead_interactions every 10s.",
    // OASIS has its own company-scoped process on the operator's Windows fleet.
    // A separate tenant process can share the executable name without sharing
    // its queue because the consumer filters by the host mailbox's tenant map.
    runtime: "local",
    control_mode: "local_fleet",
    status_source: "integrations_health",
  },
  {
    service: "pm2.dashboard-email-queue-monitor",
    label: "Email queue monitor",
    purpose: "Watches the OASIS email sender and alerts if queued messages stop draining.",
    runtime: "local",
    control_mode: "local_fleet",
    status_source: "integrations_health",
  },
  {
    service: "pm2.atlas-telegram",
    label: "Atlas CFO Telegram",
    purpose: "Bridges Telegram messages to Atlas (CFO Agent) for financial queries and trading alerts.",
  },
  {
    service: "pm2.maven-telegram",
    label: "Maven CMO Telegram",
    purpose: "Bridges Telegram messages to Maven (CMO Agent) for content and marketing operations.",
  },
  {
    service: "skool_engine",
    label: "Skool daemon",
    // CC 2026-06-06: treat as a normal stopped worker, not "archived". The
    // archive flag was making it render with strikethrough + archive icon
    // which suggested it was retired permanently. It's just stopped — code
    // is still on disk at scripts/_archive/skool/ for revival when the
    // operator launches their own community.
    purpose: "Posts/replies in a Skool community. Code preserved at scripts/_archive/skool/ — revive only when the operator launches their own community.",
    runtime: "retired",
    control_mode: "none",
    status_source: "none",
    // Standalone Python script — owns its own lock file. The supervisor does
    // not know about it, so the Start/Stop/Restart buttons are hidden.
    manageable_via_pm2: false,
    not_expected_here: "Retired 2026-05-18 — nothing runs it until you launch a community",
  },
];

/**
 * The OASIS workers a Start/Stop/Restart may name: supervised on the operator's
 * machine (not retired, not archived, not marked "none"). The bridge
 * re-validates the name; this is the server's own allowlist in front of it.
 */
export function controllableOasisWorker(name: string): OasisWorker | null {
  const bare = name.replace(/^pm2\./, "");
  const worker = OASIS_WORKERS.find((w) => w.service.replace(/^pm2\./, "") === bare);
  if (!worker) return null;
  if (!worker.service.startsWith("pm2.")) return null;
  if (worker.runtime === "retired" || worker.runtime === "cloud" || worker.control_mode === "none") return null;
  if (worker.archived_on || worker.not_expected_here) return null;
  return worker;
}
