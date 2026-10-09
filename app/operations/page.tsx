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
 *
 * OPERATOR ONLY (2026-09-30): requireOperator() is the first statement. It used
 * requireSystemSurface, which let a client workspace's owner open it by URL.
 * The tiles at the top come from lib/admin/attention.ts, the same definition
 * of "needs you" /health uses, so the two pages cannot disagree.
 */

import Link from "next/link";
import { Card, PageHeader, Tag, EmptyState } from "@/components/Card";
import { agentStates, getActiveProfile, getTenant, recentDecisions, recentEvents } from "@/lib/queries";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { safe } from "@/lib/api-helpers";
import { getServiceSupabase } from "@/lib/supabase-server";
import { FAMILY_AGENT_KEYS, getAgentInfo, resolveAgentKey } from "@/lib/agents";
import { getTenantAwareEnabledAgents, oasisOperatorAgents } from "@/lib/manifest/tenant-scope";
import { timeAgo, truncate } from "@/lib/fmt";
import { AgentDecisionsCard } from "@/components/AgentDecisionsCard";
import { buildRecordResolver, projectEvent } from "@/lib/event-projection";
import { WarmPoolPanel } from "@/components/WarmPoolPanel";
import { BridgeCliPanel } from "@/components/BridgeCliPanel";
import { requireOperator } from "@/lib/role-surfaces-session";
import { loadAttentionSummary, loadWorkspaceOutcome, nothingNeedsYou } from "@/lib/admin/attention";
import { machineState, type MachineState } from "@/lib/devices/presence";

export const dynamic = "force-dynamic";

const FRESH_AGENT_MS = 15 * 60 * 1000;
// A paired machine is online, idle or offline by the one rule every screen
// uses (lib/devices/presence.ts machineState); this page kept its own 90 s and
// 5 min cutoffs while Devices said 5 min and Background workers 2 min.

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
  await requireOperator();
  const profile = await safe("operations.profile", getActiveProfile(), null);
  const db = getServiceSupabase();
  const sp = (await searchParams) || {};
  const showOlder = sp.showOlder === "1";

  // This is a workspace surface, including for the OASIS operator. Resolve the
  // current tenant's enabled roster with no empire-wide operator bypass; an
  // operator debugging another workspace must first switch into that tenant.
  // OASIS's own workspace lists the agents its bridge runs, which since W4a is
  // not its business roster of department leads (review R4).
  const agentNamesForOps =
    oasisOperatorAgents(profile?.tenant_id) ??
    (await getTenantAwareEnabledAgents({
      userTenantId: profile?.tenant_id ?? null,
      profileAgentsEnabled: profile?.agents_enabled || [],
    }));

  // The tiles at the top: lib/admin/attention.ts, the one definition of
  // "needs you" (/health draws the same numbers with their lists).
  const tenantId = profile?.tenant_id || null;

  // Every read below throws on a failed read, the lib/queries ones and the
  // inline ones alike; safe() turns that into null, which each card and tile
  // draws as "Couldn't check", never as an empty tape, a fleet of stopped
  // workers, "0 bridges online" or a green 0 under "All clear".
  const [snaps, pairings, events, decisions, attention, outcome] = await Promise.all([
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
      null
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
            if (r.error) throw new Error(`bridge_pairings read failed: ${r.error.message}`);
            return (r.data as BridgePair[]) || [];
          })(),
          null
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
        isOperator: false,
      }),
      null
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
      null
    ),
    // null tenant: every tile says Couldn't check (nothing was read).
    tenantId
      ? loadAttentionSummary(tenantId)
      : Promise.resolve({ errors: null, warnings: null, cronFailures: null, workersDown: null, coldLeads: null }),
    // The outcome checks (OASIS: the founder-booking check) count into "All
    // clear" exactly as they count into /health's header. Never throws.
    tenantId
      ? safe("operations.tenant", getTenant(tenantId), null).then((tenant) =>
          loadWorkspaceOutcome(tenantId, tenant ? resolveClientProfileSlug(tenant) : null, Date.now()),
        )
      : Promise.resolve(null),
  ]);
  const snapByName = new Map((snaps ?? []).map((s) => [s.agent_name, s] as const));

  // Resolve lead/record UUIDs in event payloads to human names in one batch
  // query. Without this the Activity Tape renders lines like
  // "lead_id=ff7dcd57-87b5-4823-8a31-…" which is meaningless to an operator.
  // Falls back to first-8-char UUID prefix on miss so the row is still
  // identifiable.
  const recordResolver = await safe(
    "operations.record_resolver",
    buildRecordResolver(db, events ?? [], { tenantId }),
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
  const enabled = agentNamesForOps.filter((key) => familySet.has(resolveAgentKey(key)));
  const now = Date.now();
  // Online machines by the one rule; the header counts only those, never idle ones.
  const onlineCount = (pairings ?? []).filter((p) => machineState(p.last_seen_at, now) === "online").length;

  // "All clear" is /health's "Nothing needs you" (lib/admin/attention.ts
  // needsYouCount): every alarm count read and zero, and no outcome-check
  // signal. A count that could not be read is not a zero.
  const allClear = nothingNeedsYou(attention, outcome);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Operations"
        subtitle="Background workers, paired machines, and the live event tape — what's running right now."
        action={
          pairings === null ? (
            <Tag tone="neutral">Bridges: couldn&apos;t check</Tag>
          ) : (
            <Tag tone={onlineCount > 0 ? "engaged" : "warm"}>
              {onlineCount} bridge{onlineCount === 1 ? "" : "s"} online
            </Tag>
          )
        }
      />

      {/* What needs you: the same counts /health lists row by row. */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <HealthMiniTile label="Errors today" count={attention.errors} tone={attention.errors === 0 ? "engaged" : "warm"} href="/health" hint="Errors in the last 24 hours. System health lists each one." />
        <HealthMiniTile label="Warnings today" count={attention.warnings} tone={attention.warnings === 0 ? "engaged" : "accent"} href="/health" hint="Warnings in the last 24 hours: things that went wrong but kept running." />
        <HealthMiniTile label="Failed automations" count={attention.cronFailures} tone={attention.cronFailures === 0 ? "engaged" : "warm"} href="/health" hint="Schedules whose run in the last 24 hours errored. System health says what to do about each." />
        <HealthMiniTile label="Workers down" count={attention.workersDown} tone={attention.workersDown === 0 ? "engaged" : "warm"} href="/health" hint="Background processes on your computer that stopped reporting or report themselves down." />
        <HealthMiniTile label="Cold leads" count={attention.coldLeads} tone={attention.coldLeads === 0 ? "engaged" : "accent"} href="/pipeline" hint="Pipeline leads nobody has touched in 14 days or more." />
      </div>
      {allClear && (
        <div className="text-xs text-status-engaged">All clear — nothing needs your attention.</div>
      )}
      {outcome && outcome.signalCount > 0 && (
        <div className="text-xs text-status-warm">
          Outcome checks: {outcome.signalCount} need{outcome.signalCount === 1 ? "s" : ""} you.{" "}
          <Link href="/health" className="underline">System health</Link> lists them.
        </div>
      )}

      <Card
        title="Agent workers"
        subtitle="Each agent runs an autonomous reasoning loop on its own machine. A green dot means it cycled within the last 15 min."
      >
        {snaps === null ? (
          <EmptyState message="Couldn't check the agent heartbeats. The read failed and has been logged; this does not mean the workers stopped. Reload to try again." />
        ) : (
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
        )}
      </Card>

      <Card title="Paired machines" subtitle="Local installs heartbeating to this dashboard. Add a new one from Settings → Devices.">
        {pairings === null ? (
          <EmptyState message="Couldn't check the paired machines. The read failed and has been logged; this does not mean none are paired. Reload to try again." />
        ) : pairings.length === 0 ? (
          <EmptyState
            message="No machines paired yet."
            cta={
              <Link href="/settings/devices" className="btn-primary inline-flex items-center gap-1">
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
        subtitle="Which AI command-line tools your computer's bridge found, and whether each is signed in, as the bridge last reported."
      >
        <BridgeCliPanel serverBridgeOnline={pairings === null ? null : onlineCount > 0} />
      </Card>

      <Card
        title="Warm process pool"
        subtitle="The chat processes your computer keeps warm, so the next Coding harness turn skips a 5 to 30 second start. Read through the Command Center, never from this browser."
      >
        <WarmPoolPanel />
      </Card>

      <Card
        id="activity-tape"
        title="Activity tape"
        subtitle={
          events === null
            ? "Couldn't check the event tape just now."
            : showOlder
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
        {events === null ? (
          <EmptyState message="Couldn't check the activity tape. The read failed and has been logged; this does not mean nothing ran. Reload to try again." />
        ) : events.length === 0 ? (
          <EmptyState
            message="No events recorded yet. Events land here when a schedule runs, an inbound email is classified, or an agent changes dashboard data."
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
  /** null = the count could not be read: a neutral "Couldn't check", never a 0. */
  count: number | null;
  tone: "engaged" | "warm" | "accent" | "hot";
  href: string;
  hint?: string;
}) {
  const toneClass =
    count === null
      ? "border-bg-border bg-bg-elev text-fg-muted"
      : tone === "engaged"
        ? "border-status-engaged/30 bg-status-engaged/5 text-status-engaged"
        : tone === "warm"
          ? "border-status-warm/40 bg-status-warm/5 text-status-warm"
          : tone === "hot"
            ? "border-status-hot/40 bg-status-hot/5 text-status-hot"
            : "border-accent/40 bg-accent/5 text-accent";
  return (
    <a
      href={href}
      title={count === null ? "This count could not be read; the error has been logged. Reload to try again." : hint}
      className={`rounded-lg border px-3 py-2 transition-opacity hover:opacity-80 ${toneClass}`}
    >
      <div className="text-[10px] uppercase tracking-wider font-bold opacity-70">{label}</div>
      {count === null ? (
        <div className="text-sm font-bold mt-1.5">Couldn&apos;t check</div>
      ) : (
        <div className="text-2xl font-bold mt-0.5">{count}</div>
      )}
    </a>
  );
}

function isFresh(ts: string | null, now: number, threshold: number): boolean {
  if (!ts) return false;
  return now - new Date(ts).getTime() < threshold;
}

/** A paired machine's state, by the one rule (lib/devices/presence.ts). */
function bridgeState(ts: string | null, now: number): MachineState {
  return machineState(ts, now);
}
