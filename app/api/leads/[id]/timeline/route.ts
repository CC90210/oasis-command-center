/**
 * GET /api/leads/[id]/timeline
 *
 * Phase 18 of the SunBiz CRM Reconstructor build (2026-05-17). Returns
 * the chronological merge of every event that involves this lead — what
 * the operator sees as the "Conversation timeline" tab on the lead
 * drawer.
 *
 * Source feeds (all tenant-scoped):
 *   - lead_interactions          outbound + inbound SMS/email
 *   - email_open_events           tracking-pixel hits (Phase 19)
 *   - lead_documents              uploaded artefacts (Phase 18/21)
 *   - agent_events                stage changes + system events
 *   - application_lender_threads  lender shop-out + replies
 *   - agent_alerts                operator-facing alerts (Phase 20)
 *
 * Each feed is normalised into a TimelineEvent and merged by `at` desc.
 * The route serves the merged feed as JSON; the drawer's Timeline
 * component renders it with per-source icons + per-event detail.
 *
 * No mutations. Pure read.
 *
 * Failure mode: a single feed's failure doesn't break the response —
 * we return the feeds that did load with a per-feed `errors` array so
 * the UI can show partial state instead of a blank panel.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveTenantId } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TimelineEvent = {
  source: string;
  type: string;
  at: string; // ISO 8601
  title: string;
  body?: string;
  meta?: Record<string, unknown>;
};

// Per-feed row shapes — narrow types match the columns each select
// statement requests. Optional everywhere because legacy migrations
// may have left some columns null on historic rows.
type InteractionRow = {
  id: string;
  channel: string | null;
  direction: string | null;
  subject: string | null;
  content_preview: string | null;
  created_at: string | null;
  sent_at: string | null;
  to_email: string | null;
  to_phone: string | null;
  metadata: Record<string, unknown> | null;
};
type EmailOpenRow = {
  id: string;
  outbound_message_id: string | null;
  opened_at: string | null;
  suspicious_prefetch: boolean | null;
  user_agent: string | null;
};
type DocumentRow = {
  id: string;
  filename: string;
  doc_type: string | null;
  uploaded_by: string | null;
  uploaded_at: string | null;
  size_bytes: number | null;
};
type AgentEventRow = {
  id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  published_at: string | null;
  created_at: string | null;
};
type AgentAlertRow = {
  id: string;
  alert_type: string;
  severity: string | null;
  title: string;
  body: string | null;
  created_at: string | null;
  resolved_at: string | null;
};

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

const HARD_CAP = 250; // events returned per request — drawer paginates further if ever needed

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const tenantId = await resolveTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { id: leadId } = await ctx.params;
  if (!leadId) return NextResponse.json({ ok: false, error: "missing_id" }, { status: 400 });

  const db = getServiceSupabase();
  const events: TimelineEvent[] = [];
  const errors: { feed: string; message: string }[] = [];

  // 1. lead_interactions — both directions; the table mixes them via a
  //    direction column. Table name varies across legacy migrations; try
  //    lead_interactions first, then interactions. Record EACH failure
  //    so the drawer's "Partial: …" message names the real cause
  //    instead of silently swallowing the lead_interactions error and
  //    only surfacing the "interactions doesn't exist" fallback.
  let interactionLoaded = false;
  for (const table of ["lead_interactions", "interactions"]) {
    if (interactionLoaded) break;
    try {
      const { data, error } = await db
        .from(table)
        .select("id, channel, direction, subject, content_preview, created_at, sent_at, to_email, to_phone, metadata")
        .eq("tenant_id", tenantId)
        .eq("lead_id", leadId)
        .order("created_at", { ascending: false })
        .limit(150);
      if (error) throw error;
      interactionLoaded = true;
      for (const row of (data || []) as InteractionRow[]) {
        const at = row.sent_at || row.created_at;
        if (!at) continue;
        const direction = row.direction || "outbound";
        const channel = row.channel || "unknown";
        const isNote = channel === "note";
        events.push({
          source: "interaction",
          type: isNote ? "note" : `${channel}_${direction}`,
          at,
          title: isNote
            ? "📝 Note"
            : `${direction === "outbound" ? "Sent" : "Received"} ${channel}${row.subject ? `: ${row.subject}` : ""}`,
          body: row.content_preview || undefined,
          meta: {
            id: row.id,
            channel,
            to_email: row.to_email,
            to_phone: row.to_phone,
            metadata: row.metadata,
          },
        });
      }
    } catch (e: unknown) {
      errors.push({ feed: table, message: errMessage(e) });
    }
  }

  // 2. email_open_events
  try {
    const { data, error } = await db
      .from("email_open_events")
      .select("id, outbound_message_id, opened_at, suspicious_prefetch, user_agent")
      .eq("tenant_id", tenantId)
      .eq("lead_id", leadId)
      .order("opened_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    for (const row of (data || []) as EmailOpenRow[]) {
      if (!row.opened_at) continue;
      events.push({
        source: "email_open",
        type: row.suspicious_prefetch ? "open_prefetch" : "open",
        at: row.opened_at,
        title: row.suspicious_prefetch ? "📨 Email open (prefetch)" : "👁 Email opened",
        meta: {
          outbound_message_id: row.outbound_message_id,
          user_agent: row.user_agent,
        },
      });
    }
  } catch (e: unknown) {
    errors.push({ feed: "email_open_events", message: errMessage(e) });
  }

  // 3. lead_documents
  try {
    const { data, error } = await db
      .from("lead_documents")
      .select("id, filename, doc_type, uploaded_by, uploaded_at, size_bytes")
      .eq("tenant_id", tenantId)
      .eq("lead_id", leadId)
      .order("uploaded_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    for (const row of (data || []) as DocumentRow[]) {
      if (!row.uploaded_at) continue;
      events.push({
        source: "document",
        type: "uploaded",
        at: row.uploaded_at,
        title: `📎 Document: ${row.filename}`,
        body: row.doc_type && row.doc_type !== "unclassified" ? `Classified as ${row.doc_type}` : undefined,
        meta: {
          id: row.id,
          uploaded_by: row.uploaded_by,
          size_bytes: row.size_bytes,
        },
      });
    }
  } catch (e: unknown) {
    errors.push({ feed: "lead_documents", message: errMessage(e) });
  }

  // 4. agent_events — stage transitions and lifecycle events. Note
  //    that agent_events has NO tenant_id column (migration 006) —
  //    tenant scope is carried by correlation_id (text). Filtering by
  //    `.eq("tenant_id", …)` was the bug that surfaced as the
  //    persistent "Partial: couldn't read agent_events" in the drawer.
  try {
    const { data, error } = await db
      .from("agent_events")
      .select("id, event_type, payload, published_at, created_at")
      .eq("correlation_id", tenantId)
      .contains("payload", { lead_id: leadId })
      .order("published_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    for (const row of (data || []) as AgentEventRow[]) {
      const at = row.published_at || row.created_at;
      if (!at) continue;
      events.push({
        source: "system",
        type: row.event_type,
        at,
        title: humanizeEventType(row.event_type),
        meta: row.payload || {},
      });
    }
  } catch (e: unknown) {
    errors.push({ feed: "agent_events", message: errMessage(e) });
  }

  // 5. agent_alerts — missing_info + future operator-side notifications.
  try {
    const { data, error } = await db
      .from("agent_alerts")
      .select("id, alert_type, severity, title, body, created_at, resolved_at")
      .eq("tenant_id", tenantId)
      .eq("subject_type", "lead")
      .eq("subject_id", leadId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    for (const row of (data || []) as AgentAlertRow[]) {
      if (!row.created_at) continue;
      events.push({
        source: "alert",
        type: row.alert_type,
        at: row.created_at,
        title: `⚠ ${row.title}`,
        body: row.body || undefined,
        meta: {
          severity: row.severity,
          resolved_at: row.resolved_at,
        },
      });
    }
  } catch (e: unknown) {
    errors.push({ feed: "agent_alerts", message: errMessage(e) });
  }

  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return NextResponse.json({
    ok: true,
    lead_id: leadId,
    events: events.slice(0, HARD_CAP),
    truncated: events.length > HARD_CAP,
    errors,
  });
}

function humanizeEventType(t: string): string {
  if (!t) return "Event";
  if (t === "BRAVO_RECORD_STATUS_CHANGED") return "🔄 Stage changed";
  if (t === "BRAVO_LEAD_AUTO_BUMPED") return "🔄 Stage auto-advanced";
  if (t === "BRAVO_EMAIL_OPENED") return "👁 Email opened";
  if (t === "BRAVO_OUTBOUND_QUEUED_FROM_DASHBOARD") return "📤 Email queued";
  if (t === "BRAVO_LEAD_MISSING_INFO") return "⚠ Missing info detected";
  if (t === "BRAVO_OUTBOUND_SENT") return "✉ Outbound sent";
  return t.replace(/^BRAVO_/, "").replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}
