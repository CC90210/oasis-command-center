/**
 * POST /api/applications/[id]/lender-threads/[threadId]/retry
 *
 * Operator surface: flip ONE error-status lender thread back to pending so
 * the shop_out_sender daemon's next tick re-fires it through send_gateway.
 *
 * Why this exists: when send_gateway's kill-switch gate fail-closed on
 * 2026-06-08 every shop-out thread for the 8 lenders selected landed at
 * status='error'. Without this endpoint the operator's only recovery
 * path is either (a) raw SQL, or (b) SSH-ing to the VPS and running
 *   `python scripts/shop_out_sender.py retry-errors --tenant-id <uuid>`.
 * Neither is acceptable for non-engineer operators (Matt, Jordan, Emily,
 * Alex). One-click Retry next to the error row is.
 *
 * Auth: session cookie + tenant_id match on the application (the same
 * gate /shop-out + /lender-threads use). The thread must belong to the
 * authenticated operator's tenant — strict scoping to prevent retrying
 * threads from another tenant.
 *
 * Idempotent: retrying a thread that's already pending/sending/sent is
 * a no-op success (we only update rows currently in 'error' state).
 *
 * Response: { ok: true, thread_id, previous_status, new_status }.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { resolveSignerForOperator } from "@/lib/config/agents";
import { ensureApplicationThreadsWatermarked } from "@/lib/lead-documents";
import { sendFunmateMail } from "@/lib/integrations/funmate-mail-send";
import { verifyFunmateSmtp } from "@/lib/integrations/funmate-mail";
import type { ShopOutAttachment } from "@/lib/lenders/shop-out";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 2026-06-10: Retry now ALSO fires the physical send via the bridge
// tool so the operator sees an actual send within seconds, not a
// pending-forever row waiting for a daemon. Same maxDuration as
// /shop-out for the bridge round trip.
export const maxDuration = 120;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; threadId: string }> },
) {
  // Switched from resolveTenantId() to the fuller session context so we
  // have sess.email for per-operator signing (same shape as the main
  // shop-out route — Retry should sign as the rep who clicked it).
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const tenantId = sess.tenantId;
  const { id: applicationId, threadId } = await ctx.params;

  const db = getServiceSupabase();

  // Confirm the thread belongs to this tenant AND this application. The
  // tenant gate is the security boundary; the application gate is the UX
  // sanity check (a thread targeted via /applications/<wrongId>/.../retry
  // would otherwise affect the right tenant's threads under a wrong URL).
  const threadRes = await db
    .from("application_lender_threads")
    .select(
      "id, tenant_id, application_id, lender_id, status, last_error, updated_at, email_identity, subject, body_template, attachments, cc_emails",
    )
    .eq("id", threadId)
    .eq("tenant_id", tenantId)
    .eq("application_id", applicationId)
    .maybeSingle();
  if (threadRes.error) {
    return NextResponse.json(
      { ok: false, error: "thread_lookup_failed" },
      { status: 500 },
    );
  }
  if (!threadRes.data) {
    return NextResponse.json(
      { ok: false, error: "thread_not_found" },
      { status: 404 },
    );
  }
  const thread = threadRes.data as {
    id: string;
    status: string;
    last_error: string | null;
    updated_at: string | null;
    lender_id: string;
    email_identity?: string | null;
    subject?: string | null;
    body_template?: string | null;
    attachments?: unknown;
    cc_emails?: unknown;
  };

  // Retryable = an 'error' row OR a 'sending' row that's been stuck long
  // enough to be an orphaned claim (the cron flips pending->sending before
  // it sends; if that process dies mid-send the row sits in 'sending'
  // forever and the operator can never recover it). A real in-flight send
  // settles in seconds, so a multi-minute 'sending' is dead. We never
  // touch sent/suppressed/responded/pending here (pending is already queued).
  const STALE_SENDING_MS = 3 * 60 * 1000;
  const ageMs = thread.updated_at ? Date.now() - Date.parse(thread.updated_at) : Infinity;
  const isStaleSending = thread.status === "sending" && ageMs > STALE_SENDING_MS;
  const retryable = thread.status === "error" || isStaleSending;

  if (!retryable) {
    return NextResponse.json({
      ok: true,
      thread_id: thread.id,
      previous_status: thread.status,
      new_status: thread.status,
      noop: true,
    });
  }

  if (String(thread.email_identity || "sunbiz") === "funmate") {
    const lenderRes = await db
      .from("tenant_records")
      .select("data")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "lender")
      .eq("id", thread.lender_id)
      .maybeSingle();
    const lenderData =
      (lenderRes.data as { data?: Record<string, unknown> } | null)?.data || {};
    const submissionEmails = Array.isArray(lenderData.submission_emails)
      ? lenderData.submission_emails.filter(
          (value): value is string => typeof value === "string" && value.includes("@"),
        )
      : [];
    const contact =
      typeof lenderData.contact === "string" && lenderData.contact.includes("@")
        ? lenderData.contact
        : null;
    const recipient =
      submissionEmails.find((email) => /submission|submit/i.test(email)) ||
      contact ||
      submissionEmails[0] ||
      null;
    if (!recipient) {
      return NextResponse.json(
        { ok: false, error: "funmate_retry_missing_recipient" },
        { status: 422 },
      );
    }

    const connection = await verifyFunmateSmtp();
    if (!connection.ok) {
      return NextResponse.json(
        { ok: false, error: "funmate_mail_unreachable", detail: connection.error },
        { status: 503 },
      );
    }

    const claim = await db
      .from("application_lender_threads")
      .update({ status: "sending", last_error: null, updated_at: new Date().toISOString() })
      .eq("id", thread.id)
      .eq("tenant_id", tenantId)
      .eq("status", thread.status)
      .select("id");
    if (claim.error || !claim.data?.length) {
      return NextResponse.json({
        ok: true,
        thread_id: thread.id,
        previous_status: thread.status,
        new_status: thread.status,
        noop: true,
      });
    }

    const attachments = Array.isArray(thread.attachments)
      ? (thread.attachments as ShopOutAttachment[])
      : [];
    const cc = Array.isArray(thread.cc_emails)
      ? thread.cc_emails.filter(
          (value): value is string => typeof value === "string" && value.includes("@"),
        )
      : [];
    const sent = await sendFunmateMail({
      to: recipient,
      cc,
      subject: thread.subject || "FundMate Submission",
      text: thread.body_template || "",
      tenantId,
      attachments,
    });
    const now = new Date().toISOString();
    await db
      .from("application_lender_threads")
      .update(
        sent.ok
          ? {
              status: "sent",
              sent_at: now,
              gmail_thread_id: sent.rfc822MessageId,
              last_message_id: sent.rfc822MessageId,
              message_id_history: [sent.rfc822MessageId],
              last_error: null,
              updated_at: now,
            }
          : { status: "error", last_error: sent.error, updated_at: now },
      )
      .eq("id", thread.id)
      .eq("tenant_id", tenantId)
      .eq("email_identity", "funmate");

    return NextResponse.json({
      ok: sent.ok,
      thread_id: thread.id,
      previous_status: thread.status,
      new_status: sent.ok ? "sent" : "error",
      physical_send: {
        status: sent.ok ? "sent" : "error",
        sent_count: sent.ok ? 1 : 0,
        failed_count: sent.ok ? 0 : 1,
        message: sent.ok ? undefined : sent.error,
      },
    });
  }

  // Watermark door guard (CC 2026-06-28): retry re-fires shop_out_send_batch,
  // which sends EVERY pending thread on the application — so brand any
  // un-watermarked bank statement across the application's threads before
  // flipping/firing. Refuse (422) if branding fails; never re-send unmarked.
  const wmGuard = await ensureApplicationThreadsWatermarked(tenantId, applicationId);

  const fromStatus = thread.status; // "error" or stale "sending"
  const updateRes = await db
    .from("application_lender_threads")
    .update({
      status: "pending",
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", thread.id)
    .eq("tenant_id", tenantId)
    .eq("status", fromStatus)
    .select("id, status");
  if (updateRes.error) {
    return NextResponse.json(
      { ok: false, error: "thread_update_failed" },
      { status: 500 },
    );
  }
  const updatedCount = Array.isArray(updateRes.data) ? updateRes.data.length : 0;

  // 2026-06-10: previously this endpoint stopped here — flipped the row
  // to 'pending' and trusted shop_out_sender.py to pick it up on its next
  // poll. That meant CC clicked Retry, saw the row go pending, and waited
  // (sometimes forever — the daemon might not be running). Now we fire
  // the bridge tool immediately so the send happens in this request,
  // mirroring the main /shop-out route's behavior. The bridge tool loops
  // over every pending thread on this application, so retrying ONE row
  // also catches any other pending rows that drifted.
  const signer = resolveSignerForOperator(sess.email);

  let physicalSend: {
    status: "sent" | "partial" | "error" | "skipped";
    sent_count?: number;
    failed_count?: number;
    message?: string;
  } = { status: "skipped", message: "thread was not in error state" };

  if (updatedCount > 0) {
    try {
      const execUrl = new URL("/api/bridge/exec-tool", req.url);
      const cookie = req.headers.get("cookie") || "";
      const sendRes = await fetch(execUrl, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          tool_name: "shop_out_send_batch",
          application_id: applicationId,
          signer_name: signer.name,
          signer_email: signer.email,
          signer_phone: signer.phone,
        }),
        signal: AbortSignal.timeout(110_000),
      });
      const sendData = await sendRes.json();
      if (!sendRes.ok || sendData?.is_error) {
        physicalSend = {
          status: "error",
          message: String(sendData?.error || sendData?.output || `exec-tool HTTP ${sendRes.status}`).slice(0, 240),
        };
      } else {
        try {
          const parsed = JSON.parse(sendData?.output || "{}");
          const sent = typeof parsed.sent === "number" ? parsed.sent : 0;
          const failed = typeof parsed.failed === "number" ? parsed.failed : 0;
          physicalSend = {
            status: sent > 0 && failed === 0 ? "sent" : sent > 0 ? "partial" : "error",
            sent_count: sent,
            failed_count: failed,
          };
        } catch {
          physicalSend = { status: "error", message: "bridge tool returned non-JSON output" };
        }
      }
    } catch (e) {
      physicalSend = {
        status: "error",
        message: e instanceof Error ? e.message : "retry auto-trigger threw",
      };
    }
  }

  return NextResponse.json({
    ok: true,
    thread_id: thread.id,
    previous_status: fromStatus,
    new_status: updatedCount > 0 ? "pending" : thread.status,
    noop: updatedCount === 0,
    physical_send: physicalSend,
    watermark_degraded: wmGuard.failures.length > 0,
    watermark_failures: wmGuard.failures,
  });
}
