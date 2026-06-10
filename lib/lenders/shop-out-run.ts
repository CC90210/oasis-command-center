/**
 * shop-out-run.ts — Adon spec section 4 (2026-06-10).
 *
 * The engine that fires Jordan's submission template at every targeted
 * lender for one deal. Each lender gets its OWN Gmail thread (per-(deal,
 * lender) threading per Adon spec section 3). Replies on those threads
 * land back in the same Gmail conversation thanks to the per-row
 * gmail_thread_id + Message-Id chain we persist here.
 *
 * Flow:
 *   1. validateSubmissionDeal() — abort with missing[] if any required
 *      field is null
 *   2. testConnection() — abort with 503 if Gmail OAuth is unreachable
 *   3. buildShopOutPlan() — resolve lender contact emails + match scores
 *      + per-lender CC list (operator typed ∪ lender SOP routing ∪
 *      assigned-rep email under the shared-inbox model)
 *   4. INSERT shop_out_runs at status='in_progress'
 *   5. Loop lenders: render Jordan's template, send via Gmail API,
 *      persist gmail_thread_id + last_message_id + append to
 *      message_id_history on application_lender_threads, append a
 *      results[] entry on shop_out_runs
 *   6. UPDATE shop_out_runs to status='completed' (or 'failed' if the
 *      loop bailed early — partial results still preserved by the
 *      append-only trigger)
 *   7. logAction() start + end agent_events
 *
 * Dry-run path (spec section 7): when dryRun=true the engine returns the
 * rendered per-funder preview, writes ZERO rows to shop_out_runs, and
 * makes ZERO Gmail API calls.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { buildShopOutPlan, type ShopOutAttachment } from "@/lib/lenders/shop-out";
import type { ApplicationProfile } from "@/lib/lenders/match-fitness";
import {
  jordanSubject,
  jordanBody,
  validateSubmissionDeal,
  type SubmissionDeal,
  type SubmissionSigner,
} from "@/lib/lenders/templates/jordan-submission";
import { sendGmail } from "@/lib/integrations/submissions-gmail-send";
import { testConnection } from "@/lib/integrations/submissions-gmail";
import { logAction } from "@/lib/action-log";

export type ShopOutRunArgs = {
  tenantId: string;
  applicationId: string;
  /** All Jordan-template fields, validated below. */
  deal: SubmissionDeal;
  /** ApplicationProfile shape buildShopOutPlan needs for match scoring. */
  application: ApplicationProfile;
  /** Lenders the operator targeted (max 20 enforced by the route). */
  lenderIds: string[];
  /** Final CC list after operator-side checkbox finalization (Adon spec 2.3). */
  ccEmails: string[];
  /** Signer derived from the CC list per Adon spec 2.4. */
  signer: SubmissionSigner;
  /** Display name of the user who clicked Send (audit field). */
  initiatedBy: string;
  /** Bank statement / application file attachments — V1 captures the
   * paths only; actual MIME multipart is out of scope per Adon section 4
   * "submissions-gmail-send" comment. */
  attachments: ShopOutAttachment[];
  /** Optional. Operator can flip the dry-run toggle on the panel. */
  dryRun?: boolean;
};

export type ShopOutResultEntry = {
  funder: string;
  lender_id: string;
  status: "sent" | "failed" | "dry_run";
  gmail_thread_id: string | null;
  gmail_message_id: string | null;
  rfc822_message_id: string | null;
  cc_emails: string[];
  error: string | null;
  ts: string;
};

export type ShopOutRunResult =
  | {
      ok: true;
      dry_run: false;
      run_id: string;
      sent: number;
      failed: number;
      results: ShopOutResultEntry[];
    }
  | {
      ok: true;
      dry_run: true;
      previews: Array<{
        funder: string;
        lender_id: string;
        subject: string;
        body: string;
        to: string | null;
        cc: string[];
      }>;
    }
  | { ok: false; status: number; error: string; missing?: string[]; detail?: string };

export async function executeShopOutRun(
  args: ShopOutRunArgs,
): Promise<ShopOutRunResult> {
  const db = getServiceSupabase();

  // Step 1 — deal validation. Adon spec 8.7: missing field returns 400
  // with the explicit list. No Gmail calls, no row writes.
  const missing = validateSubmissionDeal(args.deal);
  if (missing.length > 0) {
    return { ok: false, status: 400, error: "missing_required_fields", missing };
  }

  // Step 2 — connection gate. Adon spec 8.8: missing/invalid app password
  // returns 503 with zero rows and a high_risk agent_event for the audit
  // trail. Pivoted to SMTP — testConnection now opens an actual SMTP
  // session via tenant_integration_credentials.gws.app_password rather
  // than an OAuth refresh.
  if (!args.dryRun) {
    const conn = await testConnection(args.tenantId);
    if (!conn.ok) {
      // Severity-mapped audit event so it shows up in the operator's
      // event feed as a meaningful red flag (not a routine warn).
      await logAction({
        agent_key: "shop-out",
        tenant_id: args.tenantId,
        user_id: "system",
        type: "shop_out_connection_failed",
        ok: false,
        error: conn.error,
        summary: "Gmail submissions account unreachable — run aborted before any send",
      });
      return {
        ok: false,
        status: 503,
        error: "submissions_gmail_unreachable",
        detail: conn.error,
      };
    }
  }

  // Step 3 — resolve lenders + recipient emails + per-lender CC lists.
  // buildShopOutPlan does the match scoring + recipient resolution for
  // us; we don't use its rendered_subject/rendered_body — Jordan's
  // template renders per-funder below.
  const planResult = await buildShopOutPlan({
    tenant_id: args.tenantId,
    application: args.application,
    lender_ids: args.lenderIds,
    cc_emails: args.ccEmails,
    attachments: args.attachments,
  });
  if (!planResult.ok) {
    return { ok: false, status: 500, error: planResult.error };
  }

  // Dry-run short-circuit: return rendered previews, zero side effects.
  if (args.dryRun) {
    return {
      ok: true,
      dry_run: true,
      previews: planResult.plan.map((row) => ({
        funder: row.lender_name,
        lender_id: row.lender_id,
        subject: jordanSubject(args.deal),
        body: jordanBody(args.deal, args.signer, row.lender_name),
        to: row.recipient_email,
        cc: row.recipient_cc_emails,
      })),
    };
  }

  // Step 4 — shop_out_runs row at 'in_progress'.
  const runIns = await db
    .from("shop_out_runs")
    .insert({
      tenant_id: args.tenantId,
      application_id: args.applicationId,
      merchant_name: args.deal.merchant_legal_name,
      initiated_by: args.initiatedBy,
      signer_label: args.signer.name,
      agent_ccs: args.ccEmails,
      funders_targeted: args.lenderIds,
      results: [],
      status: "in_progress",
    })
    .select("run_id")
    .single();
  if (runIns.error || !runIns.data) {
    return {
      ok: false,
      status: 500,
      error: "shop_out_run_insert_failed",
      detail: runIns.error?.message,
    };
  }
  const runId = (runIns.data as { run_id: string }).run_id;

  await logAction({
    agent_key: "shop-out",
    tenant_id: args.tenantId,
    user_id: args.initiatedBy,
    type: "shop_out_run_started",
    ok: true,
    summary: `Shop-out for ${args.deal.merchant_legal_name} to ${args.lenderIds.length} funders started`,
  });

  // Step 5 — loop and send.
  const results: ShopOutResultEntry[] = [];
  let sentCount = 0;
  let failedCount = 0;

  for (const planRow of planResult.plan) {
    const nowIso = new Date().toISOString();
    const funderName = planRow.lender_name;

    // Skip lenders with hard match blockers — operator should have
    // unchecked them upstream, but defense-in-depth.
    if (planRow.blockers.length > 0) {
      const entry: ShopOutResultEntry = {
        funder: funderName,
        lender_id: planRow.lender_id,
        status: "failed",
        gmail_thread_id: null,
        gmail_message_id: null,
        rfc822_message_id: null,
        cc_emails: planRow.recipient_cc_emails,
        error: `match_blocker: ${planRow.blockers.join("; ")}`,
        ts: nowIso,
      };
      results.push(entry);
      failedCount += 1;
      continue;
    }

    // No recipient → skip with explicit error so the audit shows why.
    if (!planRow.recipient_email) {
      const entry: ShopOutResultEntry = {
        funder: funderName,
        lender_id: planRow.lender_id,
        status: "failed",
        gmail_thread_id: null,
        gmail_message_id: null,
        rfc822_message_id: null,
        cc_emails: planRow.recipient_cc_emails,
        error: "missing_recipient_email",
        ts: nowIso,
      };
      results.push(entry);
      failedCount += 1;
      continue;
    }

    // Render Jordan's template per-lender.
    const subject = jordanSubject(args.deal);
    const body = jordanBody(args.deal, args.signer, funderName);

    // Initial send for a new (deal, lender) pair — no threadId, Gmail
    // creates the thread and returns it for us to persist.
    const sendRes = await sendGmail({
      to: planRow.recipient_email,
      cc: planRow.recipient_cc_emails,
      subject,
      body,
      tenantId: args.tenantId,
    });

    if (!sendRes.ok) {
      const entry: ShopOutResultEntry = {
        funder: funderName,
        lender_id: planRow.lender_id,
        status: "failed",
        gmail_thread_id: null,
        gmail_message_id: null,
        rfc822_message_id: null,
        cc_emails: planRow.recipient_cc_emails,
        error: sendRes.error,
        ts: nowIso,
      };
      results.push(entry);
      failedCount += 1;
      // Persist the failure to the per-(deal, lender) tracker so the
      // operator sees error state in the UI even when the run fails.
      await db.from("application_lender_threads").upsert(
        {
          application_id: args.applicationId,
          lender_id: planRow.lender_id,
          tenant_id: args.tenantId,
          subject,
          cc_emails: planRow.recipient_cc_emails,
          status: "error",
          last_error: sendRes.error.slice(0, 500),
        },
        { onConflict: "application_id,lender_id" },
      );
      continue;
    }

    // Success path — persist all thread metadata so the reply endpoint
    // can chain subsequent messages into the same Gmail thread.
    await db.from("application_lender_threads").upsert(
      {
        application_id: args.applicationId,
        lender_id: planRow.lender_id,
        tenant_id: args.tenantId,
        gmail_thread_id: sendRes.thread_id,
        last_message_id: sendRes.rfc822_message_id,
        message_id_history: sendRes.rfc822_message_id ? [sendRes.rfc822_message_id] : [],
        subject,
        cc_emails: planRow.recipient_cc_emails,
        status: "sent",
        sent_at: nowIso,
      },
      { onConflict: "application_id,lender_id" },
    );

    const entry: ShopOutResultEntry = {
      funder: funderName,
      lender_id: planRow.lender_id,
      status: "sent",
      gmail_thread_id: sendRes.thread_id,
      gmail_message_id: sendRes.message_id,
      rfc822_message_id: sendRes.rfc822_message_id || null,
      cc_emails: planRow.recipient_cc_emails,
      error: null,
      ts: nowIso,
    };
    results.push(entry);
    sentCount += 1;
  }

  // Step 6 — stamp the run as terminal.
  const finalStatus = failedCount === results.length ? "failed" : "completed";
  await db
    .from("shop_out_runs")
    .update({
      results,
      status: finalStatus,
      completed_at: new Date().toISOString(),
    })
    .eq("run_id", runId);

  await logAction({
    agent_key: "shop-out",
    tenant_id: args.tenantId,
    user_id: args.initiatedBy,
    type: "shop_out_run_completed",
    ok: finalStatus === "completed",
    summary: `Shop-out run ${runId}: ${sentCount} sent, ${failedCount} failed`,
  });

  return {
    ok: true,
    dry_run: false,
    run_id: runId,
    sent: sentCount,
    failed: failedCount,
    results,
  };
}
