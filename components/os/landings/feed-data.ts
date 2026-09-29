/**
 * feed-data — the Feed's one read of agent_events, ALWAYS scoped to one
 * workspace.
 *
 * THERE IS NO CROSS-TENANT BRANCH HERE, FOR ANYONE. The old /feed and
 * /api/event-feed both switched to an unscoped, empire-wide read when the
 * session email was on the operator list (isOperatorEmail — an email string,
 * the exact test Phase 0 retired). The design keeps that branch for Admin ›
 * Event log only (01 §(c) Feed). So an operator standing in OASIS sees OASIS's
 * rows here, like every other member of a workspace sees their own.
 *
 * correlation_id is the tenant pointer every producer stamps (see
 * app/api/webhooks/kixie/route.ts, lib/manifest/events.ts, lib/action-log.ts);
 * agent_events has no tenant_id column yet. A row a producer did not stamp
 * matches no workspace and is never shown — fail closed.
 *
 * Not lib/queries.ts recentEvents(): that one drops `r.error`, so a failed
 * read renders as an empty, quiet feed. A Feed that cannot load has to say so.
 */
import "server-only";

import { getServiceSupabase } from "@/lib/supabase-server";
import type { FeedEventRow } from "@/components/os/landings/feed-model";

export const FEED_WINDOW_DAYS = 7;
export const FEED_LIMIT = 150;

export type TenantFeed =
  | { ok: true; rows: FeedEventRow[]; windowDays: number; truncated: boolean }
  | { ok: false; error: string };

/**
 * The workspace's recent events, newest first. `tenantId` is required and
 * must come from the session (resolveViewerSurface), never from the request.
 */
export async function loadTenantFeed(args: {
  tenantId: string;
  windowDays?: number;
  limit?: number;
  /** Test seam (same as recentEvents' opts.db); production passes nothing. */
  db?: ReturnType<typeof getServiceSupabase>;
}): Promise<TenantFeed> {
  const tenantId = (args.tenantId || "").trim();
  // An empty id must never reach the query as "no filter".
  if (!tenantId) return { ok: false, error: "no workspace" };
  const windowDays = args.windowDays ?? FEED_WINDOW_DAYS;
  const limit = args.limit ?? FEED_LIMIT;
  try {
    const db = args.db ?? getServiceSupabase();
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    const r = await db
      .from("agent_events")
      .select("id, event_type, publisher_agent, target_agent, severity, payload, published_at, created_at, status")
      .eq("correlation_id", tenantId)
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(limit + 1);
    if (r.error) {
      console.error("[os.feed.read]", r.error.message);
      return { ok: false, error: r.error.message };
    }
    const all = (Array.isArray(r.data) ? r.data : []) as FeedEventRow[];
    return { ok: true, rows: all.slice(0, limit), windowDays, truncated: all.length > limit };
  } catch (err) {
    console.error("[os.feed.read]", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
