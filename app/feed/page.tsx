/**
 * /feed — V6 Apex Phase 3 live event-bus tape.
 *
 * Server-rendered initial snapshot of the last hour of agent_events. The
 * server component reads via getServiceSupabase, then a tiny client island
 * re-fetches every 5s so the operator sees sibling-agent activity land in
 * near-real-time without paying for Supabase Realtime websocket quotas.
 *
 * The router daemon (scripts/event_router.py) maintains state/event_router.log
 * as the local-side projection. This page is the cloud-side view of the same
 * events — both read from agent_events; the router is the on-machine
 * observability tail, the feed is the operator-facing tail.
 */

import { headers } from "next/headers";
import { Activity, Radio, ArrowUpRight } from "lucide-react";
import { Card, PageHeader, Tag } from "@/components/Card";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { formatEventType, formatPublisher } from "@/lib/event-bus-display";
import { getActiveProfile } from "@/lib/queries";
import { getTenantAwareEnabledAgents } from "@/lib/manifest/tenant-scope";
import { isOperatorEmail } from "@/lib/operator-credentials";
import { FeedRefresher } from "./refresher";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type EventRow = {
  id: string;
  event_type: string;
  // B1 (2026-07-23): renamed from source_agent — every producer in this repo
  // writes publisher_agent (migration 006); source_agent is a later column
  // that defaults to 'unknown' and none of these producers set it, so
  // filtering/reading it made every locally-produced event invisible.
  publisher_agent: string | null;
  target_agent: string | null;
  severity: string | null;
  payload: Record<string, unknown> | null;
  published_at: string | null;
  created_at: string | null;
  status: string | null;
};

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000)        return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000)     return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000)    return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function preview(payload: Record<string, unknown> | null): string {
  if (!payload || typeof payload !== "object") return "—";
  const keys = ["note", "preview", "kind", "lead_id", "channel", "intent",
                "platform", "post_url", "amount_cad", "amount_usd",
                "net_mrr_usd", "v6_mode", "client", "invoice_id"];
  const pairs: string[] = [];
  for (const k of keys) {
    const v = (payload as Record<string, unknown>)[k];
    if (v === null || v === undefined || v === "") continue;
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    pairs.push(`${k}=${s.slice(0, 80)}`);
  }
  return pairs.length > 0 ? pairs.join(" · ") : "—";
}

function severityTone(s: string | null): "neutral" | "accent" | "warm" | "hot" {
  if (s === "error" || s === "critical") return "hot";
  if (s === "warn"  || s === "warning")  return "warm";
  if (s === "info")                       return "accent";
  return "neutral";
}

async function fetchInitial(args: {
  agentNames: string[];
  isOperator: boolean;
  tenantId: string | null;
}): Promise<{ rows: EventRow[]; error?: string }> {
  try {
    // Cross-tenant scoping (CodeRabbit PR #81 [Major], 2026-07-23): the
    // publisher_agent ∈ agentNames filter alone is agent-level, not
    // tenant-level — two tenants who both enable the same agent (e.g. both
    // on Kixie) match the SAME filter and would see each other's events
    // (recording URLs, dispositions, lead IDs). Mirrors the fail-closed
    // convention lib/queries.ts::recentEvents() now enforces: a non-operator
    // MUST have a resolved tenantId, and correlation_id (the tenant pointer
    // every producer stamps — see app/api/webhooks/kixie/route.ts) is
    // enforced on top of the agent-name filter. Operators bypass via the
    // empire-wide view, same as recentEvents().
    if (!args.isOperator && !args.tenantId) {
      return { rows: [] };
    }
    const db = getServiceSupabase();
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    let q = db
      .from("agent_events")
      .select(
        "id, event_type, publisher_agent, target_agent, severity, payload, " +
          "published_at, created_at, status",
      )
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(100);
    if (!args.isOperator) {
      if (args.agentNames.length === 0) {
        return { rows: [] };
      }
      q = q.in("publisher_agent", args.agentNames).eq("correlation_id", args.tenantId);
    }
    const r = await q;
    if (r.error) return { rows: [], error: r.error.message };
    return { rows: ((r.data || []) as unknown) as EventRow[] };
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : "fetch failed" };
  }
}

export default async function FeedPage() {
  await headers();
  const [profile, user] = await Promise.all([
    getActiveProfile().catch(() => null),
    getSessionUser().catch(() => null),
  ]);
  const isOperator = isOperatorEmail(user?.email || undefined);
  const agentNames = await getTenantAwareEnabledAgents({
    userTenantId: profile?.tenant_id ?? null,
    profileAgentsEnabled: profile?.agents_enabled ?? null,
  });
  const { rows, error } = await fetchInitial({
    agentNames,
    isOperator,
    tenantId: profile?.tenant_id ?? null,
  });

  const sources = Array.from(new Set(rows.map((r) => r.publisher_agent || "unknown"))).sort();

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Event Feed"
        subtitle="Cross-agent event-bus tape. Every agent action appears here in real time — outbound sends, status changes, lead activity, chat tool calls."
        action={
          <div className="flex items-center gap-2">
            <Tag tone="accent">{rows.length} events / 1h</Tag>
            <FeedRefresher />
          </div>
        }
      />

      {error && (
        <Card>
          <div className="flex items-start gap-3 p-2">
            <Activity size={20} className="text-status-hot shrink-0 mt-0.5" />
            <div>
              <div className="font-bold text-fg">Could not load event feed</div>
              <p className="text-sm text-fg-muted mt-1">{error}</p>
            </div>
          </div>
        </Card>
      )}

      {!error && rows.length === 0 && (
        <Card>
          <div className="text-sm text-fg-muted p-2">
            No agent events in the last hour. Idle window — siblings are quiet.
          </div>
        </Card>
      )}

      {sources.length > 0 && (
        <Card>
          <div className="text-xs text-fg-dim uppercase tracking-wider mb-2">
            Active sources (1h)
          </div>
          <div className="flex flex-wrap gap-2">
            {sources.map((s) => (
              <Tag key={s} tone="neutral">{s}</Tag>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <div className="flex items-center gap-2 mb-3">
          <Radio size={14} className="text-accent" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-fg-muted">
            Stream (newest first)
          </h2>
        </div>
        <div className="space-y-2 max-h-[70vh] overflow-y-auto pr-2">
          {rows.map((row) => (
            <div
              key={row.id}
              className="flex items-start gap-3 py-2 border-b border-bg-border last:border-0"
            >
              <div className="font-mono text-xs text-fg-faint w-20 shrink-0 pt-0.5">
                {relativeTime(row.created_at)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className="font-bold text-sm text-fg"
                    title={row.event_type}
                  >
                    {formatEventType(row.event_type)}
                  </span>
                  <Tag tone={severityTone(row.severity)}>{row.severity || "info"}</Tag>
                  <span className="text-xs text-fg-dim" title={row.publisher_agent || ""}>
                    {row.publisher_agent ? formatPublisher(row.publisher_agent) : "Unknown"}
                  </span>
                  <ArrowUpRight size={12} className="text-fg-faint" />
                  <span className="text-xs text-fg-dim" title={row.target_agent || ""}>
                    {row.target_agent ? formatPublisher(row.target_agent) : "Broadcast"}
                  </span>
                </div>
                <div className="text-xs text-fg-muted font-mono mt-1 truncate">
                  {preview(row.payload)}
                </div>
              </div>
              <span className="text-xs text-fg-faint shrink-0 pt-0.5">
                {row.status || "pending"}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
