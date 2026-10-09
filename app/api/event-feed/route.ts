/**
 * /api/event-feed
 *
 * GET — returns the most recent agent_events rows for the dashboard feed.
 *       Service-role read with simple time-window + limit. Used by both the
 *       /feed page (server-side initial render) and any client-side poller
 *       that wants a typed snapshot of recent activity.
 *
 * Query params:
 *   since_minutes — default 60, max 1440 (24h)
 *   limit         — default 100, max 500
 *   source        — optional filter on publisher_agent
 *   event_type    — optional exact-match filter
 *
 * WHO READS WHAT (2026-10-02). A member reads exactly what the /feed page
 * shows them, from the same gate and the same scope (feed-model.ts
 * feedViewerScope): their own workspace's events, only if the rail opens the
 * Feed for them and they are in the tape's audience (canSeeSystemSurfaces),
 * cut to the departments they can open and to money they may read. Before,
 * any member with a session read the raw payload of every event in their
 * workspace, a commission-only rep included. A customer's own words (their
 * phone number and message, feed-model.ts CUSTOMER_MESSAGE_KEY) are kept only
 * for a viewer of that customer's own workspace who may see client
 * identities. The operator's cross-workspace read (Admin > Event log) keeps
 * every event but drops other businesses' customers from them.
 *
 * COLUMN NOTE (B1, 2026-07-23): every producer in this repo (Kixie webhook,
 * lib/manifest/events.ts, action-log.ts, kixie-compliance-scan, etc.) writes
 * `publisher_agent` — none set `source_agent` (a later migration-015 column
 * that defaults to 'unknown' and is only backfilled from publisher_agent for
 * rows that existed at migration time). Reading/filtering on source_agent
 * here previously meant every locally-produced event was invisible to this
 * filter. Read publisher_agent to match the write path.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { bad } from "@/lib/api-helpers";
import { isPlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { mayOpenOsHref } from "@/lib/os/nav";
import { resolveOsPageViewer } from "@/components/os/landings/page-gate";
import {
  feedViewerScope,
  visibleFeedRows,
  withCustomerMessagesFor,
  type FeedEventRow,
} from "@/components/os/landings/feed-model";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type FeedRow = FeedEventRow & { correlation_id: string | null };

export async function GET(req: NextRequest) {
  // Auth gate: response includes agent_events payloads (record IDs, lead
  // context, command summaries, error details). Unauthed read = open scrape.
  const user = await getSessionUser().catch(() => null);
  if (!user) return bad(401, "unauthorized");
  // The operator reads every tenant's events, so this is the verified check
  // (alias AND owner/admin OASIS membership by auth id), never the email alone.
  // A failed lookup answers "not an operator" and scopes the read to a tenant.
  const isOperator = await isPlatformOperatorForAuthUser(user.id, user.email);
  // The viewer's workspace and rail: the inputs the /feed page gates on.
  const viewer = await resolveOsPageViewer();
  let tenantId: string | null = null;
  if (!isOperator) {
    if (!viewer) return bad(401, "unauthorized");
    // The page's own gate (requireOsRoute("/feed")), then the tape's audience.
    if (!mayOpenOsHref(viewer.navInput, "/feed") || !viewer.surface.capabilities.canSeeSystemSurfaces) {
      return bad(403, "forbidden");
    }
    tenantId = viewer.surface.tenantId;
  }

  const url = new URL(req.url);
  const sinceMinutes = Math.min(
    Math.max(parseInt(url.searchParams.get("since_minutes") || "60", 10) || 60, 1),
    1440,
  );
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1),
    500,
  );
  const source = url.searchParams.get("source");
  const eventType = url.searchParams.get("event_type");

  try {
    const db = getServiceSupabase();
    const cutoff = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString();

    let q = db
      .from("agent_events")
      .select(
        "id, event_type, publisher_agent, target_agent, severity, payload, " +
          "published_at, created_at, status, correlation_id",
      )
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(limit);

    // Tenants see only their own events; operators (CC) see everything.
    // correlation_id is the canonical tenant pointer on agent_events —
    // every producer (kixie webhook, state_manager, bridge events) sets
    // it to the originating tenant_id.
    if (tenantId) q = q.eq("correlation_id", tenantId);
    if (source) q = q.eq("publisher_agent", source);
    if (eventType) q = q.eq("event_type", eventType);

    const { data, error } = await q;
    if (error) return bad(500, error.message);

    let rows = (data || []) as unknown as FeedRow[];
    if (!isOperator && viewer) {
      rows = visibleFeedRows(rows, feedViewerScope(viewer.navInput, viewer.surface.capabilities));
    }
    const ownTenantId = viewer?.surface.tenantId ?? null;
    const mayReadCustomers = viewer?.surface.capabilities.canSeeClientIdentities === true;
    rows = withCustomerMessagesFor(
      rows,
      (row) => mayReadCustomers && ownTenantId !== null && row.correlation_id === ownTenantId,
    );

    return NextResponse.json({
      ok: true,
      window_minutes: sinceMinutes,
      count: rows.length,
      rows,
    });
  } catch (err) {
    return bad(500, err instanceof Error ? err.message : "feed fetch failed");
  }
}
