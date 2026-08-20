/**
 * GET /api/automations/background-workers — operator's local PM2 daemons
 * + standalone Skool daemon status, sourced from integrations_health rows
 * the bridge daemon writes on each /api/bridge/ping cycle (60s).
 *
 * Why integrations_health (and not a fresh remote probe): the operator's
 * machine is the source of truth — only it can see its own PM2 list. The
 * bridge already pushes that snapshot on every heartbeat (see
 * bravo_cli/local_bridge.py detect_pm2_daemons), so the dashboard just
 * reads back the last-pinged value.
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
 *       metadata: Record<string, unknown>,
 *       last_ping_at: string | null,
 *       purpose: string,             // 1-line "what this daemon does"
 *       archived_on?: string,        // ISO date if status === "archived"
 *       archived_reason?: string,    // short why-archived if status === "archived"
 *       owner: "cc" | "adon" | "shared", // B4 (2026-07-23) — who this worker belongs to
 *     }>,
 *   }
 *
 * Operator-only: scoped to the session's tenant_id via user_profiles. Empire
 * vs tenant doesn't matter here — each tenant's bridge pushes its own row.
 */

import { NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { getTenant } from "@/lib/queries";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { bridgeControlEligibility } from "@/lib/bridge-proxy";
import { SUNBIZ_WORKERS } from "@/lib/automations/sunbiz-workers";
import { jsonRoute } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authoritative list of expected background workers + their purpose copy.
 * Mirrors ecosystem.config.js. Keep these two files in sync — adding a
 * PM2 daemon there without adding the description here just means it
 * shows up as an "unknown background worker" on the dashboard.
 */
const EXPECTED_WORKERS: Array<{
  service: string;
  label: string;
  purpose: string;
  /**
   * When false, the dashboard's pm2 Start/Stop/Restart buttons are hidden
   * for this worker. Used for standalone Python daemons that own their
   * own lock files and aren't registered with pm2 (Skool engine, etc) —
   * sending `pm2 start skool_engine` would fail because pm2 doesn't
   * know about it.
   */
  manageable_via_pm2?: boolean;
  archived_on?: string;
  archived_reason?: string;
}> = [
  {
    service: "pm2.bravo-scheduler",
    label: "Empire scheduler",
    purpose: "Polls cron_jobs every 60s on the operator's machine and executes due jobs.",
  },
  {
    service: "pm2.bravo-telegram",
    label: "Telegram bridge",
    purpose: "Bridges Telegram messages to the chat backbone. Windows-default, Mac cold-standby.",
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
    purpose: "Stopped. Posts/replies in a Skool community. Code preserved at scripts/_archive/skool/ — revive only when the operator launches their own community.",
    // Standalone Python script — owns its own lock file. pm2 doesn't know
    // about it, so the Start/Stop/Restart buttons are hidden for this
    // tile (sending `pm2 start skool_engine` would fail).
    manageable_via_pm2: false,
  },
];

// Wrapped: this panel renders alongside the cron list, so a throw here left the
// tab stuck on "Loading..." next to the other panel's error banner.
export const GET = jsonRoute("api/automations/background-workers GET", async () => {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const db = getServiceSupabase();
  const profile = await db
    .from("user_profiles")
    .select("id, tenant_id, team_role, is_owner, admin_access")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const profileRow = profile.data as
    | {
        id: string | null;
        tenant_id: string | null;
        team_role: string | null;
        is_owner: boolean | null;
        admin_access: boolean | null;
      }
    | null;
  const profileId = profileRow?.id ?? null;
  const tenantId = profileRow?.tenant_id ?? null;
  if (!tenantId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  // Owner/admin gate (mirrors authorizeBridgeRequest's is_owner + admin_access
  // promotion). Only these roles may bounce VPS daemons, so only they get
  // Start/Stop/Restart buttons — everyone else sees the workers read-only.
  const role = (
    profileRow?.is_owner === true
      ? "owner"
      : profileRow?.admin_access === true
        ? "admin"
        : profileRow?.team_role || "read_only"
  )
    .trim()
    .toLowerCase();

  // Tenant-aware worker set. SunBiz operators see the VPS daemons (pushed by
  // the VPS bridge under the tenant_id); everyone else sees the operator's
  // local empire daemons (pushed under their own profile_id).
  const tenant = await getTenant(tenantId);
  const isSun = (tenant ? resolveClientProfileSlug(tenant) : null) === "sun";
  const workerSet = isSun ? SUNBIZ_WORKERS : EXPECTED_WORKERS;
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
  const lastSeenAt = (pairing.data as { last_seen_at: string | null } | null)?.last_seen_at ?? null;
  const bridgeOnline = lastSeenAt
    ? Date.now() - new Date(lastSeenAt).getTime() < 120_000
    : false;

  // integrations_health is keyed (profile_id, service). When the bridge
  // hasn't pushed (no profile_id, or no rows), fall back to "unconfigured".
  const services = workerSet.map((w) => w.service);
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
          .eq("profile_id", profileId)
          .in("service", services)
      : null;
  if (healthRows && !healthRows.error && Array.isArray(healthRows.data)) {
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

  const workers = workerSet.map((w) => {
    const archived = Boolean(w.archived_on);
    const h = archived ? undefined : healthMap.get(w.service);
    // Standalone (non-pm2) workers don't have their lifecycle in pm2's
    // jlist, so the bridge's heartbeat sometimes reports a stale
    // "healthy" status row (e.g., Skool was once running months ago,
    // the integrations_health row was never reset). Force these to
    // "down" so the tile honestly says Stopped. CC 2026-06-06:
    // "the Skool daemon is showing a checkmark, but it hasn't stopped."
    const reportedStatus = (h?.status as "healthy" | "degraded" | "down" | "unconfigured") || "unconfigured";
    const status = archived
      ? ("archived" as const)
      : w.manageable_via_pm2 === false
        ? ("down" as const)
        : reportedStatus;
    return {
      service: w.service,
      label: w.label,
      purpose: w.purpose,
      status,
      // Strip stale metadata for forced-down standalones so the
      // tooltip doesn't show a phantom 5-restart count from when it
      // last ran.
      metadata: w.manageable_via_pm2 === false ? {} : h?.metadata || {},
      last_ping_at: h?.last_ping_at || null,
      // Default to true so existing pm2-managed workers keep their action
      // buttons. Skool (the one non-pm2 standalone) flips this false. SunBiz
      // workers are controllable only once the VPS bridge proxy is configured
      // (sunbizControl); their actions route through the server proxy, not the
      // operator's localhost.
      manageable_via_pm2: isSun ? sunbizControl : w.manageable_via_pm2 !== false,
      // B4 (2026-07-23): EXPECTED_WORKERS (CC's own local empire daemons)
      // predates the owner field and has no Breeze/adon entries — default
      // "cc". SUNBIZ_WORKERS always carries an explicit owner.
      owner: "owner" in w ? w.owner : "cc",
      ...(archived && {
        archived_on: w.archived_on,
        archived_reason: w.archived_reason,
      }),
    };
  });

  return NextResponse.json({
    ok: true,
    bridge_online: bridgeOnline,
    last_seen_at: lastSeenAt,
    // True when this tenant's worker actions must route through the server-side
    // bridge proxy (/api/automations/background-workers/control) instead of the
    // operator's localhost bridge. SunBiz (VPS daemons) with bridge env set.
    remote_control: sunbizControl,
    workers,
  });
});
