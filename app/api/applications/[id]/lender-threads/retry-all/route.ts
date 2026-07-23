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

  // Watermark door guard (CC 2026-06-28): a retry re-fires shop_out_send_batch
  // over every pending thread, so brand any un-watermarked bank statement across
  // this application's threads BEFORE flipping/firing. Refuse (422) if a
  // statement can't be branded — never re-send one un-watermarked. Done first so
  // a failure leaves thread state untouched.
  const wmGuard = await ensureApplicationThreadsWatermarked(tenantId, applicationId);
  if (!wmGuard.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: "bank_statement_watermark_failed",
        message:
          "Bank statements must carry the SunBiz watermark before re-sending, and branding failed for one or more. Retry, or re-upload the statement.",
        watermark_failures: wmGuard.failures,
      },
      { status: 422 },
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
    return NextResponse.json({ ok: true, recovered: 0, physical_send: { status: "skipped" } });
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

  return NextResponse.json({ ok: true, recovered, physical_send: physicalSend });
}
