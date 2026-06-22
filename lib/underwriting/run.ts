/**
 * lib/underwriting/run.ts — enqueue + kick an underwriting run, callable from
 * BOTH the operator route (POST /api/applications/[id]/underwriting/run) and the
 * public form path (bank-statement-upload completion → auto-run, CC 2026-06-22).
 *
 * The core is `enqueueUnderwritingRun`: verify the application, refuse if a run
 * is already in flight (idempotent — no double-charge of the parse pipeline),
 * and insert an `application_underwriting` row at status='pending'. The
 * underwriting_orchestrator cron picks up 'pending' rows and drives the
 * statement_parser → debt_detector → sales_angle pipeline. `kickUnderwritingBridge`
 * fires the orchestrator IMMEDIATELY (server-to-server, no session) so the run
 * doesn't wait for the next cron tick; the cron stays the safety net.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveBridgeTarget, callBridgeExecTool } from "@/lib/bridge-proxy";

export type TriggeredBy = "manual" | "automatic" | "rerun";

export type EnqueueUnderwritingResult =
  | { ok: true; runId: string }
  | { ok: false; reason: "application_not_found" | "run_in_progress" | "insert_failed"; existingRunId?: string; error?: string };

/**
 * Verify the application belongs to the tenant, guard against a concurrent
 * in-flight run, and insert a fresh pending run. Pure DB — no session, no kick.
 */
export async function enqueueUnderwritingRun(input: {
  db: SupabaseClient;
  tenantId: string;
  applicationId: string;
  triggeredBy: TriggeredBy;
  triggeredByUserId?: string | null;
}): Promise<EnqueueUnderwritingResult> {
  const { db, tenantId, applicationId, triggeredBy } = input;

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

  // 409 guard — don't double-fire if a run is already pending/parsing. This is
  // what makes the auto-trigger idempotent: a merchant re-submitting the
  // bank-statement form (or a double after()) won't queue a second parse.
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
      triggered_by_user_id: input.triggeredByUserId ?? null,
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

/**
 * AUTO-RUN for the public form path: resolve the lead's application, enqueue an
 * 'automatic' run, and kick the orchestrator. Soft-fail + idempotent (the 409
 * guard inside enqueueUnderwritingRun prevents a duplicate run). Fired from the
 * bank-statement-upload form's completion in app/api/forms/submit/route.ts.
 */
export async function autoRunUnderwritingForLead(input: {
  db: SupabaseClient;
  tenantId: string;
  leadId: string;
  source: string;
}): Promise<void> {
  try {
    const { db, tenantId, leadId } = input;
    // Resolve the lead's application entity (upsertApplicationFromFormStep
    // creates/updates it on every funding-form step, so it exists by now). Take
    // the most recent if there's more than one.
    const appRow = await db
      .from("tenant_records")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "application")
      .eq("data->>lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const applicationId = (appRow.data as { id: string } | null)?.id;
    if (!applicationId) {
      console.error("[underwriting.auto] no application for lead — skipping auto-underwrite", { lead_id: leadId });
      return;
    }

    const enq = await enqueueUnderwritingRun({ db, tenantId, applicationId, triggeredBy: "automatic" });
    if (!enq.ok) {
      // run_in_progress is the expected idempotent no-op; only log the rest.
      if (enq.reason !== "run_in_progress") {
        console.error("[underwriting.auto] enqueue failed", { lead_id: leadId, application_id: applicationId, reason: enq.reason, error: enq.error });
      }
      return;
    }

    const tenantRow = await db.from("tenants").select("slug, custom_fields").eq("id", tenantId).maybeSingle();
    const tenant = tenantRow.data as { slug: string; custom_fields: Record<string, unknown> | null } | null;
    if (tenant) {
      await kickUnderwritingBridge({
        tenant: { slug: tenant.slug, custom_fields: tenant.custom_fields },
        tenantId,
        applicationId,
        runId: enq.runId,
        source: input.source,
      });
    }
    console.log("[underwriting.auto] enqueued + kicked", { lead_id: leadId, application_id: applicationId, run_id: enq.runId });
  } catch (err) {
    console.error("[underwriting.auto] threw", { lead_id: input.leadId, error: err instanceof Error ? err.message : String(err) });
  }
}
