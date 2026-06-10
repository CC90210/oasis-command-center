/**
 * POST /api/applications/[id]/lender-threads/[threadId]/reply — Adon spec
 * section 4 (2026-06-10).
 *
 * Operator-initiated reply on an existing (application, lender) Gmail
 * thread. Replies land in the SAME Gmail conversation as the original
 * submission so the lender sees one continuous chain.
 *
 * Threading mechanism (RFC 2822):
 *   - threadId on the Gmail send body → Gmail attaches client-side
 *   - In-Reply-To: <last_message_id> header → email clients chain
 *   - References: <space-separated message_id_history> → RFC822 chain
 *   - Subject is the original subject, prefixed with "Re: " (only once)
 *
 * CC handling: default is the row's stored cc_emails (the original
 * post-checkbox list from the run). Operator can override per-reply,
 * but the new addresses still need to be in agents.config.json — same
 * gate as the /run endpoint.
 *
 * After send: append the new RFC822 Message-Id to message_id_history,
 * update last_message_id to the new one, refresh updated_at.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { isOperatorEmail } from "@/lib/operator-credentials";
import { sendGmail } from "@/lib/integrations/submissions-gmail-send";
import { getAgents } from "@/lib/config/agents";
import { logAction } from "@/lib/action-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 200_000;

type IncomingBody = {
  body?: unknown;
  cc_emails?: unknown;
};

function jsonError(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

function stripExistingRePrefix(subject: string): string {
  // Idempotent "Re: " — strip ONLY a leading one so we don't pile up
  // "Re: Re: Re: ..." across many reply turns.
  return subject.replace(/^\s*re:\s*/i, "").trim();
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; threadId: string }> },
) {
  const { id: applicationId, threadId } = await ctx.params;
  if (!UUID_RE.test(applicationId)) return jsonError(400, "invalid_application_id");
  if (!UUID_RE.test(threadId)) return jsonError(400, "invalid_thread_id");

  const sess = await resolveSessionContext();
  if (!sess.ok) return jsonError(401, sess.reason);

  const declaredLen = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    return jsonError(413, "payload_too_large");
  }
  let body: IncomingBody;
  try {
    body = (await req.json()) as IncomingBody;
  } catch {
    return jsonError(400, "invalid_json");
  }

  const replyText = typeof body.body === "string" ? body.body : "";
  if (!replyText.trim()) return jsonError(400, "body_required");

  const db = getServiceSupabase();

  // Tenant gate — same shape as /run.
  const tenantRow = await db
    .from("tenants")
    .select("slug")
    .eq("id", sess.tenantId)
    .maybeSingle();
  const tenantSlug = (tenantRow.data as { slug: string } | null)?.slug || "";
  if (tenantSlug !== "submissions" && !isOperatorEmail(sess.email)) {
    return jsonError(403, "shop_out_not_enabled_for_tenant");
  }

  // Look up the (application, lender) thread row.
  const threadRow = await db
    .from("application_lender_threads")
    .select(
      "id, tenant_id, application_id, lender_id, gmail_thread_id, last_message_id, message_id_history, subject, cc_emails",
    )
    .eq("id", threadId)
    .eq("tenant_id", sess.tenantId)
    .eq("application_id", applicationId)
    .maybeSingle();
  if (threadRow.error || !threadRow.data) {
    return jsonError(404, "thread_not_found");
  }
  const thread = threadRow.data as {
    id: string;
    tenant_id: string;
    application_id: string;
    lender_id: string;
    gmail_thread_id: string | null;
    last_message_id: string | null;
    message_id_history: string[] | null;
    subject: string | null;
    cc_emails: string[] | null;
  };

  if (!thread.gmail_thread_id) {
    return jsonError(409, "thread_never_sent", {
      hint: "Run /shop-out/run before replying — this thread has no original submission.",
    });
  }

  // Resolve the lender's contact email (the To: address for the reply).
  const lenderRow = await db
    .from("tenant_records")
    .select("data")
    .eq("tenant_id", sess.tenantId)
    .eq("entity_type", "lender")
    .eq("id", thread.lender_id)
    .maybeSingle();
  const lenderData = ((lenderRow.data as { data: Record<string, unknown> } | null)?.data) || {};
  const lenderEmail = typeof lenderData.contact === "string" ? lenderData.contact : "";
  if (!lenderEmail || !lenderEmail.includes("@")) {
    return jsonError(404, "lender_contact_missing");
  }

  // CC list — operator may override per-reply, but anything they add
  // must be in agents.config.json (same agent-allowlist gate as /run).
  const agentEmails = new Set(getAgents().map((a) => a.email.toLowerCase().trim()));
  const storedCcs = Array.isArray(thread.cc_emails) ? thread.cc_emails : [];
  const incomingCcs = Array.isArray(body.cc_emails)
    ? (body.cc_emails as unknown[])
        .filter((e): e is string => typeof e === "string" && e.includes("@"))
        .map((e) => e.toLowerCase().trim())
        .filter((e) => agentEmails.has(e))
    : null;
  const ccEmails = incomingCcs !== null ? incomingCcs : storedCcs;

  // Subject — original prefixed with "Re: " (once).
  const subjectStem = stripExistingRePrefix(thread.subject || "(no subject)");
  const replySubject = `Re: ${subjectStem}`;

  // Build the In-Reply-To + References chain.
  const history = Array.isArray(thread.message_id_history)
    ? thread.message_id_history.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  const inReplyTo = thread.last_message_id || (history.length > 0 ? history[history.length - 1] : "");

  const sendRes = await sendGmail({
    to: lenderEmail,
    cc: ccEmails,
    subject: replySubject,
    body: replyText,
    threadId: thread.gmail_thread_id,
    inReplyTo: inReplyTo || undefined,
    references: history.length > 0 ? history : undefined,
    tenantId: sess.tenantId,
  });

  if (!sendRes.ok) {
    await logAction({
      agent_key: "shop-out-reply",
      tenant_id: sess.tenantId,
      user_id: sess.userId,
      type: "shop_out_reply_failed",
      ok: false,
      error: sendRes.error,
      summary: `Reply to ${lenderEmail} on thread ${thread.id} failed`,
    });
    return jsonError(502, "gmail_reply_failed", { detail: sendRes.error });
  }

  // Append the new message-id to history; bump last_message_id.
  const newHistory = sendRes.rfc822_message_id
    ? [...history, sendRes.rfc822_message_id]
    : history;
  await db
    .from("application_lender_threads")
    .update({
      last_message_id: sendRes.rfc822_message_id || thread.last_message_id,
      message_id_history: newHistory,
      cc_emails: ccEmails,
      updated_at: new Date().toISOString(),
    })
    .eq("id", thread.id);

  await logAction({
    agent_key: "shop-out-reply",
    tenant_id: sess.tenantId,
    user_id: sess.userId,
    type: "shop_out_reply_sent",
    ok: true,
    summary: `Reply sent on thread ${thread.id} (Gmail thread ${sendRes.thread_id})`,
  });

  return NextResponse.json({
    ok: true,
    thread_id: thread.id,
    gmail_thread_id: sendRes.thread_id,
    gmail_message_id: sendRes.message_id,
    rfc822_message_id: sendRes.rfc822_message_id || null,
    history_length: newHistory.length,
  });
}
