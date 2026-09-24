/**
 * GET /api/automations/background-workers — tenant-exact worker inventory.
 * Local/remote process health comes from integrations_health, cloud jobs use
 * their own health source, and retired rows are informational only.
 *
 * The machine supervisor is the source of truth for process state. Its bridge
 * pushes a snapshot on every heartbeat, so this route reads the last trusted
 * value without probing an operator machine from the cloud.
 *
 * Response shape:
 *   {
 *     ok: true,
 *     bridge_online: boolean,        // bridge_pairings.last_seen_at < 120s
 *     last_seen_at: string | null,
 *     workers: Array<{
 *       service: string,             // "pm2.sequence-runner", "skool_engine"
 *       label: string,               // operator-friendly name
 *       status: "healthy" | "degraded" | "down" | "unconfigured" | "archived",
 *       stale: boolean,               // status row exists but is >5 min old — degraded to "down"
 *       metadata: Record<string, unknown>,
 *       last_ping_at: string | null,
 *       purpose: string,             // 1-line "what this daemon does"
 *       runtime: "local" | "cloud" | "remote" | "retired",
 *       control_mode: "local_fleet" | "remote_bridge" | "none",
 *       status_source: "integrations_health" | "website_sales_meeting_worker_health" | "none",
 *       archived_on?: string,        // ISO date if status === "archived"
 *       archived_reason?: string,    // short why-archived if status === "archived"
 *       owner: "cc" | "adon" | "shared", // B4 (2026-07-23) — who this worker belongs to
 *     }>,
 *   }
 *
 * System-surface only and tenant-exact: OASIS inventory is never a fallback
 * for an unrelated workspace.
 */

import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getTenant } from "@/lib/queries";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { bridgeControlEligibility } from "@/lib/bridge-proxy";
import { DAEMON_HEALTH_STALE_MS } from "@/lib/automations/daemon-backed-crons";
import { externalTenantSurfacesBlocked } from "@/lib/deployment-surface";
import {
  capabilitiesFor,
  isOasisSurfaceTenant,
  resolvePersona,
} from "@/lib/role-surfaces";
import type {
  WorkerControlMode,
  WorkerRuntime,
  WorkerStatusSource,
} from "@/lib/automations/worker-status";
import {
  FLEET_REPORTER_SERVICE,
  describeStatusReporter,
  resolveWorkerControlMode,
  selectWorkerInventory,
} from "@/lib/automations/worker-status";
import { jsonRoute } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authoritative list of expected background workers + their purpose copy.
 * Mirrors ecosystem.config.js. Keep these two files in sync — adding a
 * supervised daemon there without adding the description here just means it
 * shows up as an "unknown background worker" on the dashboard.
 */
const OASIS_WORKERS: Array<{
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
}> = [
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

// Wrapped: this panel renders alongside the cron list, so a throw here left the
// tab stuck on "Loading..." next to the other panel's error banner.
export const GET = jsonRoute("api/automations/background-workers GET", async () => {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const db = getServiceSupabase();
  const profileId = session.profileId;
  const tenantId = session.tenantId;
  // Owner/admin gate (mirrors authorizeBridgeRequest's is_owner + admin_access
  // promotion). Only these roles may bounce VPS daemons, so only they get
  // Start/Stop/Restart buttons — everyone else sees the workers read-only.
  const role = (
    session.isTrueAdmin
      ? "owner"
      : session.adminAccess
        ? "admin"
        : session.teamRole
  )
    .trim()
    .toLowerCase();

  // Choose from two exact inventories. OASIS slug is authoritative when old
  // profile metadata disagrees; unrelated tenants receive neither inventory.
  const tenant = await getTenant(tenantId);
  const tenantSlug = tenant?.slug?.trim().toLowerCase() || null;
  const oasisOnlyDeployment = externalTenantSurfacesBlocked();
  if (oasisOnlyDeployment && !isOasisSurfaceTenant(tenantSlug)) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const persona = resolvePersona({
    teamRole: session.teamRole,
    isTrueAdmin: session.isTrueAdmin,
    adminAccess: session.adminAccess,
  });
  if (!capabilitiesFor(persona, tenantSlug).canSeeSystemSurfaces) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const inventory = oasisOnlyDeployment
    ? "oasis"
    : selectWorkerInventory({
        isOasisTenant: isOasisSurfaceTenant(tenantSlug),
        isClientProfile: (tenant ? resolveClientProfileSlug(tenant) : null) === "sun",
      });
  if (inventory === "none") {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const isOasis = inventory === "oasis";
  const isSun = inventory === "client";
  const workerSet = isOasis
    ? OASIS_WORKERS
    : (await import("@/lib/automations/sunbiz-workers")).SUNBIZ_WORKERS;
  // SunBiz daemons live on the VPS — start/stop/restart routes through the
  // server-side bridge proxy (control/route.ts). Decide whether to show the
  // controls with the SAME resolver + role gate POST enforces, via the shared
  // bridgeControlEligibility() helper, so the displayed state can't drift from
  // what POST will accept (Codex audit 2026-06-17).
  const { targetConfigured, roleAllowed } = bridgeControlEligibility(tenant, role);
  const sunbizControl = isSun && targetConfigured && roleAllowed;

  // Bridge liveness — the heartbeat tells us when the bridge last pushed
  // anything. Older than 2 minutes means daemon snapshots are stale.
  const pairing = await db
    .from("bridge_pairings")
    .select("last_seen_at")
    .eq("tenant_id", tenantId)
    .is("revoked_at", null)
    .order("last_seen_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (pairing.error) {
    console.error("[background-workers] bridge pairing health read failed", pairing.error);
    return NextResponse.json(
      {
        ok: false,
        error: "bridge_health_unavailable",
        message: "Automation health could not be verified. Refresh in a moment.",
      },
      { status: 503 },
    );
  }
  const lastSeenAt = (pairing.data as { last_seen_at: string | null } | null)?.last_seen_at ?? null;
  const bridgeOnline = lastSeenAt
    ? Date.now() - new Date(lastSeenAt).getTime() < 120_000
    : false;

  // integrations_health is keyed (profile_id, service). When the bridge
  // hasn't pushed (no profile_id, or no rows), fall back to "unconfigured".
  // The reporter row rides along with the workers it vouches for — see
  // describeStatusReporter for why it exists.
  const services = [...workerSet.map((w) => w.service), FLEET_REPORTER_SERVICE];
  const healthMap = new Map<
    string,
    { status: string; metadata: Record<string, unknown>; last_ping_at: string | null }
  >();
  // SunBiz workers are pushed under the tenant_id (VPS bridge); operator
  // workers under the session profile_id (local bridge).
  const healthRows = isSun
    ? await db
        .from("integrations_health")
        .select("service, status, metadata, last_ping_at")
        .eq("tenant_id", tenantId)
        .in("service", services)
    : profileId
      ? await db
          .from("integrations_health")
          .select("service, status, metadata, last_ping_at")
          .eq("tenant_id", tenantId)
          .eq("profile_id", profileId)
          .in("service", services)
      : null;
  if (!healthRows) {
    console.error("[background-workers] worker health profile is unavailable", {
      tenantId,
      profileId,
    });
    return NextResponse.json(
      {
        ok: false,
        error: "worker_health_identity_unavailable",
        message: "This workspace's worker health identity could not be verified.",
      },
      { status: 503 },
    );
  }
  if (healthRows.error) {
    console.error("[background-workers] worker health read failed", healthRows.error);
    return NextResponse.json(
      {
        ok: false,
        error: "worker_health_unavailable",
        message: "Automation health could not be verified. Refresh in a moment.",
      },
      { status: 503 },
    );
  }
  if (Array.isArray(healthRows.data)) {
    for (const r of healthRows.data as Array<{
      service: string;
      status: string;
      metadata: Record<string, unknown> | null;
      last_ping_at: string | null;
    }>) {
      healthMap.set(r.service, {
        status: r.status,
        metadata: r.metadata || {},
        last_ping_at: r.last_ping_at,
      });
    }
  }

  const now = Date.now();
  const workers = workerSet.map((w) => {
    const archived = Boolean(w.archived_on);
    const configuredRuntime =
      "runtime" in w ? (w.runtime as WorkerRuntime | undefined) : undefined;
    const runtime: WorkerRuntime = configuredRuntime ?? (isSun ? "remote" : "local");
    const configuredControl =
      "control_mode" in w ? (w.control_mode as WorkerControlMode | undefined) : undefined;
    const controlMode = resolveWorkerControlMode({
      runtime,
      configuredMode:
        configuredControl ?? (w.manageable_via_pm2 === false ? "none" : undefined),
      teamRole: session.teamRole,
      isTrueAdmin: session.isTrueAdmin,
      adminAccess: session.adminAccess,
      remoteControlAllowed: sunbizControl,
    });
    const configuredStatusSource =
      "status_source" in w ? (w.status_source as WorkerStatusSource | undefined) : undefined;
    const statusSource: WorkerStatusSource =
      configuredStatusSource ?? (runtime === "retired" ? "none" : "integrations_health");
    const h = archived || runtime === "retired" ? undefined : healthMap.get(w.service);
    // Standalone (non-pm2) workers don't have their lifecycle in pm2's
    // jlist, so the bridge's heartbeat sometimes reports a stale
    // "healthy" status row (e.g., Skool was once running months ago,
    // the integrations_health row was never reset). Force these to
    // "down" so the tile honestly says Stopped. CC 2026-06-06:
    // "the Skool daemon is showing a checkmark, but it hasn't stopped."
    const reportedStatus = (h?.status as "healthy" | "degraded" | "down" | "unconfigured") || "unconfigured";
    // A row the bridge has stopped refreshing is not a reading, it's a relic.
    // Same freshness rule as the daemon-backed cron rows (5 min vs the 60s
    // heartbeat): an unparseable or old last_ping_at degrades the worker to
    // "down" — a twenty-minute-old "healthy" must never render as a green
    // tile. The timestamp is kept so the UI can say when it was last seen.
    const pingedAt = h?.last_ping_at ? Date.parse(h.last_ping_at) : NaN;
    const unreporting =
      Boolean(h) && (!Number.isFinite(pingedAt) || now - pingedAt > DAEMON_HEALTH_STALE_MS);
    const status = archived
      ? ("archived" as const)
      : runtime === "retired" || unreporting
        ? ("down" as const)
        : reportedStatus;
    return {
      service: w.service,
      label: w.label,
      purpose: w.purpose,
      status,
      // True when a status row exists but is too old to trust — the tile
      // renders "stopped reporting · last seen …" instead of plain Stopped.
      stale: unreporting,
      // Strip stale metadata for forced-down standalones AND unreporting
      // workers so the tooltip doesn't show a phantom PID/uptime from the
      // last time the bridge actually saw the process.
      metadata: runtime === "retired" || unreporting ? {} : h?.metadata || {},
      last_ping_at: h?.last_ping_at || null,
      runtime,
      control_mode: controlMode,
      status_source: statusSource,
      // Default to true so existing pm2-managed workers keep their action
      // buttons. Skool (the one non-pm2 standalone) flips this false. SunBiz
      // workers are controllable only once the VPS bridge proxy is configured
      // (sunbizControl); their actions route through the server proxy, not the
      // operator's localhost.
      //
      // A worker that is not meant to run here is never locally controllable,
      // enforced HERE rather than trusted to each entry. Forgetting the flag on
      // one entry ships a live Start button whose only effect is to launch the
      // duplicate that entry exists to prevent — and for the email sender, a
      // duplicate means every queued message sends twice.
      manageable_via_pm2: controlMode !== "none",
      // B4 (2026-07-23): OASIS_WORKERS (CC's own local empire daemons)
      // predates the owner field and has no Breeze/adon entries — default
      // "cc". SUNBIZ_WORKERS always carries an explicit owner.
      owner: "owner" in w ? w.owner : "cc",
      not_expected_here: "not_expected_here" in w ? w.not_expected_here : undefined,
      ...(archived && {
        archived_on: w.archived_on,
        archived_reason: w.archived_reason,
      }),
    };
  });

  // This is a cloud worker, not a local PM2 daemon. Keeping it separate from
  // bridge health makes it clear that booked-client reminders do not depend on
  // the operator's laptop being online.
  if (isOasis) {
    const cloudHealth = await db
      .from("website_sales_meeting_worker_health")
      .select("status,last_run_at,processed,failed,last_error")
      .eq("id", 1)
      .maybeSingle();
    if (cloudHealth.error) {
      console.error("[background-workers] cloud worker health read failed", cloudHealth.error);
      return NextResponse.json(
        {
          ok: false,
          error: "cloud_worker_health_unavailable",
          message: "Cloud automation health could not be verified. Refresh in a moment.",
        },
        { status: 503 },
      );
    }
    const health = cloudHealth.data as {
      status: "healthy" | "degraded";
      last_run_at: string;
      processed: number;
      failed: number;
      last_error: string | null;
    } | null;
    const lastRunEpoch = health?.last_run_at ? Date.parse(health.last_run_at) : NaN;
    const stale = Boolean(health) && (!Number.isFinite(lastRunEpoch) || now - lastRunEpoch > 10 * 60_000);
    workers.push({
      service: "cloud.founder-meeting-reminders",
      label: "Founder meeting reminders",
      purpose: "Sends consent-aware booking confirmations and 10-minute reminders from the verified Google Calendar handoff.",
      runtime: "cloud",
      control_mode: "none",
      status_source: "website_sales_meeting_worker_health",
      // Cloud-hosted, but it DOES report here (website_sales_meeting_worker_health),
      // so it is a real member of the pill's denominator — unlike the two
      // workers that carry a reason string.
      not_expected_here: undefined,
      status: !health ? "unconfigured" : stale ? "down" : health.status,
      stale,
      metadata: health ? {
        processed_last_run: health.processed,
        failed_last_run: health.failed,
        last_error: health.last_error,
        runtime: "cloud",
      } : { runtime: "cloud", state: "waiting for first scheduled run" },
      last_ping_at: health?.last_run_at || null,
      manageable_via_pm2: false,
      owner: "cc",
    });
  }

  return NextResponse.json({
    ok: true,
    bridge_online: bridgeOnline,
    last_seen_at: lastSeenAt,
    status_reporter: describeStatusReporter({
      row: healthMap.get(FLEET_REPORTER_SERVICE),
      bridgeOnline,
      now,
      staleMs: DAEMON_HEALTH_STALE_MS,
    }),
    // True when this tenant's worker actions must route through the server-side
    // bridge proxy (/api/automations/background-workers/control) instead of the
    // operator's localhost bridge. SunBiz (VPS daemons) with bridge env set.
    remote_control: sunbizControl,
    workers,
  });
});
