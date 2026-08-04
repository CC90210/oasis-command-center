/**
 * lib/underwriting/run.ts — enqueue an underwriting run.
 *
 * UNDERWRITING IS OPERATOR-INITIATED ONLY. Adon, 2026-08-04.
 *
 * There is exactly one caller: the session-authed operator route
 * POST /api/applications/[id]/underwriting/run, behind the "Start underwriting"
 * / "Re-run" button on an individual lead. Nothing enqueues a run on intake, on
 * document upload, on a form step, or on a schedule.
 *
 * WHY. Every run spends model credit on a full bank-statement read. Auto-running
 * on document arrival meant paying to underwrite deals nobody had asked about,
 * and because the queue was fed regardless of whether anything downstream was
 * working, it kept spending through the 33 days the parser returned nothing.
 *
 * THIS IS ENFORCED IN CODE, NOT ASKED FOR IN A COMMENT: an enqueue without a
 * named operator is refused below, and tests/underwriting-manual-only.test.ts
 * fails the build if any non-operator caller appears anywhere in the tree.
 * Same posture as CLEAR ([[feedback_clear_always_manual]]), for the same reason
 * — the spend is real and the request has to belong to a human.
 *
 * `kickUnderwritingBridge` exists for the CURRENT (VPS orchestrator) pipeline
 * and fires it immediately rather than waiting for its cron. It becomes a no-op
 * once that orchestrator is retired; see JARVIS docs/UNDERWRITING_CUTOVER.md.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveBridgeTarget, callBridgeExecTool } from "@/lib/bridge-proxy";

/**
 * How a run was requested. "automatic" is deliberately NOT here: it existed for
 * the intake auto-run and is retained only as a value already written to
 * historical rows. Reintroducing it as an input is the regression this type
 * prevents at compile time.
 */
export type TriggeredBy = "manual" | "rerun";

export type EnqueueUnderwritingResult =
  | { ok: true; runId: string }
  | {
      ok: false;
      reason: "application_not_found" | "run_in_progress" | "insert_failed" | "not_operator_initiated";
      existingRunId?: string;
      error?: string;
    };

/**
 * Verify the application belongs to the tenant, guard against a concurrent
 * in-flight run, and insert a fresh pending run. Pure DB — no session, no kick.
 *
 * `triggeredByUserId` is REQUIRED. A server-to-server caller has no user id, so
 * this is what makes "operator-initiated only" a property of the code rather
 * than of everyone's memory.
 */
export async function enqueueUnderwritingRun(input: {
  db: SupabaseClient;
  tenantId: string;
  applicationId: string;
  triggeredBy: TriggeredBy;
  triggeredByUserId: string;
}): Promise<EnqueueUnderwritingResult> {
  const { db, tenantId, applicationId, triggeredBy } = input;

  // Fail closed: no named operator, no run. [[fail-closed-default]]
  if (!input.triggeredByUserId || typeof input.triggeredByUserId !== "string") {
    return { ok: false, reason: "not_operator_initiated" };
  }

  // Defense-in-depth: the application must exist in this tenant (prevents a
  // cross-tenant enqueue via a guessed UUID).
  const appCheck = await db
    .from("tenant_records")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("entity_type", "application")
    .eq("id", applicationId)
    .maybeSingle();
  if (appCheck.error || !appCheck.data) {
    return { ok: false, reason: "application_not_found" };
  }

  // 409 guard — don't double-fire if a run is already pending/parsing, so a
  // double-clicked button cannot buy the same statement read twice.
  const inFlight = await db
    .from("application_underwriting")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("application_id", applicationId)
    .in("status", ["pending", "parsing"])
    .limit(1)
    .maybeSingle();
  if (inFlight.data) {
    return { ok: false, reason: "run_in_progress", existingRunId: (inFlight.data as { id: string }).id };
  }

  const insert = await db
    .from("application_underwriting")
    .insert({
      tenant_id: tenantId,
      application_id: applicationId,
      status: "pending",
      triggered_by: triggeredBy,
      triggered_by_user_id: input.triggeredByUserId,
      run_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (insert.error || !insert.data) {
    return { ok: false, reason: "insert_failed", error: insert.error?.message };
  }
  return { ok: true, runId: (insert.data as { id: string }).id };
}

/**
 * Best-effort, server-to-server kick of the underwriting orchestrator (no
 * session cookie needed — resolves the tenant's bridge target + bearer the same
 * way the form hand-off emails do). Fire-and-forget: failure leaves the pending
 * row for the cron to pick up. `wait_for_complete:false` so we never hold on the
 * 30–300s parse.
 */
export async function kickUnderwritingBridge(input: {
  tenant: { slug: string; custom_fields: Record<string, unknown> | null };
  tenantId: string;
  applicationId: string;
  runId: string;
  source: string;
}): Promise<void> {
  try {
    const target = resolveBridgeTarget(input.tenant);
    if (!target) return;
    await callBridgeExecTool(target, {
      tool_name: "underwriting_run",
      application_id: input.applicationId,
      tenant_id: input.tenantId,
      run_id: input.runId,
      source: input.source,
      wait_for_complete: false,
    });
  } catch (e) {
    console.error("[underwriting.kick] bridge dispatch failed", {
      application_id: input.applicationId,
      run_id: input.runId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/*
 * `autoRunUnderwritingForLead` USED TO LIVE HERE and is deliberately gone
 * (2026-08-04), not merely unreferenced.
 *
 * It resolved a lead's application and enqueued a run with triggeredBy
 * "automatic" and no user id, fired from the bank-statement form's completion
 * in app/api/forms/submit/route.ts. Leaving it in place as dead code would have
 * left a working, importable auto-trigger one line away from being re-wired,
 * which is precisely how this became expensive the first time. The enqueue it
 * called now refuses a run with no named operator, so restoring the function
 * would not restore the behaviour anyway.
 *
 * The replacement is the button on the individual lead:
 * components/leads/LeadFileBody.tsx -> POST /api/applications/[id]/underwriting/run.
 */
