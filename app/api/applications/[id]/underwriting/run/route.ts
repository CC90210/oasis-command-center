/**
 * POST /api/applications/[id]/underwriting/run
 *
 * Enqueue a new underwriting run for one application. The
 * underwriting_orchestrator.py daemon picks up 'pending' rows within ~30s
 * and drives the statement_parser → debt_detector → sales_angle pipeline,
 * writing results back to application_underwriting.status='complete'.
 *
 * Body: { triggered_by?: 'manual' | 'automatic' | 'rerun' }   (default 'manual')
 *
 * Responses:
 *   201 { ok: true, run_id }              — row created, daemon will pick it up
 *   409 { ok: false, error: 'run_in_progress', existing_run_id }
 *       — a pending/parsing run already exists; wait or check /latest
 *   401 { ok: false, error: 'unauthorized' }
 *   404 { ok: false, error: 'application_not_found' }
 *
 * Phase 7.3 SunBiz CRM (second-meeting 2026-05-25).
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { enqueueUnderwritingRun } from "@/lib/underwriting/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TriggeredBy = "manual" | "automatic" | "rerun";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const { tenantId, userId } = session;
  const { id: applicationId } = await ctx.params;

  let body: { triggered_by?: string } = {};
  try {
    body = (await req.json()) as { triggered_by?: string };
  } catch {
    // Body is optional — empty body is fine, we default to 'manual'.
  }

  const triggeredBy: TriggeredBy =
    body.triggered_by === "automatic" || body.triggered_by === "rerun"
      ? body.triggered_by
      : "manual";

  const db = getServiceSupabase();

  // Verify + 409-guard + insert the pending run via the shared lib (also used by
  // the bank-statement-upload form's auto-run path). The session-cookie bridge
  // kick below then fires the orchestrator immediately for the operator.
  const enq = await enqueueUnderwritingRun({
    db,
    tenantId,
    applicationId,
    triggeredBy,
    triggeredByUserId: userId,
  });
  if (!enq.ok) {
    if (enq.reason === "application_not_found") {
      return NextResponse.json({ ok: false, error: "application_not_found" }, { status: 404 });
    }
    if (enq.reason === "run_in_progress") {
      return NextResponse.json(
        { ok: false, error: "run_in_progress", existing_run_id: enq.existingRunId },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: false, error: enq.error ?? "insert_failed" }, { status: 500 });
  }
  const runId = enq.runId;

  // 2026-06-11: previously this route stopped at INSERT and trusted the
  // underwriting_orchestrator cron to pick it up. The orchestrator is a
  // */15 cron — meaning Re-run could sit at "Underwriting in progress…"
  // for up to 15 minutes (CC bug report 2026-06-11: stuck for 5+ min).
  // Now we ALSO fire the bridge tool synchronously so it runs IMMEDIATELY.
  // The cron stays as a safety net for any pending row the bridge missed.
  // Best-effort: bridge offline / failure keeps the row at 'pending' so
  // the cron's next tick picks it up.
  try {
    const execUrl = new URL("/api/bridge/exec-tool", req.url);
    const cookie = req.headers.get("cookie") || "";
    // Fire-and-forget POST. We don't await the bridge's full underwriting
    // pipeline (can take 30-300s) because that'd hold the UI's POST
    // open. Instead we just kick the bridge tool — it runs async on the
    // VPS, updates application_underwriting.status to 'complete' when
    // done, and the dashboard's /latest polling picks up the result.
    fetch(execUrl, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        tool_name: "underwriting_run",
        application_id: applicationId,
        tenant_id: tenantId,
        run_id: runId,
        source: "dashboard_rerun",
        // 2026-06-11: Tell the bridge tool NOT to wait for the
        // orchestrator to complete. The drawer auto-polls
        // /api/applications/[id]/underwriting/latest every 5s
        // (LeadDetailDrawer 4344713), so we just need the bridge to
        // ENQUEUE + kick the orchestrator subprocess. Without this,
        // /api/bridge/exec-tool's 65s proxy timeout would kill the
        // call long before the orchestrator finishes (vision parse
        // alone is ~2 min), and the dashboard would log a "bridge
        // dispatch failed" error even though the underwriting was
        // running successfully.
        wait_for_complete: false,
      }),
      // Long upper bound — the bridge itself has its own timeout, but
      // if Vercel's edge proxy enforces a shorter one we don't want
      // the fetch to AbortError noisily.
      signal: AbortSignal.timeout(180_000),
    }).catch((e) => {
      console.error("[underwriting.run.bridge_dispatch_failed]", {
        application_id: applicationId,
        run_id: runId,
        error: e instanceof Error ? e.message : String(e),
      });
    });
  } catch (e) {
    console.error("[underwriting.run.bridge_dispatch_threw]", {
      application_id: applicationId,
      run_id: runId,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  return NextResponse.json(
    {
      ok: true,
      run_id: runId,
      // UX hint: tells the dashboard's polling loop the run is actually
      // firing now (not just queued for cron). Polling at /latest will
      // see status change from pending → parsing → complete within
      // seconds-to-minutes depending on statement count.
      bridge_dispatched: true,
    },
    { status: 201 },
  );
}
