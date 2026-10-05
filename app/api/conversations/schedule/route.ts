/**
 * POST /api/conversations/schedule — durable scheduled-send for the
 * Conversations inbox. Replaces the prior in-tab `setTimeout` (InboxShell /
 * SendSplitButton) which silently dropped a scheduled send when the rep
 * closed the tab or Vercel cold-redeployed.
 *
 * This route only ever INSERTs a 'pending' row into `scheduled_sends`
 * (database/114_scheduled_sends.sql) — it never sends. The actual send
 * happens server-side, session-free, in
 * GET+POST /api/cron/dispatch-scheduled-sends/route.ts (Vercel cron, every
 * 5 min), which re-checks suppression at fire time (a contact can opt out
 * between scheduling and firing) and sends via the same lib functions the
 * live reply/email routes use.
 *
 * Body: { thread_key: string, lead_id?: string|null, channel: "sms"|"email",
 *         to_phone?: string, to_email?: string, subject?: string,
 *         body: string, scheduled_for: string (ISO) }
 *
 * DELETE ?id=<uuid> — cancel a still-pending scheduled send (tenant-scoped).
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { isReadOnlyRole } from "@/lib/role-gates";
import { getWritableLead } from "@/lib/lead-access";
import { roleMayOperateOasisSalesLead } from "@/lib/oasis-sales-pipeline-policy";
import {
  normalizePhoneE164,
  checkPhoneOptOut,
  checkEmailSuppressed,
} from "@/lib/lead-interactions-queries";
import { sanitizeBlastMessage } from "@/lib/integrations/blast-safety";
import { resolveTextTorrentSenderId } from "@/lib/integrations/texttorrent-sender";
import { operatorHasAppPassword } from "@/lib/integrations/gmail-apppassword-send";
import { operatorHasGmailOAuth } from "@/lib/integrations/gmail-oauth-send";
import { getUserIntegrationBundle } from "@/lib/user-integration-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SMS = 1600;
const MAX_SUBJECT = 200;
const MAX_BODY = 32_000;
// Small buffer so a preset computed a few ms in the past (network latency,
// clock skew) doesn't get rejected as "not in the future".
const MIN_LEAD_MS = 15_000;

type ScheduleBody = {
  thread_key?: unknown;
  lead_id?: unknown;
  channel?: unknown;
  to_phone?: unknown;
  to_email?: unknown;
  subject?: unknown;
  body?: unknown;
  scheduled_for?: unknown;
};

/** Resolve + persist the from-identity for the given channel NOW (schedule
 *  time), so the cron never has to guess who's sending. Returns null (with
 *  a caller-facing reason) when nothing is resolvable — the route fails
 *  closed rather than queueing a send that can never fire. */
async function resolveFromIdentity(
  tenantId: string,
  userId: string,
  channel: "sms" | "email",
): Promise<{ ok: true; identity: string } | { ok: false; error: string; message: string }> {
  if (channel === "sms") {
    const senderId = await resolveTextTorrentSenderId({ tenantId, userId });
    if (!senderId) {
      return {
        ok: false,
        error: "no_sender_number",
        message:
          "No TextTorrent sending number resolved — set a Default Business Number in Settings → Integrations or your own number in Personal integrations before scheduling.",
      };
    }
    return { ok: true, identity: senderId };
  }
  // Email: mirror the app/api/leads/[id]/email preference order minus the
  // submissions@ queue fallback — the cron has no session to drive the
  // bridge exec-tool, so a scheduled email send is per-rep Gmail only.
  if (await operatorHasAppPassword(tenantId, userId)) {
    const b = await getUserIntegrationBundle(tenantId, userId, "gmail_imap").catch(() => ({}) as Record<string, string>);
    const addr = (b.address || "").trim();
    if (addr) return { ok: true, identity: addr };
  }
  if (await operatorHasGmailOAuth(tenantId, userId)) {
    const b = await getUserIntegrationBundle(tenantId, userId, "gmail_oauth").catch(() => ({}) as Record<string, string>);
    const addr = (b.gmail_address || "").trim();
    if (addr) return { ok: true, identity: addr };
  }
  return {
    ok: false,
    error: "no_email_sender",
    message: "Connect your Gmail (Settings → Personal integrations) before scheduling an email send.",
  };
}

export async function POST(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: session.reason === "no_session" ? 401 : 400 });
  }
  const { tenantId, userId } = session;

  // Same member+ write gate as the direct send routes (reply/email) — a
  // scheduled send is still a send.
  if (isReadOnlyRole(session.teamRole)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Read-only members can't schedule messages." },
      { status: 403 },
    );
  }

  let body: ScheduleBody;
  try {
    body = (await req.json().catch(() => ({}))) as ScheduleBody;
  } catch {
    body = {};
  }

  const threadKey = typeof body.thread_key === "string" ? body.thread_key.trim() : "";
  if (!threadKey) {
    return NextResponse.json({ ok: false, error: "thread_key_required" }, { status: 400 });
  }
  const channel = body.channel === "sms" || body.channel === "email" ? body.channel : null;
  if (!channel) {
    return NextResponse.json({ ok: false, error: "invalid_channel" }, { status: 400 });
  }
  const leadId = typeof body.lead_id === "string" && UUID_RE.test(body.lead_id) ? body.lead_id : null;
  const exactOasisActor = !session.isAdmin && roleMayOperateOasisSalesLead(session.teamRole);
  if (exactOasisActor && !leadId) {
    return NextResponse.json(
      { ok: false, error: "lead_required", message: "OASIS sales messages must be linked to your lead." },
      { status: 403 },
    );
  }

  const rawScheduledFor = typeof body.scheduled_for === "string" ? body.scheduled_for : "";
  const scheduledForMs = Date.parse(rawScheduledFor);
  if (!rawScheduledFor || Number.isNaN(scheduledForMs)) {
    return NextResponse.json({ ok: false, error: "invalid_scheduled_for" }, { status: 400 });
  }
  if (scheduledForMs < Date.now() + MIN_LEAD_MS) {
    return NextResponse.json(
      { ok: false, error: "scheduled_for_too_soon", message: "Scheduled time must be at least 15 seconds in the future." },
      { status: 400 },
    );
  }

  const rawBody = typeof body.body === "string" ? body.body : "";
  if (!rawBody.trim()) {
    return NextResponse.json({ ok: false, error: "body_required" }, { status: 400 });
  }

  let toPhone: string | null = null;
  let toEmail: string | null = null;
  let subject: string | null = null;
  const trimmedBody = channel === "sms" ? rawBody.trim().slice(0, MAX_SMS) : rawBody.slice(0, MAX_BODY);

  if (channel === "sms") {
    toPhone = normalizePhoneE164(typeof body.to_phone === "string" ? body.to_phone : "");
    if (!toPhone) {
      return NextResponse.json(
        { ok: false, error: "no_phone", message: "Recipient phone missing or unrecognized." },
        { status: 400 },
      );
    }
  } else {
    toEmail = typeof body.to_email === "string" ? body.to_email.trim() : "";
    if (!EMAIL_RE.test(toEmail)) {
      return NextResponse.json({ ok: false, error: "invalid_email" }, { status: 400 });
    }
    subject = (typeof body.subject === "string" ? body.subject.trim() : "").slice(0, MAX_SUBJECT);
    if (!subject) {
      return NextResponse.json({ ok: false, error: "subject_required" }, { status: 400 });
    }
  }

  const db = getServiceSupabase();
  let authorizedLeadData: Record<string, unknown> | null = null;

  // Tenant lead-ownership guard, mirrors app/api/conversations/reply/route.ts.
  if (leadId) {
    const writable = await getWritableLead(
      {
        teamRole: session.teamRole,
        userId,
        isOwner: session.isTrueAdmin,
        adminAccess: session.adminAccess,
      },
      { tenantId, id: leadId },
    );
    if (!writable.ok) {
      return NextResponse.json(
        { ok: false, error: "lead_not_found", message: "Lead not found for this workspace." },
        { status: 404 },
      );
    }
    authorizedLeadData = writable.record.data;
  }

  if (exactOasisActor && leadId && authorizedLeadData) {
    if (threadKey !== `lead:${leadId}`) {
      return NextResponse.json({ ok: false, error: "thread_lead_mismatch" }, { status: 400 });
    }
    if (channel === "sms") {
      const allowedPhones = ["phone", "phone_number", "mobile", "contact_phone"]
        .map((key) => normalizePhoneE164(String(authorizedLeadData?.[key] || "")))
        .filter((value): value is string => Boolean(value));
      if (!toPhone || !allowedPhones.includes(toPhone)) {
        return NextResponse.json({ ok: false, error: "recipient_lead_mismatch" }, { status: 400 });
      }
    } else {
      const allowedEmails = ["email", "email_address", "contact_email"]
        .map((key) => String(authorizedLeadData?.[key] || "").trim().toLowerCase())
        .filter(Boolean);
      if (!toEmail || !allowedEmails.includes(toEmail.toLowerCase())) {
        return NextResponse.json({ ok: false, error: "recipient_lead_mismatch" }, { status: 400 });
      }
    }
  }

  // Merchant-facing safety guard (fail-closed): block any lender name, strip
  // em dashes — same gate every other outbound merchant-facing surface runs.
  const safe = await sanitizeBlastMessage(tenantId, trimmedBody, { checkPositioning: true });
  if (!safe.ok) {
    return NextResponse.json(
      { ok: false, error: safe.reason, message: safe.message, lender_hits: safe.lenderHits },
      { status: 400 },
    );
  }

  // Informational opt-out/suppression pre-check at schedule time — fail
  // closed, same as the direct-send routes. The cron re-checks at fire time
  // regardless (a contact can opt out in the interim); this just avoids
  // queueing a send that's already known-doomed and gives the rep immediate
  // feedback instead of a silent failure hours later.
  if (channel === "sms" && toPhone) {
    const supp = await checkPhoneOptOut(tenantId, toPhone);
    if (supp.optedOut) {
      return NextResponse.json(
        { ok: false, error: "opted_out", message: "Recipient previously opted out (replied STOP) — can't schedule." },
        { status: 409 },
      );
    }
    if (supp.checkFailed) {
      return NextResponse.json(
        { ok: false, error: "suppression_check_failed", message: "Could not verify opt-out status — try again (fail-closed)." },
        { status: 503 },
      );
    }
  } else if (channel === "email" && toEmail) {
    const supp = await checkEmailSuppressed(tenantId, toEmail);
    if (supp.suppressed) {
      return NextResponse.json(
        { ok: false, error: "suppressed", message: "Recipient previously unsubscribed — can't schedule." },
        { status: 409 },
      );
    }
    if (supp.checkFailed) {
      return NextResponse.json(
        { ok: false, error: "suppression_check_failed", message: "Could not verify unsubscribe status — try again (fail-closed)." },
        { status: 503 },
      );
    }
  }

  // Resolve + freeze the sending identity NOW so the cron never has to guess
  // (and so an operator finds out immediately if nothing is resolvable).
  const identity = await resolveFromIdentity(tenantId, userId, channel);
  if (!identity.ok) {
    return NextResponse.json({ ok: false, error: identity.error, message: identity.message }, { status: 400 });
  }

  const ins = await db
    .from("scheduled_sends")
    .insert({
      tenant_id: tenantId,
      lead_id: leadId,
      thread_key: threadKey,
      channel,
      to_phone: toPhone,
      to_email: toEmail,
      subject,
      body: safe.cleaned,
      actor_user_id: userId,
      from_identity: identity.identity,
      scheduled_for: new Date(scheduledForMs).toISOString(),
      status: "pending",
    })
    .select("id, tenant_id, thread_key, channel, to_phone, to_email, subject, scheduled_for, status, from_identity, created_at")
    .single();

  if (ins.error) {
    return NextResponse.json({ ok: false, error: "insert_failed", message: ins.error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, scheduled_send: ins.data });
}

export async function DELETE(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: session.reason === "no_session" ? 401 : 400 });
  }
  const { tenantId } = session;

  if (isReadOnlyRole(session.teamRole)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Read-only members can't cancel scheduled messages." },
      { status: 403 },
    );
  }

  let id = req.nextUrl.searchParams.get("id") || "";
  if (!id) {
    const jsonBody = await req.json().catch(() => ({}) as Record<string, unknown>);
    id = typeof jsonBody.id === "string" ? jsonBody.id : "";
  }
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const db = getServiceSupabase();
  if (!session.isAdmin && roleMayOperateOasisSalesLead(session.teamRole)) {
    const existing = await db
      .from("scheduled_sends")
      .select("id, lead_id, actor_user_id")
      .eq("id", id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const row = existing.data as
      | { id: string; lead_id: string | null; actor_user_id: string | null }
      | null;
    if (!row || row.actor_user_id !== session.userId || !row.lead_id) {
      return NextResponse.json({ ok: false, error: "not_found_or_not_pending" }, { status: 404 });
    }
    const writable = await getWritableLead(
      {
        teamRole: session.teamRole,
        userId: session.userId,
        isOwner: session.isTrueAdmin,
        adminAccess: session.adminAccess,
      },
      { tenantId, id: row.lead_id },
    );
    if (!writable.ok) {
      return NextResponse.json({ ok: false, error: "not_found_or_not_pending" }, { status: 404 });
    }
  }
  // Only a still-pending row can be cancelled — one already claimed
  // ('sending') or terminal ('sent'/'failed'/'cancelled') is left alone so
  // a cancel request can never race a send that's already in flight.
  const upd = await db
    .from("scheduled_sends")
    .update({ status: "cancelled" })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .eq("status", "pending")
    .select("id, status")
    .maybeSingle();

  if (upd.error) {
    return NextResponse.json({ ok: false, error: "cancel_failed", message: upd.error.message }, { status: 500 });
  }
  if (!upd.data) {
    return NextResponse.json(
      { ok: false, error: "not_found_or_not_pending", message: "Scheduled send not found or already sent/cancelled." },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, id: upd.data.id, status: upd.data.status });
}
