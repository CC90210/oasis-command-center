/**
 * OASIS's background-worker lifecycle registry: active local processes plus
 * intentionally retired computer copies, keyed by their historical
 * integrations_health service name.
 *
 * Moved out of app/api/automations/background-workers/route.ts (2026-09-30) so
 * three readers share one list instead of three copies drifting apart:
 *   - GET /api/automations/background-workers (the Automations board),
 *   - POST /api/automations/background-workers/control (the allowlist for
 *     Start/Stop/Restart, which now goes through the server for OASIS too:
 *     the bridge answers 401 to a browser since its bearer went on, 09-29),
 *   - lib/admin/system-health.ts (System health's "Background work" card).
 *
 * Active rows mirror the operator machine's launch manifest. Retired rows stay
 * here so stale health records render as planned retirement instead of an
 * outage or a restart target.
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

// 2026-10-31 (CC: "we have way more than two background workers"): the
// 10-30 handover fence marked Windows processes "Retired by plan" before their
// replacements existed, so the board counted 2 workers while six of these
// still ran here. A row is retired only once its process is actually off;
// workers that still run here are listed as this computer's, with live status
// and controls.
export const OASIS_WORKERS: OasisWorker[] = [
  {
    // First on purpose (CC 2026-10-31): the bridge is what makes "this
    // computer" part of OASIS at all.
    service: "pm2.claude-bridge",
    label: "Local chat bridge",
    purpose: "Connects this computer to the Command Center (localhost:9100): dashboard agent chats and agent tools that need this computer run through it.",
  },
  {
    // Still the only runner of the active cron_jobs rows (Daily Bravo Brief,
    // Maven syncs, health checks) until they move to Cloudflare. It runs every
    // ACTIVE row; the risky rows are switched off in cron_jobs, not filtered here.
    service: "pm2.bravo-scheduler",
    label: "Empire scheduler",
    purpose: "Runs this computer's scheduled jobs (Daily Bravo Brief, Maven syncs, health checks) every minute, until each moves to Cloudflare.",
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
    runtime: "retired",
    control_mode: "none",
    status_source: "none",
    manageable_via_pm2: false,
    not_expected_here: "Retired by plan — the always-on setter is moving to the daemon VPS; this computer's copy stays off.",
  },
  {
    // Retired 2026-10-30: the VPS long-poll bridge (oasis-telegram-bridge) is
    // the sole Telegram poller. A Start here would put a second getUpdates
    // poller on the same bot token, and Telegram answers both with HTTP 409.
    service: "pm2.bravo-telegram",
    label: "Telegram bridge",
    purpose: "Bridges Telegram messages to the chat backbone.",
    runtime: "retired",
    control_mode: "none",
    status_source: "none",
    manageable_via_pm2: false,
    not_expected_here: "Retired by plan — Telegram runs 24/7 on the daemon VPS (oasis-telegram-bridge); a second poller on this computer would collide with it.",
  },
  {
    // The reporter for every tile on this board: without its heartbeat the
    // computer reads offline and Telegram/agent turns cannot reach it.
    service: "pm2.claude-bridge-ping",
    label: "Bridge heartbeat",
    purpose: "Tells the Command Center every minute that this computer is online, reports these worker statuses, and runs workspace schedules.",
  },
  {
    service: "pm2.event-router",
    label: "Event router",
    purpose: "Read-only: keeps a copy of every agent event in this computer's activity log.",
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
    runtime: "retired",
    control_mode: "none",
    status_source: "none",
    manageable_via_pm2: false,
    not_expected_here: "Retired by plan — Cloudflare owns the dashboard email queue; local copies stay off.",
  },
  {
    service: "pm2.dashboard-email-queue-monitor",
    label: "Email queue monitor",
    purpose: "Watches the OASIS email sender and alerts if queued messages stop draining.",
    runtime: "retired",
    control_mode: "none",
    status_source: "none",
    manageable_via_pm2: false,
    not_expected_here: "Retired by plan — Cloudflare reports sender health; the local monitor stays off.",
  },
  {
    // CC's only Atlas bot: no VPS copy exists yet.
    service: "pm2.atlas-telegram",
    label: "Atlas CFO Telegram",
    purpose: "Bridges Telegram messages to Atlas (CFO Agent) for financial queries and trading alerts.",
  },
  {
    // CC's only Maven bot: no VPS copy exists yet.
    service: "pm2.maven-telegram",
    label: "Maven CMO Telegram",
    purpose: "Bridges Telegram messages to Maven (CMO Agent) for content and marketing operations.",
  },
  {
    // Live since 2026-10-31: the VPS's reporter (oasis-vps-health.timer, every
    // minute) posts these two rows to /api/internal/vps-health
    // (lib/automations/vps-health.ts), which writes integrations_health under
    // the agents owner's profile, where this panel reads. Never controllable
    // from here.
    service: "vps.oasis-telegram-bridge",
    label: "Telegram bridge (daemon VPS)",
    purpose: "Long-polls the Bravo Telegram bot around the clock and hands each message from CC to the Command Center, which answers through this computer.",
    runtime: "remote",
    control_mode: "none",
    status_source: "integrations_health",
    manageable_via_pm2: false,
  },
  {
    service: "vps.oasis-inbox-sweep",
    label: "Inbox sweep (daemon VPS)",
    purpose: "Every 5 minutes: classifies new mail and alerts CC on Telegram about hot replies. A failed run alerts CC on Telegram.",
    runtime: "remote",
    control_mode: "none",
    status_source: "integrations_health",
    manageable_via_pm2: false,
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
    not_expected_here: "Retired by plan — nothing runs it until you launch a community.",
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
  // Only this computer's own supervised processes: never a remote, cloud or
  // retired row, whatever its name looks like.
  if ((worker.runtime ?? "local") !== "local" || worker.control_mode === "none") return null;
  if (worker.archived_on || worker.not_expected_here) return null;
  return worker;
}
