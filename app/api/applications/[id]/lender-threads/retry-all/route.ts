/**
 * POST /api/applications/[id]/lender-threads/retry-all
 *
 * Operator surface: one-click recovery for an ENTIRE shop-out that came back
 * with errors (the "wall of red" Matt hit on 2026-06-19 — half the lender
 * threads draft_critic-rejected, half SMTP-auth-failed). Rather than clicking
 * Retry on every row, this flips every recoverable thread on the application
 * back to 'pending' and fires the send batch once.
 *
 * Recoverable = status 'error' OR a 'sending' row stuck past STALE_SENDING_MS
 * (an orphaned atomic claim from a sender process that died mid-send). We never
 * touch sent / suppressed / responded / fresh-pending rows.
 *
 * Auth + scoping: identical to the per-thread retry route — session cookie,
 * tenant match on every row updated. Idempotent: with nothing recoverable it's
 * a no-op success.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { resolveSignerForOperator } from "@/lib/config/agents";
import { ensureApplicationThreadsWatermarked } from "@/lib/lead-documents";
import {
  physicalSendFailed,
  dispatchFailureReason,
  recordDispatchFailure,
} from "@/lib/lenders/shop-out-outcome";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const STALE_SENDING_MS = 3 * 60 * 1000;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const tenantId = sess.tenantId;
  const { id: applicationId } = await ctx.params;
  const db = getServiceSupabase();
  const nowIso = new Date().toISOString();
  const requestBody = await req.json().catch(() => ({}));
  const emailIdentity =
    (requestBody as { email_identity?: unknown }).email_identity === "funmate"
      ? "funmate"
      : "sunbiz";

  // Watermark door guard (CC 2026-06-28): a retry re-fires shop_out_send_batch
  // over every pending thread, so brand any un-watermarked bank statement across
  // this application's threads BEFORE flipping/firing. Refuse (422) if a
  // statement can't be branded — never re-send one un-watermarked. Done first so
  // a failure leaves thread state untouched.
  const wmGuard = await ensureApplicationThreadsWatermarked(tenantId, applicationId);

  if (emailIdentity === "funmate") {
    const staleCutoff = new Date(Date.now() - STALE_SENDING_MS).toISOString();
    const [errors, stale] = await Promise.all([
      db
        .from("application_lender_threads")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("application_id", applicationId)
        .eq("email_identity", "funmate")
        .eq("status", "error"),
      db
        .from("application_lender_threads")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("application_id", applicationId)
        .eq("email_identity", "funmate")
        .eq("status", "sending")
        .lt("updated_at", staleCutoff),
    ]);
    if (errors.error || stale.error) {
      return NextResponse.json(
        { ok: false, error: "funmate_retry_lookup_failed" },
        { status: 500 },
      );
    }
    const threadIds = [
      ...(errors.data || []).map((row) => String(row.id)),
      ...(stale.data || []).map((row) => String(row.id)),
    ].slice(0, 12);
    if (!threadIds.length) {
      return NextResponse.json({
        ok: true,
        identity: "funmate",
        recovered: 0,
        physical_send: { status: "skipped" },
      });
    }

    const cookie = req.headers.get("cookie") || "";
    const results: Array<{ thread_id: string; ok: boolean; error?: string }> = [];
    for (const threadId of threadIds) {
      try {
        const retryUrl = new URL(
          `/api/applications/${applicationId}/lender-threads/${threadId}/retry`,
          req.url,
        );
        const retryResponse = await fetch(retryUrl, {
          method: "POST",
          headers: { cookie },
          signal: AbortSignal.timeout(30_000),
        });
        const retryData = await retryResponse.json().catch(() => ({}));
        results.push({
          thread_id: threadId,
          ok: retryResponse.ok && retryData?.ok === true,
          error:
            retryResponse.ok && retryData?.ok === true
              ? undefined
              : String(retryData?.error || `retry_http_${retryResponse.status}`).slice(0, 160),
        });
      } catch (error) {
        results.push({
          thread_id: threadId,
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 160) : "retry_failed",
        });
      }
    }
    const sentCount = results.filter((result) => result.ok).length;
    const fmStatus =
      sentCount === results.length ? "sent" : sentCount > 0 ? "partial" : "error";
    // The FunMate batch returns here, before the shared outcome handler, so it
    // needs the contract applied explicitly or the identity silently opts out
    // of it. 502 ONLY when nothing sent: a partial batch put real packages in
    // front of real lenders, and the per-thread `results` carry the rest.
    // (Codex review, 2026-08-11.)
    return NextResponse.json(
      {
        ok: sentCount === results.length,
        ...(fmStatus === "error" ? { error: "physical_send_failed" } : {}),
        identity: "funmate",
        recovered: sentCount,
        physical_send: {
          status: fmStatus,
          sent_count: sentCount,
          failed_count: results.length - sentCount,
        },
        results,
      },
      { status: fmStatus === "error" && results.length > 0 ? 502 : 200 },
    );
  }

  // Flip every 'error' thread on this application+tenant back to 'pending'.
  const errRes = await db
    .from("application_lender_threads")
    .update({ status: "pending", last_error: null, updated_at: nowIso })
    .eq("tenant_id", tenantId)
    .eq("application_id", applicationId)
    .eq("email_identity", "sunbiz")
    .eq("status", "error")
    .select("id");
  if (errRes.error) {
    return NextResponse.json({ ok: false, error: "thread_update_failed" }, { status: 500 });
  }

  // Recover orphaned 'sending' claims older than the stale window.
  const staleCutoff = new Date(Date.now() - STALE_SENDING_MS).toISOString();
  const staleRes = await db
    .from("application_lender_threads")
    .update({ status: "pending", last_error: null, updated_at: nowIso })
    .eq("tenant_id", tenantId)
    .eq("application_id", applicationId)
    .eq("email_identity", "sunbiz")
    .eq("status", "sending")
    .lt("updated_at", staleCutoff)
    .select("id");
  if (staleRes.error) {
    return NextResponse.json({ ok: false, error: "stale_recovery_failed" }, { status: 500 });
  }

  const recovered =
    (Array.isArray(errRes.data) ? errRes.data.length : 0) +
    (Array.isArray(staleRes.data) ? staleRes.data.length : 0);

  // Nothing to do — honest no-op so the UI can say "nothing to retry".
  if (recovered === 0) {
    return NextResponse.json({
      ok: true,
      recovered: 0,
      physical_send: { status: "skipped" },
      watermark_degraded: wmGuard.failures.length > 0,
      watermark_failures: wmGuard.failures,
    });
  }

  // Fire the batch once. shop_out_send_batch loops every pending thread on the
  // application, so a single trigger covers all the rows we just recovered.
  const signer = resolveSignerForOperator(sess.email);
  let physicalSend: {
    status: "sent" | "partial" | "error" | "skipped";
    sent_count?: number;
    failed_count?: number;
    message?: string;
  } = { status: "skipped" };

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
      message: e instanceof Error ? e.message : "retry-all auto-trigger threw",
    };
  }

  // Retry is where an operator goes AFTER a failure, so reporting a second
  // failure as {ok:true} is worse here than on the initial send: it converts
  // "the fix did not work" into "it worked this time", and the deal stops
  // being chased. Same contract as the shop-out route — stamp the row, then
  // 502. See lib/lenders/shop-out-outcome.ts.
  if (physicalSendFailed(physicalSend)) {
    const reason = dispatchFailureReason(physicalSend);
    const stamp = await recordDispatchFailure({
      tenant_id: tenantId,
      application_id: applicationId,
      reason,
      // Always "sunbiz" here: the FunMate batch returns above, and tsc proves
      // it — narrowing emailIdentity to "sunbiz" at this point made a ternary
      // on "funmate" a type error. Stated rather than left to the default,
      // because this scope is what keeps a SunBiz failure from marking
      // unattempted FunMate work as failed.
      email_identity: "sunbiz",
    });
    if (!stamp.ok) {
      console.error("[retry-all] could not record dispatch failure on threads", {
        applicationId,
        reason,
        error: stamp.error,
      });
    }
    return NextResponse.json(
      {
        ok: false,
        error: "physical_send_failed",
        message:
          "Retry did not go out. Nothing reached a lender — the send path is still failing.",
        recovered,
        threads_marked: stamp.stamped,
        physical_send: physicalSend,
        watermark_degraded: wmGuard.failures.length > 0,
        watermark_failures: wmGuard.failures,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    recovered,
    physical_send: physicalSend,
    watermark_degraded: wmGuard.failures.length > 0,
    watermark_failures: wmGuard.failures,
  });
}
