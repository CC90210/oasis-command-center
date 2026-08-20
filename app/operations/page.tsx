/**
 * /operations — what's running in the background.
 *
 * Reads three already-populated tables:
 *   - agent_state_snapshot   → which agents have ticked recently (workers)
 *   - bridge_pairings        → which local installs are heartbeating
 *   - agent_events (last 50) → cross-agent activity tape (cron + reasoning)
 *
 * No new schema. Surfaces what's already in motion so the operator can see
 * the back end at a glance: cron jobs that just ran, agents that ticked,
 * inbound events that landed.
 */

import Link from "next/link";
import { Card, PageHeader, Tag, EmptyState } from "@/components/Card";
import { agentStates, getActiveProfile, recentDecisions, recentEvents } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { ALL_AGENT_KEYS, FAMILY_AGENT_KEYS, getAgentInfo, resolveAgentKey } from "@/lib/agents";
import { getTenantEnabledAgents } from "@/lib/manifest/tenant-scope";
import { isOperatorEmail } from "@/lib/operator-credentials";
import { timeAgo, truncate } from "@/lib/fmt";
import { AgentDecisionsCard } from "@/components/AgentDecisionsCard";
import { buildRecordResolver, projectEvent } from "@/lib/event-projection";
import { WarmPoolPanel } from "@/components/WarmPoolPanel";
import { BridgeCliPanel } from "@/components/BridgeCliPanel";
import { requireSystemSurface } from "@/lib/role-surfaces-session";

export const dynamic = "force-dynamic";

const FRESH_AGENT_MS = 15 * 60 * 1000;
// Bridge ping cadence is 60s (see app/api/automations/background-workers/route.ts
// — `claude-bridge-ping` heartbeats every minute). 90s = one-miss tolerance.
// Anything beyond 90s but under 5 min counts as "idle" (heartbeat skipped a
// beat, daemon probably still alive); >5 min is fully "offline".
//
// Previous value of 5 min for the online cutoff was the bug CC saw: a
// machine that had pinged ~3 min before sleeping would still show "online
// · 3m ago" — visually contradicting the fact that the machine was off.
const FRESH_BRIDGE_MS = 90 * 1000;
const IDLE_BRIDGE_MS = 5 * 60 * 1000;

type AgentSnap = {
  agent_name: string;
  tick_count: number | null;
  last_tick_at: string | null;
  last_tick_id: string | null;
  health_status: string | null;
};

type BridgePair = {
  id: string;
  label: string;
  machine_fingerprint: string | null;
  last_seen_at: string | null;
  created_at: string;
};

export default async function OperationsPage({
  searchParams,
}: {
  searchParams?: Promise<{ showOlder?: string }>;
}) {
  // System surface — the agent fleet, cron tape and bridge pairings. Not a
  // contractor's screen. 404 before any read; see lib/role-surfaces.ts.
  await requireSystemSurface();
  const profile = await safe("operations.profile", getActiveProfile(), null);
  const user = await getSessionUser().catch(() => null);
  const isOperator = isOperatorEmail(user?.email || undefined);
  const db = getServiceSupabase();
  const sp = (await searchParams) || {};
  const showOlder = sp.showOlder === "1";

  // Cross-tenant scoping for agent_state_snapshot + agent_events: resolve
  // the tenant's enabled agents up front and pass to the helpers. Both
  // tables predate the tenant_manifests system and have no tenant_id
  // column today; the helpers proxy-filter by agent_name / publisher_agent
  // to keep client tenants from seeing CC's OASIS heartbeats + activity.
  // Operator (CC) bypasses via isOperator: true on the recentEvents call
  // and explicit ALL_AGENT_KEYS fan-out on agentStates.
  const manifestEnabledSlugs = await getTenantEnabledAgents(profile?.tenant_id ?? null);
  const agentNamesForOps = isOperator
    ? ALL_AGENT_KEYS
    : (manifestEnabledSlugs.length > 0
        ? manifestEnabledSlugs
        : (profile?.agents_enabled || []).map(resolveAgentKey));

  // Health banner counts (4 tiles at the top). Phase 3 merge: the dedicated
  // /health page still exists for drill-down, but the operator gets a
  // glance-able summary right where they're already looking. Each is a
  // pure count query — no payloads pulled — so the round-trip cost is
  // ~5ms per table.
  const tenantId = profile?.tenant_id || null;
  const now24Ago = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const now7Ago = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const now14Ago = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const [snaps, pairings, events, decisions, errorsCount, failedCronsCount, stuckThreadsCount, staleLeadsCount] = await Promise.all([
    safe(
      "operations.agent_state_snapshot",
      agentStates(agentNamesForOps).then((rows) =>
        rows.map((r) => ({
          agent_name: r.agent_name,
          tick_count: r.tick_count ?? null,
          last_tick_at: r.last_tick_at ?? null,
          last_tick_id: r.last_tick_id ?? null,
          health_status: r.health_status ?? null,
        })) as AgentSnap[]
      ),
      [] as AgentSnap[]
    ),
    profile?.tenant_id
      ? safe(
          "operations.bridge_pairings",
          (async () => {
            const r = await db
              .from("bridge_pairings")
              .select("id, label, machine_fingerprint, last_seen_at, created_at")
              .eq("tenant_id", profile.tenant_id)
              .is("revoked_at", null)
              .order("last_seen_at", { ascending: false });
            return (r.data as BridgePair[]) || [];
          })(),
          [] as BridgePair[]
        )
      : Promise.resolve([] as BridgePair[]),
    // Activity tape default: most recent N events regardless of age.
    // Scoped by publisher_agent ∈ agentNamesForOps; operator bypasses.
    safe(
      "operations.recent_events",
      recentEvents(showOlder ? 100 : 30, {
        sinceDays: 0,
        tenantId: profile?.tenant_id || null,
        agentNames: agentNamesForOps,
        isOperator,
      }),
      []
    ),
    // Agent decisions tape — moved here from /reasoning 2026-08-04 when that
    // page was dropped from CC's nav. Scoping is deliberately IDENTICAL to
    // the reasoning page it replaced: recentDecisions() filters
    // .eq(tenant_id).in(agent_name), and passing agentNamesForOps keeps it
    // consistent with the activity tape and worker cards on this same page.
    // Both guards inside recentDecisions still hold — a null tenant or an
    // empty agent list returns [] rather than leaking another tenant's loop.
    safe(
      "operations.recent_decisions",
      recentDecisions(profile?.tenant_id ?? null, agentNamesForOps, 20),
      []
    ),
    // Health tile #1: ERROR events in last 24h (tenant-scoped via enabled
    // agents — same posture as the activity tape above).
    //
    // 'warn' was dropped from this count 2026-08-04. Routine warnings are
    // high-volume and non-actionable, so bundling them made the tile read
    // ~1600 on a day nothing was actually broken — a number that big stops
    // being a signal and starts being wallpaper. Warnings are NOT suppressed:
    // they still publish to agent_events, still render in the Activity Tape,
    // and still show on the /health drill-down. They just don't inflate the
    // tile that's supposed to answer "is something broken right now."
    safe(
      "operations.errors_24h",
      (async () => {
        if (agentNamesForOps.length === 0 && !isOperator) return 0;
        let q = db
          .from("agent_events")
          .select("id", { count: "exact", head: true })
          .in("severity", ["error"])
          .gte("published_at", now24Ago);
        if (!isOperator) q = q.in("publisher_agent", agentNamesForOps);
        const r = await q;
        return r.count || 0;
      })(),
      0
    ),
    // Health tile #2: crons whose last run errored — both empire SEED_JOBS
    // (cron_jobs.last_result starts with ERROR/FAILED/unknown_action_type)
    // and tenant crons (last_run_status='error').
    safe(
      "operations.failed_crons",
      (async () => {
        const empireRes = await db
          .from("cron_jobs")
          .select("id", { count: "exact", head: true })
          .or(
            "last_result.like.ERROR%,last_result.like.FAILED%,last_result.like.unknown_action_type%",
          );
        let tenantCount = 0;
        if (tenantId) {
          const r = await db
            .from("tenant_cron_jobs")
            .select("id", { count: "exact", head: true })
            .eq("tenant_id", tenantId)
            .eq("last_run_status", "error");
          tenantCount = r.count || 0;
        }
        return (empireRes.count || 0) + tenantCount;
      })(),
      0
    ),
    // Health tile #3: lender threads stuck at sent for >7d.
    tenantId
      ? safe(
          "operations.stuck_threads",
          (async () => {
            const r = await db
              .from("application_lender_threads")
              .select("id", { count: "exact", head: true })
              .eq("tenant_id", tenantId)
              .eq("status", "sent")
              .lt("sent_at", now7Ago);
            return r.count || 0;
          })(),
          0
        )
      : Promise.resolve(0),
    // Health tile #4: leads whose updated_at is >14d ago.
    tenantId
      ? safe(
          "operations.stale_leads",
          (async () => {
            const r = await db
              .from("tenant_records")
              .select("id", { count: "exact", head: true })
              .eq("tenant_id", tenantId)
              .eq("entity_type", "lead")
              .lt("updated_at", now14Ago);
            return r.count || 0;
          })(),
          0
        )
      : Promise.resolve(0),
    // Overrides feature was deleted 2026-05-22 — CC's call: "I don't
    // want to be an approval bot. The block IS the protection."
    // exec_guard still refuses destructive commands; it just doesn't
    // create approval-request rows anymore. No more badge.
  ]);
  const snapByName = new Map(snaps.map((s) => [s.agent_name, s] as const));

  // Resolve lead/record UUIDs in event payloads to human names in one batch
  // query. Without this the Activity Tape renders lines like
  // "lead_id=ff7dcd57-87b5-4823-8a31-…" which is meaningless to an operator.
  // Falls back to first-8-char UUID prefix on miss so the row is still
  // identifiable.
  const recordResolver = await safe(
    "operations.record_resolver",
    buildRecordResolver(db, events, { tenantId }),
    new Map<string, string>(),
  );

  // Show only the agents this tenant has actually enabled (manifest
  // first, profile fallback). Codex is filtered via the family-only check
  // since it's a backend executor, not a standalone persona.
  //
  // Earlier this card unioned in the full FAMILY_AGENT_KEYS list "so CC
  // sees the full family, not a partial view" — but the result was
  // misleading: Hermes and Lumen rendered for tenants that never
  // subscribed to them, looking like dead workers. CC's correct call
  // (2026-05-14): only show what's actually wired up; idle subscribed
  // agents are useful, hallucinated subscribed agents are noise.
  const familySet = new Set(FAMILY_AGENT_KEYS);
  const enabledSource =
    manifestEnabledSlugs.length > 0
      ? manifestEnabledSlugs
      : profile?.agents_enabled || [];
  const enabled = enabledSource.filter((k) => familySet.has(resolveAgentKey(k)));
  const now = Date.now();

  const totalHealthSignals = errorsCount + failedCronsCount + stuckThreadsCount + staleLeadsCount;
  const allClear = totalHealthSignals === 0;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Operations"
        subtitle="Background workers, paired machines, and the live event tape — what's running right now."
        action={
          <Tag tone={pairings.some((p) => isFresh(p.last_seen_at, now, IDLE_BRIDGE_MS)) ? "engaged" : "warm"}>
            {pairings.filter((p) => isFresh(p.last_seen_at, now, IDLE_BRIDGE_MS)).length} bridge{pairings.length === 1 ? "" : "s"} online
          </Tag>
        }
      />

      {/* Health banner — phase 3 merge of /health into /operations.
          Compact 4-tile glance + a fifth pill for pending overrides.
          /health still exists for the full row-level drill-down; this
          shows just the counts so CC can see "do I have anything to look
          at right now" without leaving Operations. */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <HealthMiniTile label="Errors today" count={errorsCount} tone={errorsCount === 0 ? "engaged" : "warm"} href="/health" hint="Errors in the last 24h. Warnings are excluded — see the Activity Tape or /health for those." />
        <HealthMiniTile label="Failed automations" count={failedCronsCount} tone={failedCronsCount === 0 ? "engaged" : "warm"} href="/automations" hint="Scheduled jobs whose last run errored." />
        <HealthMiniTile label="Quiet shop-outs" count={stuckThreadsCount} tone={stuckThreadsCount === 0 ? "engaged" : "accent"} href="/health" hint="Lender emails sent >7d ago with no reply yet." />
        <HealthMiniTile label="Cold leads" count={staleLeadsCount} tone={staleLeadsCount === 0 ? "engaged" : "accent"} href="/pipeline" hint="Pipeline leads you haven't touched in 2+ weeks." />
      </div>
      {allClear && (
        <div className="text-xs text-status-engaged">All clear — nothing needs your attention.</div>
      )}

      <Card
        title="Agent workers"
        subtitle="Each agent runs an autonomous reasoning loop on its own machine. A green dot means it cycled within the last 15 min."
      >
        <div className="grid sm:grid-cols-2 gap-3">
          {enabled.map((key) => {
            const info = getAgentInfo(key);
            const snap = snapByName.get(key);
            const fresh = isFresh(snap?.last_tick_at || null, now, FRESH_AGENT_MS);
            return (
              <div
                key={key}
                className={`rounded-lg border bg-bg-elev px-4 py-3.5 ${
                  fresh ? "border-status-engaged/30" : "border-bg-border"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${
                      fresh ? "bg-status-engaged animate-pulse-slow" : snap?.last_tick_at ? "bg-status-warm" : "bg-fg-faint"
                    }`} />
                    <span className={`font-bold uppercase tracking-[0.14em] text-sm ${info.textClass}`}>
                      {info.label}
                    </span>
                  </div>
                  <span
                    className="text-xs text-fg-dim font-mono"
                    title="One cycle = one autonomous reasoning loop (the agent woke up, decided what to fire, logged it). Higher count = more activity since the worker started."
                  >
                    {snap?.last_tick_at ? `${snap.tick_count ?? 0} cycle${snap.tick_count === 1 ? "" : "s"}` : "no activity yet"}
                  </span>
                </div>
                <div className="text-xs text-fg-muted mt-1.5">{info.tagline}</div>
                <div className="text-[10px] text-fg-dim mt-2 font-mono">
                  {snap?.last_tick_at
                    ? `last cycle ${timeAgo(snap.last_tick_at)}${snap.last_tick_id ? ` · ${truncate(snap.last_tick_id, 12)}` : ""}`
                    : "worker not running on any paired machine"}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Paired machines" subtitle="Local installs heartbeating to this dashboard. Add a new one from Settings → Devices.">
        {pairings.length === 0 ? (
          <EmptyState
            message="No machines paired yet."
            cta={
              <Link href="/settings" className="btn-primary inline-flex items-center gap-1">
                Open Settings → Devices
              </Link>
            }
          />
        ) : (
          <ul className="divide-y divide-bg-border">
            {pairings.map((p) => {
              const state = bridgeState(p.last_seen_at, now);
              return (
                <li key={p.id} className="py-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${
                      state === "online"
                        ? "bg-accent animate-pulse-slow"
                        : state === "idle"
                          ? "bg-status-warm"
                          : "bg-fg-faint"
                    }`} />
                    <div className="min-w-0">
                      <div className="text-sm text-fg truncate">{p.label}</div>
                      <div className="text-[10px] text-fg-dim font-mono truncate">
                        {p.machine_fingerprint || "no fingerprint"}
                      </div>
                    </div>
                  </div>
                  <div className="text-xs text-fg-muted text-right shrink-0">
                    <div className={
                      state === "online"
                        ? "text-accent"
                        : state === "idle"
                          ? "text-status-warm"
                          : "text-fg-dim"
                    }>
                      {state}
                    </div>
                    <div className="text-[10px] text-fg-dim font-mono">
                      {p.last_seen_at ? `last ${timeAgo(p.last_seen_at)}` : "never"}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card
        title="Local CLI status"
        subtitle="Per-CLI install probe on your local bridge. Green = the bridge found the binary and could run --version. Red = chat-via-CLI will fall back to API-key mode for that provider."
      >
        <BridgeCliPanel serverBridgeOnline={pairings.some((p) => isFresh(p.last_seen_at, now, IDLE_BRIDGE_MS))} />
      </Card>

      <Card
        title="Warm process pool"
        subtitle="Live state of the bridge's persistent claude processes. Each entry skips the cold-start (5–30s) on its next chat turn. Only visible when the local bridge is online."
      >
        <WarmPoolPanel />
      </Card>

      <Card
        title="Activity tape"
        subtitle={
          showOlder
            ? `All events (last 100) — cron fires, reasoning loops, outbound sends, inbound classifications.`
            : `Most recent ${events.length} events — cron fires, reasoning loops, outbound sends, inbound classifications.`
        }
        action={
          <a
            href={showOlder ? "?" : "?showOlder=1"}
            className="text-xs text-fg-dim hover:text-accent transition-colors"
          >
            {showOlder ? "← back to recent 30" : "show 100 →"}
          </a>
        }
      >
        {events.length === 0 ? (
          <EmptyState
            message="No events recorded yet. The event bus writes when crons fire (MRR snapshot, plan materialize), inbound webhooks land (n8n classifies email), or agents emit dashboard-action mutations."
          />
        ) : (
          <ul className="divide-y divide-bg-border">
            {events.map((e) => {
              // Project to human-readable shape — replaces the raw event_type
              // tag and ad-hoc subject extraction with a single label +
              // summary line. Wire format (BRAVO_RECORD_STATUS_CHANGED, etc.)
              // stays available in a dim line for the developer-debug case.
              // The resolver swaps lead_id UUIDs for "Bennett Agency" etc.
              const p = projectEvent(e, recordResolver);
              return (
                <li key={e.id} className="py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <Tag tone={p.tone}>{p.label}</Tag>
                      {p.source_agent !== "unknown" && (
                        <span className="text-[10px] uppercase tracking-wider text-fg-dim">
                          {p.source_agent}
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-fg-dim shrink-0">
                      {timeAgo(p.published_at)}
                    </span>
                  </div>
                  {p.summary && p.summary !== "—" && (
                    <div className="text-fg mt-1 text-sm break-words">{p.summary}</div>
                  )}
                  <div className="text-[10px] text-fg-faint font-mono mt-0.5">
                    {p.event_type}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Agent decisions — the autonomous loop's own choices, as opposed to
          the Activity Tape above which is the event stream. Moved here from
          /reasoning when that page left CC's nav (2026-08-04). Shared
          component: /reasoning still renders the same tape for SunBiz + Suga
          tenants, so the markup lives in one place. */}
      <AgentDecisionsCard decisions={decisions} />
    </div>
  );
}

function HealthMiniTile({
  label,
  count,
  tone,
  href,
  hint,
}: {
  label: string;
  count: number;
  tone: "engaged" | "warm" | "accent" | "hot";
  href: string;
  hint?: string;
}) {
  const toneClass =
    tone === "engaged"
      ? "border-status-engaged/30 bg-status-engaged/5 text-status-engaged"
      : tone === "warm"
        ? "border-status-warm/40 bg-status-warm/5 text-status-warm"
        : tone === "hot"
          ? "border-status-hot/40 bg-status-hot/5 text-status-hot"
          : "border-accent/40 bg-accent/5 text-accent";
  return (
    <a
      href={href}
      title={hint}
      className={`rounded-lg border px-3 py-2 transition-opacity hover:opacity-80 ${toneClass}`}
    >
      <div className="text-[10px] uppercase tracking-wider font-bold opacity-70">{label}</div>
      <div className="text-2xl font-bold mt-0.5">{count}</div>
    </a>
  );
}

function isFresh(ts: string | null, now: number, threshold: number): boolean {
  if (!ts) return false;
  return now - new Date(ts).getTime() < threshold;
}

/**
 * Three-state freshness for paired bridge machines. The 90s "online" cutoff
 * is one-miss tolerance against the daemon's 60s heartbeat cadence. The
 * 5-minute "idle" cutoff acknowledges that occasional network jitter can
 * stretch the ping interval without meaning the daemon is dead. Beyond
 * 5 minutes we call it offline — the daemon has either died or the
 * machine is genuinely off.
 */
function bridgeState(ts: string | null, now: number): "online" | "idle" | "offline" {
  if (!ts) return "offline";
  const age = now - new Date(ts).getTime();
  if (age < FRESH_BRIDGE_MS) return "online";
  if (age < IDLE_BRIDGE_MS) return "idle";
  return "offline";
}
