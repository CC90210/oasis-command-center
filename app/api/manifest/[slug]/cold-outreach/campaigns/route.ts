/**
 * GET  /api/manifest/<slug>/cold-outreach/campaigns
 * POST /api/manifest/<slug>/cold-outreach/campaigns
 *
 * Campaign lifecycle entry point. The cold_outreach_runner.py daemon drains
 * campaigns at status='queued' by sending messages via send_gateway for each
 * pending recipient row.
 *
 * GET query params:
 *   limit        (default 10) — how many campaigns to return, newest first
 *   cold_list_id (optional)   — filter to campaigns targeting a specific list
 *
 * GET returns: { ok: true, campaigns: Campaign[] }
 *
 * POST body:
 *   {
 *     cold_list_id:     string,                           // required
 *     channel:          'sms_twilio'|'sms_texttorrent'|'email', // required
 *     message_body:     string,                           // required
 *     subject?:         string,                           // email only
 *     recipient_filter?: { stage?: string, max_attempts?: number },
 *     daily_cap?:       number (default 500, max 5000),
 *     name?:            string (auto-generated if omitted),
 *     scheduled_for?:   ISO-8601 string
 *   }
 *
 * POST behavior:
 *   1. Resolve tenant, auth-gate.
 *   2. Validate channel.
 *   3. Confirm cold_list_id belongs to this tenant.
 *   4. Apply recipient_filter to count matching cold_leads.
 *   5. Reject if total_recipients = 0.
 *   6. INSERT cold_outreach_campaigns at status='queued'.
 *   7. INSERT one cold_outreach_recipients row per matching lead.
 *   8. UPDATE campaign.total_recipients.
 *
 * POST returns: { ok: true, campaign_id, total_recipients }
 *
 * Auth: session required + caller must own this slug (resolveDataTenant).
 */

import { NextRequest, NextResponse } from "next/server";
import { redactAll } from "@/lib/secret-redaction";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { resolveDataTenant } from "@/lib/manifest/tenant-scope";
import { manifestExists } from "@/lib/manifest/loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_CHANNELS = ["sms_twilio", "sms_texttorrent", "email"] as const;
type Channel = typeof ALLOWED_CHANNELS[number];
const DAILY_CAP_MAX = 5_000;
const DAILY_CAP_DEFAULT = 500;

type RecipientFilter = {
  stage?: string;
  max_attempts?: number;
};

async function resolveContext(
  userId: string,
  slug: string,
): Promise<
  | { ok: true; tenantId: string }
  | { ok: false; status: number; error: string }
> {
  if (!SLUG_RE.test(slug)) return { ok: false, status: 400, error: "invalid_slug" };
  if (!(await manifestExists(slug))) return { ok: false, status: 404, error: "unknown_tenant" };

  const db = getServiceSupabase();
  const profileRes = await db
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  const userTenantId =
    (profileRes.data as { tenant_id: string | null } | null)?.tenant_id ?? null;

  const dataTenantId = await resolveDataTenant(slug, userTenantId);
  if (!dataTenantId) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  return { ok: true, tenantId: dataTenantId };
}

// ---------------------------------------------------------------------------
// GET — list campaigns
// ---------------------------------------------------------------------------

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const context = await resolveContext(user.id, slug);
  if (!context.ok) {
    return NextResponse.json({ ok: false, error: context.error }, { status: context.status });
  }

  const sp = req.nextUrl.searchParams;
  const limitRaw = sp.get("limit");
  const limit =
    limitRaw !== null && !Number.isNaN(Number(limitRaw))
      ? Math.max(1, Math.min(100, Number(limitRaw)))
      : 10;
  const coldListId = sp.get("cold_list_id") ?? null;

  const db = getServiceSupabase();

  let query = db
    .from("cold_outreach_campaigns")
    .select(
      "id, name, channel, status, cold_list_id, message_body, subject, recipient_filter, " +
      "total_recipients, sent_count, failed_count, daily_cap, scheduled_for, " +
      "started_at, completed_at, created_at",
    )
    .eq("tenant_id", context.tenantId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (coldListId && UUID_RE.test(coldListId)) {
    query = query.eq("cold_list_id", coldListId);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json(
      { ok: false, error: "db_error", detail: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, campaigns: data ?? [] });
}

// ---------------------------------------------------------------------------
// POST — create + queue a campaign
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const context = await resolveContext(user.id, slug);
  if (!context.ok) {
    return NextResponse.json({ ok: false, error: context.error }, { status: context.status });
  }

  let body: {
    cold_list_id?: unknown;
    channel?: unknown;
    message_body?: unknown;
    subject?: unknown;
    recipient_filter?: unknown;
    daily_cap?: unknown;
    name?: unknown;
    scheduled_for?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  // Validate required fields.
  const coldListId = typeof body.cold_list_id === "string" ? body.cold_list_id.trim() : "";
  if (!coldListId || !UUID_RE.test(coldListId)) {
    return NextResponse.json({ ok: false, error: "cold_list_id_required" }, { status: 400 });
  }

  const channel = typeof body.channel === "string" ? body.channel : "";
  if (!(ALLOWED_CHANNELS as readonly string[]).includes(channel)) {
    return NextResponse.json(
      { ok: false, error: "invalid_channel", allowed: ALLOWED_CHANNELS },
      { status: 400 },
    );
  }

  const messageBody = typeof body.message_body === "string" ? body.message_body.trim() : "";
  if (!messageBody) {
    return NextResponse.json({ ok: false, error: "message_body_required" }, { status: 400 });
  }

  const subject =
    channel === "email" && typeof body.subject === "string" && body.subject.trim()
      ? body.subject.trim()
      : null;

  const dailyCap =
    typeof body.daily_cap === "number" && body.daily_cap > 0
      ? Math.min(body.daily_cap, DAILY_CAP_MAX)
      : DAILY_CAP_DEFAULT;

  const scheduledFor =
    typeof body.scheduled_for === "string" && body.scheduled_for.trim()
      ? body.scheduled_for.trim()
      : null;

  // Parse recipient_filter safely.
  const rawFilter = body.recipient_filter;
  const recipientFilter: RecipientFilter =
    rawFilter && typeof rawFilter === "object" && !Array.isArray(rawFilter)
      ? (rawFilter as RecipientFilter)
      : {};

  const db = getServiceSupabase();

  // Confirm the list belongs to this tenant.
  const { data: listRow, error: listErr } = await db
    .from("cold_lead_lists")
    .select("id, name")
    .eq("id", coldListId)
    .eq("tenant_id", context.tenantId)
    .is("archived_at", null)
    .maybeSingle();

  if (listErr || !listRow) {
    return NextResponse.json({ ok: false, error: "list_not_found" }, { status: 404 });
  }

  // Build the matching-leads query for this filter to get the recipient set.
  let leadsQuery = db
    .from("cold_leads")
    .select("id, phone, email")
    .eq("tenant_id", context.tenantId)
    .eq("list_id", coldListId);

  if (recipientFilter.stage) {
    leadsQuery = leadsQuery.eq("stage", recipientFilter.stage);
  }
  if (typeof recipientFilter.max_attempts === "number") {
    leadsQuery = leadsQuery.lte("attempt_count", recipientFilter.max_attempts);
  }

  const { data: matchingLeads, error: leadsErr } = await leadsQuery;
  if (leadsErr) {
    return NextResponse.json(
      { ok: false, error: "db_error", detail: leadsErr.message },
      { status: 500 },
    );
  }

  const leads = matchingLeads ?? [];
  if (leads.length === 0) {
    return NextResponse.json(
      { ok: false, error: "no_recipients", hint: "No cold leads match the given filter." },
      { status: 400 },
    );
  }

  const campaignName =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim()
      : `${(listRow as { name: string }).name} — ${new Date().toLocaleDateString("en-CA")}`;

  // INSERT the campaign at status='queued'.
  const { data: campaignData, error: campaignErr } = await db
    .from("cold_outreach_campaigns")
    .insert({
      tenant_id: context.tenantId,
      name: campaignName,
      channel: channel as Channel,
      message_body: messageBody,
      subject,
      cold_list_id: coldListId,
      recipient_filter: recipientFilter,
      status: "queued",
      daily_cap: dailyCap,
      scheduled_for: scheduledFor,
      total_recipients: 0, // updated below after recipient rows land
      sent_count: 0,
      failed_count: 0,
      created_by_user_id: user.id,
    })
    .select("id")
    .single();

  if (campaignErr || !campaignData) {
    return NextResponse.json(
      { ok: false, error: "db_error", detail: campaignErr?.message },
      { status: 500 },
    );
  }
  const campaignId = (campaignData as { id: string }).id;

  // INSERT one cold_outreach_recipients row per matching lead.
  type LeadRow = { id: string; phone: string | null; email: string | null };
  const recipientRows = (leads as LeadRow[]).map((lead) => ({
    tenant_id: context.tenantId,
    campaign_id: campaignId,
    cold_lead_id: lead.id,
    // contact_address resolves to phone for SMS channels, email for email.
    contact_address:
      channel === "email" ? (lead.email ?? "") : (lead.phone ?? ""),
    status: "pending",
  }));

  // Both failure paths below write the same envelope and differ only in
  // event_type, severity and payload. agent_events has no tenant_id column —
  // the established shape (app/api/cron/kixie-compliance-scan/route.ts) nests it
  // in the payload and scopes with correlation_id. Returns the insert error so
  // a caller can react to the audit row ITSELF failing.
  const auditEvent = async (
    eventType: string,
    severity: "info" | "warn" | "error" | "critical",
    payload: Record<string, unknown>,
  ) => {
    const { error } = await db.from("agent_events").insert({
      event_type: eventType,
      publisher_agent: "cold-outreach-campaigns",
      severity,
      payload: { tenant_id: context.tenantId, campaign_id: campaignId, ...payload },
      correlation_id: context.tenantId,
    });
    return error;
  };

  // Insert in chunks to avoid request-size limits on large lists.
  //
  // This used to read "Partial failures are tolerated — daemon retries pending
  // rows on next tick", and drop the chunk on any error. Both halves were wrong:
  //
  //   1. There is no such daemon. `cold_outreach_recipients` is referenced by
  //      this route, the sibling recipients route, and a backup script that only
  //      enumerates table names — nothing else, in any repo, and no cron_engine
  //      job touches cold_outreach at all.
  //   2. A FAILED insert leaves no row behind. "Retries pending rows" cannot
  //      recover recipients that were never written; they simply ceased to exist,
  //      and total_recipients quietly under-reported with nothing logged.
  //
  // So a failed chunk now retries row by row, marks what lands as
  // `failed_pending_retry` rather than promoting it to a clean `pending` (these
  // came out of a failed batch and an operator should look before anything is
  // sent to them), and records every failure in agent_events. Nothing is dropped
  // without a row explaining it.
  const CHUNK = 500;
  let totalInserted = 0;
  let flaggedForRetry = 0;
  let lostRecipients = 0;
  const chunkFailures: string[] = [];

  for (let i = 0; i < recipientRows.length; i += CHUNK) {
    const chunk = recipientRows.slice(i, i + CHUNK);
    const { error: rErr } = await db
      .from("cold_outreach_recipients")
      .insert(chunk);

    if (!rErr) {
      totalInserted += chunk.length;
      continue;
    }

    // Salvage what can land. One bad row must not cost the other 499.
    //
    // NOT insertChunkSalvagingDuplicates() from @/lib/api-helpers, though the
    // shape is the same and the cold-list importers use it. Three differences
    // make sharing worse than duplicating here: that one retries only on a
    // UNIQUE violation, leaves the row unchanged, and ABORTS on the first
    // non-duplicate error. This one retries on any error, stamps the row
    // `failed_pending_retry`, and keeps going so it can report exactly which
    // leads were lost. Merging them would need a retry predicate, a row
    // transform and an abort-vs-continue flag — three knobs for two callers.
    // If a third caller ever wants this shape, generalise then, with three
    // real examples to design against.
    const lostLeadIds: string[] = [];
    for (const row of chunk) {
      const { error: oneErr } = await db
        .from("cold_outreach_recipients")
        .insert({ ...row, status: "failed_pending_retry" });
      if (oneErr) lostLeadIds.push(String(row.cold_lead_id));
      else flaggedForRetry += 1;
    }
    lostRecipients += lostLeadIds.length;
    chunkFailures.push(redactAll(rErr.message));

    // agent_events has no tenant_id column — the established shape (see
    // app/api/cron/kixie-compliance-scan/route.ts) nests it in the payload and
    // scopes with correlation_id.
    const evErr = await auditEvent(
      "outreach_chunk_failed",
      lostLeadIds.length ? "error" : "warn",
      {
        chunk_index: Math.floor(i / CHUNK),
        chunk_size: chunk.length,
        recovered: chunk.length - lostLeadIds.length,
        lost: lostLeadIds.length,
        // Capped: the point is to make recovery possible, not to mirror the
        // whole list into an events row.
        lost_cold_lead_ids: lostLeadIds.slice(0, 50),
        lost_ids_truncated: lostLeadIds.length > 50,
        // redactAll strips env-var secret VALUES and URL key params. Turso
        // driver errors can carry the database URL, and this row is persisted.
        error: redactAll(rErr.message),
      },
    );
    if (evErr) {
      // The audit row is the whole point of this branch. If even THAT cannot be
      // written, say so in the server log rather than returning a clean 200.
      console.error(
        "[cold-outreach] chunk failed AND its agent_events row failed:",
        redactAll(rErr.message),
        "|",
        redactAll(evErr.message),
      );
      chunkFailures.push(`agent_events_insert_failed: ${redactAll(evErr.message)}`);
    }
  }

  // UPDATE campaign.total_recipients to the actual count that landed.
  //
  // The error is CAPTURED. This was a bare `await`, so a failed update left the
  // campaign row reporting a stale count — usually 0 — while the response
  // returned ok:true with the real number beside it. The operator would read a
  // list size on screen that the database did not agree with, and nothing
  // anywhere would say so.
  const recipientTotal = totalInserted + flaggedForRetry;
  const { error: countErr } = await db
    .from("cold_outreach_campaigns")
    // Rows flagged for retry EXIST and are recipients of this campaign; leaving
    // them out would under-report the list the operator is looking at.
    .update({ total_recipients: recipientTotal })
    .eq("id", campaignId)
    .eq("tenant_id", context.tenantId);

  if (countErr) {
    console.error("[cold-outreach] total_recipients update failed:", redactAll(countErr.message));
    await auditEvent("outreach_count_update_failed", "error", {
      intended_total: recipientTotal,
      error: redactAll(countErr.message),
    });
  }

  // Extra fields only, and only when something went wrong — existing callers
  // read `campaign_id` and are unaffected. A partial failure must not return a
  // response indistinguishable from a clean one.
  return NextResponse.json({
    // Recipients landed and the campaign exists, so this is not a failed
    // request — but `count_persisted: false` tells the caller the number below
    // is what we inserted, not what the campaign row now says.
    ok: true,
    campaign_id: campaignId,
    total_recipients: recipientTotal,
    ...(countErr ? { count_persisted: false } : {}),
    ...(flaggedForRetry || lostRecipients || chunkFailures.length
      ? {
          flagged_for_retry: flaggedForRetry,
          lost_recipients: lostRecipients,
          // COUNT ONLY — no driver text crosses the wire.
          //
          // redactAll scrubs secrets and URL keys, but a UNIQUE violation names
          // the conflicting VALUE, and for cold_outreach_recipients that value
          // is contact_address: a lead's email or phone. Redaction does not know
          // it is PII. The client is told THAT chunks failed and how many
          // recipients it cost; the detail lives in the agent_events row, which
          // is server-side and tenant-scoped by correlation_id.
          chunks_failed: chunkFailures.length,
        }
      : {}),
  });
}
