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
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { resolveDataTenant } from "@/lib/manifest/tenant-scope";
import { manifestExists } from "@/lib/manifest/loader";
import { normalizePhoneE164 } from "@/lib/lead-interactions-queries";
import {
  resolveTextTorrentSenderId,
  resolveTextTorrentActAsEmail,
} from "@/lib/integrations/texttorrent-sender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_CHANNELS = ["sms_twilio", "sms_texttorrent", "email"] as const;
type Channel = typeof ALLOWED_CHANNELS[number];
const ALLOWED_SOURCES = ["cold_list", "assigned_leads", "uploaded"] as const;
type RecipientSource = typeof ALLOWED_SOURCES[number];
const DAILY_CAP_MAX = 5_000;
const DAILY_CAP_DEFAULT = 500;
const UPLOAD_MAX = 5_000;

type RecipientFilter = {
  stage?: string;
  max_attempts?: number;
};

// A resolved recipient ready to become a cold_outreach_recipients row.
type ResolvedRecipient = { cold_lead_id: string | null; contact_address: string };

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
      "started_at, completed_at, created_at, " +
      "created_by_user_id, sender_user_id, sender_from_number",
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
    recipient_source?: unknown;
    uploaded?: unknown;
    as_user_id?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
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

  const recipientSource: RecipientSource =
    (ALLOWED_SOURCES as readonly string[]).includes(body.recipient_source as string)
      ? (body.recipient_source as RecipientSource)
      : "cold_list";

  const db = getServiceSupabase();

  // ── Sender resolution (per-rep identity) ────────────────────────────────
  // Default sender = the creator. An owner/admin may blast on behalf of another
  // rep by passing as_user_id; a member can only blast as themselves.
  const asUserId =
    typeof body.as_user_id === "string" && UUID_RE.test(body.as_user_id) ? body.as_user_id : null;
  let senderUserId = user.id;
  if (asUserId && asUserId !== user.id) {
    const me = await db
      .from("user_profiles")
      .select("team_role, is_owner")
      .eq("auth_user_id", user.id)
      .maybeSingle();
    const role = (me.data as { team_role?: string | null } | null)?.team_role ?? null;
    const isOwner = (me.data as { is_owner?: boolean | null } | null)?.is_owner === true;
    if (!(isOwner || role === "owner" || role === "admin")) {
      return NextResponse.json(
        { ok: false, error: "forbidden_as_user", message: "Only an admin can launch a blast for another rep." },
        { status: 403 },
      );
    }
    senderUserId = asUserId;
  }

  // For TextTorrent, the rep MUST have set their own number + account email so
  // the blast goes out AS them. Fail-closed with a clear, actionable error.
  let senderFromNumber: string | null = null;
  let senderActAsEmail: string | null = null;
  if (channel === "sms_texttorrent") {
    senderFromNumber = (await resolveTextTorrentSenderId({ tenantId: context.tenantId, userId: senderUserId })) ?? null;
    senderActAsEmail = (await resolveTextTorrentActAsEmail({ tenantId: context.tenantId, userId: senderUserId })) ?? null;
    if (!senderFromNumber || !senderActAsEmail) {
      return NextResponse.json(
        {
          ok: false,
          error: "sender_not_configured",
          message:
            "This rep hasn't set their Text Torrent number AND account email in Settings → Personal Integrations. Both are required to blast as them.",
        },
        { status: 400 },
      );
    }
  }

  // ── Recipient resolution (3 sources) ────────────────────────────────────
  let recipients: ResolvedRecipient[] = [];
  let coldListId: string | null = null;
  let recipientFilter: RecipientFilter = {};
  let sourceLabel = "";

  if (recipientSource === "cold_list") {
    coldListId = typeof body.cold_list_id === "string" ? body.cold_list_id.trim() : "";
    if (!coldListId || !UUID_RE.test(coldListId)) {
      return NextResponse.json({ ok: false, error: "cold_list_id_required" }, { status: 400 });
    }
    const rawFilter = body.recipient_filter;
    recipientFilter =
      rawFilter && typeof rawFilter === "object" && !Array.isArray(rawFilter)
        ? (rawFilter as RecipientFilter)
        : {};

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
    sourceLabel = (listRow as { name: string }).name;

    let leadsQuery = db
      .from("cold_leads")
      .select("id, phone, email")
      .eq("tenant_id", context.tenantId)
      .eq("list_id", coldListId);
    if (recipientFilter.stage) leadsQuery = leadsQuery.eq("stage", recipientFilter.stage);
    if (typeof recipientFilter.max_attempts === "number") {
      leadsQuery = leadsQuery.lte("attempt_count", recipientFilter.max_attempts);
    }
    const { data: matchingLeads, error: leadsErr } = await leadsQuery;
    if (leadsErr) {
      return NextResponse.json({ ok: false, error: "db_error", detail: leadsErr.message }, { status: 500 });
    }
    type LeadRow = { id: string; phone: string | null; email: string | null };
    recipients = (matchingLeads as LeadRow[] | null ?? []).map((l) => ({
      cold_lead_id: l.id,
      contact_address: channel === "email" ? (l.email ?? "") : (l.phone ?? ""),
    }));
  } else if (recipientSource === "assigned_leads") {
    // The sender's own pipeline book: tenant_records (entity_type='lead') whose
    // data.assigned_to === the sender's auth_user_id.
    const { data: rows, error: lerr } = await db
      .from("tenant_records")
      .select("id, data")
      .eq("tenant_id", context.tenantId)
      .eq("entity_type", "lead")
      .eq("data->>assigned_to", senderUserId);
    if (lerr) {
      return NextResponse.json({ ok: false, error: "db_error", detail: lerr.message }, { status: 500 });
    }
    type LeadRecord = { id: string; data: Record<string, unknown> | null };
    recipients = ((rows as LeadRecord[] | null) ?? []).map((r) => {
      const d = r.data ?? {};
      const addr = channel === "email" ? String(d.email ?? "") : String(d.phone ?? "");
      return { cold_lead_id: null, contact_address: addr };
    });
    sourceLabel = "My assigned leads";
  } else {
    // uploaded: a posted array of { phone, email? }.
    const up = Array.isArray(body.uploaded) ? (body.uploaded as unknown[]) : [];
    if (up.length === 0) {
      return NextResponse.json({ ok: false, error: "uploaded_empty" }, { status: 400 });
    }
    if (up.length > UPLOAD_MAX) {
      return NextResponse.json({ ok: false, error: "uploaded_too_large", max: UPLOAD_MAX }, { status: 400 });
    }
    recipients = (up as Array<{ phone?: unknown; email?: unknown }>).map((u) => ({
      cold_lead_id: null,
      contact_address: channel === "email" ? String(u?.email ?? "") : String(u?.phone ?? ""),
    }));
    sourceLabel = "Uploaded list";
  }

  // Normalize + validate + dedupe recipient addresses (SMS channels only get a
  // strict E.164 normalize; email is left as-is).
  const seen = new Set<string>();
  const cleaned = recipients
    .map((r) => {
      if (channel === "email") {
        const e = r.contact_address.trim().toLowerCase();
        return e ? { ...r, contact_address: e } : null;
      }
      const n = normalizePhoneE164(r.contact_address);
      return n && /^\+[1-9]\d{7,14}$/.test(n) ? { ...r, contact_address: n } : null;
    })
    .filter((r): r is ResolvedRecipient => {
      if (!r) return false;
      if (seen.has(r.contact_address)) return false;
      seen.add(r.contact_address);
      return true;
    });

  if (cleaned.length === 0) {
    return NextResponse.json(
      { ok: false, error: "no_recipients", hint: "No valid recipients for this source/filter." },
      { status: 400 },
    );
  }

  const campaignName =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim()
      : `${sourceLabel} — ${new Date().toLocaleDateString("en-CA")}`;

  // INSERT the campaign at status='queued', stamping the per-rep sender identity
  // the blaster worker acts-as.
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
      sender_user_id: senderUserId,
      sender_from_number: senderFromNumber,
      sender_act_as_email: senderActAsEmail,
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

  const recipientRows = cleaned.map((r) => ({
    tenant_id: context.tenantId,
    campaign_id: campaignId,
    cold_lead_id: r.cold_lead_id,
    contact_address: r.contact_address,
    status: "pending",
  }));

  // Insert in chunks to avoid request-size limits on large lists.
  const CHUNK = 500;
  let totalInserted = 0;
  for (let i = 0; i < recipientRows.length; i += CHUNK) {
    const chunk = recipientRows.slice(i, i + CHUNK);
    const { error: rErr } = await db.from("cold_outreach_recipients").insert(chunk);
    // Partial failures are tolerated — the worker only ever sends pending rows.
    if (!rErr) totalInserted += chunk.length;
  }

  await db
    .from("cold_outreach_campaigns")
    .update({ total_recipients: totalInserted })
    .eq("id", campaignId)
    .eq("tenant_id", context.tenantId);

  return NextResponse.json({
    ok: true,
    campaign_id: campaignId,
    total_recipients: totalInserted,
    sender_user_id: senderUserId,
  });
}
