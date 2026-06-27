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
import { resolveSessionContext } from "@/lib/api-auth";
import { getAccessibleLeadTarget } from "@/lib/lead-access";

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
  type: string | null;
  subject: string | null;
  content_preview: string | null;
  created_at: string | null;
  sent_at: string | null;
  to_email: string | null;
  to_phone: string | null;
  metadata: Record<string, unknown> | null;
  // Call lifecycle columns added in migration 093 (2026-06-01).
  recording_url: string | null;
  transcript_url: string | null;
  disposition: string | null;
  call_outcome: string | null;
  call_duration_sec: number | null;
  kixie_call_id: string | null;
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
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const sess = await resolveSessionContext();
  if (!sess.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const tenantId = sess.tenantId;
  const { id: recordId } = await ctx.params;
  if (!recordId) return NextResponse.json({ ok: false, error: "missing_id" }, { status: 400 });

  // Per-agent lock + entity resolve: an agent can't read another agent's
  // timeline by id, and the drawer opens for BOTH lead and application records.
  // For an application, the feeds are keyed by the LINKED lead id (Codex
  // 2026-06-19 MEDIUM — a lead-only gate 404'd every application drawer).
  const target = await getAccessibleLeadTarget(
    { isAdmin: sess.isAdmin, userId: sess.userId },
    { tenantId, id: recordId, entityParam: req.nextUrl.searchParams.get("entity") },
  );
  if (!target) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const leadId = target.queryLeadId;

  const db = getServiceSupabase();
  const events: TimelineEvent[] = [];
  const errors: { feed: string; message: string }[] = [];

  // Email opens are merged across BOTH feeds that record them — email_open_events
  // (the tracking-pixel store) AND agent_events BRAVO_EMAIL_OPENED (the event-bus
  // mirror) — keyed by the outbound message each open belongs to.
  //
  // De-noise (2026-06-27, CC: "should only say email opened once"). A single
  // delivered email generates many pixel hits: the pixel is served no-store, so
  // Gmail / Apple Mail image proxies re-fetch it repeatedly (live data: 23 hits
  // for ONE email to one lead), and the same open is mirrored into both tables.
  // We collapse to ONE timeline row per message and measure engagement as the
  // number of DISTINCT CALENDAR DAYS with a genuine (non-prefetch) open — so a
  // same-day storm of proxy re-fetches reads as a single "opened", while a real
  // re-open on a later day still surfaces as "· seen N days". Tracking days in a
  // Set also dedupes the two mirror feeds for free (same open, same day → one
  // entry), so the old cross-feed max() bookkeeping is gone. A prefetch is the
  // proxy fetching the image, not the recipient reading it, so it never counts.
  type OpenAgg = {
    earliestAt: string;
    latestAt: string;
    days: Set<string>;
    messageId: string | null;
  };
  const opensByMessage = new Map<string, OpenAgg>();
  const recordOpen = (
    messageId: string | null,
    fallbackKey: string,
    at: string,
    prefetch: boolean,
  ) => {
    if (prefetch) return; // proxy prefetch — not a real open
    const day = at.slice(0, 10); // YYYY-MM-DD bucket
    // Collapse key: the message id when present — this folds a proxy re-fetch
    // storm for ONE email into a single row, which is the whole fix. When the
    // message id is missing (legacy rows), we CANNOT know which email the open
    // belongs to, so fall back to the source row id and keep them separate —
    // merging unattributed opens by date would under-count legitimately
    // distinct opens.
    const key = messageId || fallbackKey;
    const prev = opensByMessage.get(key);
    if (!prev) {
      opensByMessage.set(key, {
        earliestAt: at,
        latestAt: at,
        days: new Set([day]),
        messageId,
      });
    } else {
      if (at < prev.earliestAt) prev.earliestAt = at;
      if (at > prev.latestAt) prev.latestAt = at;
      prev.days.add(day);
      if (!prev.messageId && messageId) prev.messageId = messageId;
    }
  };

  // 1. lead_interactions — both directions; the table mixes them via a
  //    direction column. Table name varies across legacy migrations; try
  //    lead_interactions first, then interactions. Record EACH failure
  //    so the drawer's "Partial: …" message names the real cause
  //    instead of silently swallowing the lead_interactions error and
  //    only surfacing the "interactions doesn't exist" fallback.
  // Feeds 1-5 are independent reads keyed by (tenant_id, lead_id); each has its
  // own try/catch and pushes into the shared events/errors/opens collectors,
  // which are merged + sorted by `at` afterward (order-independent). Run them as
  // ONE parallel wave instead of five serial round-trips — this is the
  // lead-drawer Timeline tab, one of the hottest operator reads (perf 2026-06-25).
  const feeds: Array<Promise<void>> = [];

  // Feed 1 — interactions (the lead_interactions → interactions fallback MUST
  // stay sequential inside this closure).
  feeds.push((async () => {
  let interactionLoaded = false;
  for (const table of ["lead_interactions", "interactions"]) {
    if (interactionLoaded) break;
    try {
      const { data, error } = await db
        .from(table)
        .select(
          "id, channel, direction, type, subject, content_preview, " +
            "created_at, sent_at, to_email, to_phone, metadata, " +
            "recording_url, transcript_url, disposition, call_outcome, " +
            "call_duration_sec, kixie_call_id",
        )
        .eq("tenant_id", tenantId)
        .eq("lead_id", leadId)
        .order("created_at", { ascending: false })
        .limit(150);
      if (error) throw error;
      interactionLoaded = true;
      for (const row of (data || []) as unknown as InteractionRow[]) {
        const at = row.sent_at || row.created_at;
        if (!at) continue;
        const direction = row.direction || "outbound";
        const channel = row.channel || "unknown";
        const isNote = channel === "note";
        const rowType = row.type || "";

        // Call-specific rendering. The phone channel + the call_* type
        // values from migration 093 / Phase 2 webhook give us a richer
        // headline than "Sent phone" / "Received phone."
        let title: string;
        let body: string | undefined = row.content_preview || undefined;

        if (isNote) {
          title = "📝 Note";
        } else if (channel === "phone") {
          const callLabel =
            rowType === "call_voicemail"
              ? "📞 Voicemail"
              : rowType === "call_ci_summary"
                ? "🧠 CI Summary"
                : rowType === "call_dispositioned"
                  ? "📞 Disposition set"
                  : rowType === "call_answered"
                    ? "📞 Answered"
                    : rowType === "call_ended"
                      ? "📞 Call ended"
                      : direction === "inbound"
                        ? "📞 Inbound call"
                        : "📞 Outbound call";
          const durationLabel = row.call_duration_sec
            ? `${Math.round(row.call_duration_sec / 60 * 10) / 10}m`
            : null;
          const dispositionLabel = row.disposition || row.call_outcome;
          title = [
            callLabel,
            durationLabel ? `· ${durationLabel}` : null,
            dispositionLabel ? `· ${dispositionLabel}` : null,
          ]
            .filter(Boolean)
            .join(" ");
          // Surface the recording / transcript URL inline when present
          // — operators can click straight from the timeline.
          const extras: string[] = [];
          if (row.recording_url) extras.push(`▶ Recording: ${row.recording_url}`);
          if (row.transcript_url) extras.push(`📄 Transcript: ${row.transcript_url}`);
          if (extras.length > 0) {
            body = [body, ...extras].filter(Boolean).join("\n");
          }
        } else {
          title = `${direction === "outbound" ? "Sent" : "Received"} ${channel}${row.subject ? `: ${row.subject}` : ""}`;
        }

        events.push({
          source: "interaction",
          type: isNote ? "note" : rowType || `${channel}_${direction}`,
          at,
          title,
          body,
          meta: {
            id: row.id,
            channel,
            to_email: row.to_email,
            to_phone: row.to_phone,
            metadata: row.metadata,
            recording_url: row.recording_url,
            transcript_url: row.transcript_url,
            disposition: row.disposition,
            call_outcome: row.call_outcome,
            call_duration_sec: row.call_duration_sec,
            kixie_call_id: row.kixie_call_id,
          },
        });
      }
    } catch (e: unknown) {
      errors.push({ feed: table, message: errMessage(e) });
    }
  }
  })());

  // 2. email_open_events
  feeds.push((async () => {
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
      // Merge (don't push) — emitted as one collapsed event per message below.
      recordOpen(
        row.outbound_message_id,
        `open:${row.id}`,
        row.opened_at,
        !!row.suspicious_prefetch,
      );
    }
  } catch (e: unknown) {
    errors.push({ feed: "email_open_events", message: errMessage(e) });
  }
  })());

  // 3. lead_documents
  feeds.push((async () => {
  try {
    const { data, error } = await db
      .from("lead_documents")
      .select("id, filename, doc_type, uploaded_by, uploaded_at, size_bytes")
      .eq("tenant_id", tenantId)
      .eq("lead_id", leadId)
      .is("metadata->>deleted_at", null) // Batch 5: exclude soft-deleted
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
  })());

  // 4. agent_events — stage transitions and lifecycle events. Note
  //    that agent_events has NO tenant_id column (migration 006) —
  //    tenant scope is carried by correlation_id (text). Filtering by
  //    `.eq("tenant_id", …)` was the bug that surfaced as the
  //    persistent "Partial: couldn't read agent_events" in the drawer.
  feeds.push((async () => {
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
      // BRAVO_EMAIL_OPENED is the event-bus mirror of an email open — route it
      // into the same merge as email_open_events instead of rendering its own
      // "Email opened" row, so opens aren't double-counted across the two feeds
      // and proxy prefetches don't each show as an open.
      if (row.event_type === "BRAVO_EMAIL_OPENED") {
        const p = row.payload || {};
        const mid =
          typeof p.outbound_message_id === "string" ? p.outbound_message_id : null;
        const prefetch =
          p.suspicious_prefetch === true || p.suspicious_prefetch === "true";
        recordOpen(mid, `evt:${row.id}`, at, prefetch);
        continue;
      }
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
  })());

  // 5. agent_alerts — missing_info + future operator-side notifications.
  feeds.push((async () => {
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
  })());

  // Barrier: all five feeds resolve before we collapse opens + sort. Each feed
  // already swallows its own errors into errors[], so no feed can reject here.
  await Promise.all(feeds);

  // Emit one collapsed "Email opened" per message that had ≥1 genuine open.
  // Messages with only proxy prefetches contribute nothing here (days stays
  // empty), so a prefetched-but-unread email never shows as "opened". The
  // engagement signal is the count of DISTINCT DAYS opened — same-day proxy
  // re-fetch storms collapse to a single open; a genuine re-open on another day
  // surfaces as "· seen N days" rather than an inflated hit count.
  for (const agg of opensByMessage.values()) {
    const days = agg.days.size;
    if (days < 1) continue;
    events.push({
      source: "email_open",
      type: "open",
      at: agg.earliestAt,
      title: days > 1 ? `👁 Email opened · seen ${days} days` : "👁 Email opened",
      meta: {
        outbound_message_id: agg.messageId,
        open_days: days,
        last_open_at: agg.latestAt,
      },
    });
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
  // BRAVO_EMAIL_OPENED is intercepted before humanize (merged into the collapsed
  // open events above), so it never reaches here.
  if (t === "BRAVO_OUTBOUND_QUEUED_FROM_DASHBOARD") return "📤 Email queued";
  if (t === "BRAVO_LEAD_MISSING_INFO") return "⚠ Missing info detected";
  if (t === "BRAVO_OUTBOUND_SENT") return "✉ Outbound sent";
  return t.replace(/^BRAVO_/, "").replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}
