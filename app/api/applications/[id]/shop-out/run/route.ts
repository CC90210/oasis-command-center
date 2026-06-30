/**
 * POST /api/applications/[id]/shop-out/run — Adon spec section 4 (2026-06-10).
 *
 * The "actually fire the shop-out" endpoint. Sibling to the legacy
 * /shop-out route (which queues threads at pending and was auto-trigger-
 * patched in commit 4957702). This route bypasses the bridge tool path
 * entirely and sends via Gmail API directly from Vercel.
 *
 * Flow:
 *   1. Auth — session cookie → SunBiz tenant (slug='submissions') OR
 *      operator (CC).
 *   2. Body parse — application/json with optional dry_run flag, optional
 *      checked CC emails (otherwise we derive from the application).
 *   3. Connection gate — testConnection() returns 503 if Gmail OAuth is
 *      unreachable (spec 8.8). Skipped on dry_run.
 *   4. Resolve deal — read tenant_records for application + extract the
 *      SubmissionDeal fields. validateSubmissionDeal will catch any
 *      missing.
 *   5. Resolve agents — pull application's rep fields, intersect against
 *      agents.config.json, apply the operator's checkbox overrides.
 *   6. Derive signer per Adon spec 2.4.
 *   7. executeShopOutRun() — engine does send + persistence + audit.
 *
 * Idempotency: each click on Send creates a new shop_out_runs row. The
 * append-only trigger on shop_out_runs.results prevents post-terminal
 * mutation but doesn't prevent re-running the same (application, lender)
 * pair. Per Adon spec 3.4 application_lender_threads has UNIQUE
 * (application_id, lender_id) so a re-run upserts the existing row with
 * the new thread id — the prior Gmail thread orphans but the dashboard
 * tracks the new one. Operator UX disables the Send button while a run
 * is in flight on the page level to prevent the most common double-click.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { isOperatorEmail } from "@/lib/operator-credentials";
import { executeShopOutRun } from "@/lib/lenders/shop-out-run";
import { getAgents, deriveSigner, findAgentByEmail } from "@/lib/config/agents";
import { extractSubmissionDeal } from "@/lib/lenders/extract-submission-deal";
import { deriveAgentCcs } from "@/lib/lenders/derive-agent-ccs";
import { type ApplicationProfile, complianceProfileInputs } from "@/lib/lenders/match-fitness";
import { watermarkAttachmentsForShopOut } from "@/lib/lead-documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Generous bound for a 20-lender run × ~2s per Gmail send + 60s 429
// retry headroom.
export const maxDuration = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LENDERS = 20;
const MAX_BODY_BYTES = 1_000_000;

type IncomingBody = {
  lender_ids?: string[];
  /** Operator's final post-checkbox CC list. Empty array means none. */
  cc_emails?: string[];
  /** Optional global CC additions typed by the operator (merged into derived). */
  extra_cc_emails?: string[];
  attachments?: Array<{ filename: string; storage_path: string; mime_type: string; size_bytes: number }>;
  dry_run?: boolean;
};

function jsonError(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: applicationId } = await ctx.params;
  if (!UUID_RE.test(applicationId)) {
    return jsonError(400, "invalid_application_id");
  }

  const sess = await resolveSessionContext();
  if (!sess.ok) return jsonError(401, sess.reason);

  // Body size guard.
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

  const lenderIds = Array.isArray(body.lender_ids)
    ? body.lender_ids.filter((s): s is string => typeof s === "string")
    : [];
  if (lenderIds.length === 0) return jsonError(400, "lender_ids_required");
  if (lenderIds.length > MAX_LENDERS) {
    return jsonError(400, "too_many_lenders", {
      max: MAX_LENDERS,
      hint: `Adon spec section 1: 20-funder cap. Re-shop unfunded leads next month with a different cohort.`,
    });
  }

  const db = getServiceSupabase();

  // Tenant gate — SunBiz only, OR operator (CC).
  const tenantRow = await db
    .from("tenants")
    .select("slug")
    .eq("id", sess.tenantId)
    .maybeSingle();
  const tenantSlug = (tenantRow.data as { slug: string } | null)?.slug || "";
  const isOperator = isOperatorEmail(sess.email);
  if (tenantSlug !== "submissions" && !isOperator) {
    return jsonError(403, "shop_out_not_enabled_for_tenant");
  }

  // Resolve the application row.
  const appRow = await db
    .from("tenant_records")
    .select("id, data")
    .eq("tenant_id", sess.tenantId)
    .eq("entity_type", "application")
    .eq("id", applicationId)
    .maybeSingle();
  if (appRow.error || !appRow.data) {
    return jsonError(404, "application_not_found");
  }
  const appData = ((appRow.data as { data: Record<string, unknown> }).data) || {};

  // Build the SubmissionDeal from application.data. validateSubmissionDeal
  // inside the engine catches any missing/wrong-typed fields and returns
  // 400 with the missing[] array (spec 8.7).
  const deal = extractSubmissionDeal(appData);

  // ApplicationProfile shape for buildShopOutPlan match scoring. The
  // complianceProfileInputs spread carries merchant_state + industry — the
  // SOP §4 restricted-state / restricted-industry inputs — which MUST be
  // present on this LIVE Gmail send path or scoreLenderMatch never applies the
  // compliance hard-gates on real sends.
  const application: ApplicationProfile = {
    id: applicationId,
    monthly_revenue: typeof appData.monthly_revenue === "number" ? appData.monthly_revenue : undefined,
    time_in_business_months: typeof appData.time_in_business_months === "number" ? appData.time_in_business_months : undefined,
    applicant_fico: typeof appData.applicant_fico === "number" ? appData.applicant_fico : undefined,
    requested_amount: typeof appData.requested_amount === "number" ? appData.requested_amount : undefined,
    desired_product: typeof appData.desired_product === "string" ? appData.desired_product : undefined,
    ...complianceProfileInputs(appData),
  };

  // Derive the agent CC list — single source of truth for the rep-fields
  // scan + UUID resolution + agents.config.json intersection.
  const derivedAgents = await deriveAgentCcs(db, appData);
  const agentEmails = new Set(getAgents().map((a) => a.email.toLowerCase().trim()));
  const derivedCcs = derivedAgents.map((a) => a.email.toLowerCase().trim());

  // Final CC list: operator's checkbox-finalized list if present,
  // otherwise the derived list. Extra emails the operator typed are
  // merged in but ONLY if they're in agents.config.json (no escape hatch
  // for arbitrary addresses).
  let finalCcs: string[];
  if (Array.isArray(body.cc_emails)) {
    finalCcs = body.cc_emails
      .filter((e): e is string => typeof e === "string" && e.includes("@"))
      .map((e) => e.toLowerCase().trim())
      .filter((e) => agentEmails.has(e));
  } else {
    finalCcs = derivedCcs;
  }
  if (Array.isArray(body.extra_cc_emails)) {
    for (const extra of body.extra_cc_emails) {
      if (typeof extra !== "string" || !extra.includes("@")) continue;
      const norm = extra.toLowerCase().trim();
      if (agentEmails.has(norm) && !finalCcs.includes(norm)) finalCcs.push(norm);
    }
  }

  // Signer derivation per Adon spec 2.4.
  const signer = deriveSigner(finalCcs);

  // Initiated-by = whoever clicked Send. Resolve to a display label:
  // prefer the signed-in user's agent-name (if they're an agent),
  // otherwise their email, otherwise a stable fallback.
  const initiatedByAgent = sess.email ? findAgentByEmail(sess.email) : null;
  const initiatedBy = initiatedByAgent?.name || sess.email || sess.userId;

  const runAttachments = Array.isArray(body.attachments) ? body.attachments : [];

  // Watermark guard (CC 2026-06-28). NOTE: today this direct-Gmail path does NOT
  // attach statements (executeShopOutRun → sendGmail sends to/cc/subject/body
  // only; the bytes that reach lenders go via the Python send_gateway behind the
  // exec-tool chokepoint, which IS guarded). We still brand the operator's
  // selected statement objects here so storage is consistent AND so this path is
  // already fail-closed if attachments ever get plumbed into the Gmail send.
  // Skipped on dry_run (read-only preview).
  if (body.dry_run !== true && runAttachments.length > 0) {
    const wmGuard = await watermarkAttachmentsForShopOut(sess.tenantId, runAttachments);
    if (!wmGuard.ok) {
      return jsonError(422, "bank_statement_watermark_failed", {
        message:
          "Bank statements must carry the SunBiz watermark before shop-out, and branding failed for one or more. Retry, or re-upload the statement.",
        watermark_failures: wmGuard.failures,
      });
    }
  }

  // Fire the engine.
  const result = await executeShopOutRun({
    tenantId: sess.tenantId,
    applicationId,
    deal,
    application,
    lenderIds,
    ccEmails: finalCcs,
    signer,
    initiatedBy,
    attachments: runAttachments,
    dryRun: body.dry_run === true,
  });

  if (!result.ok) {
    return jsonError(result.status, result.error, {
      ...(result.missing ? { missing: result.missing } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
    });
  }

  // Snapshot the paper profile the lenders actually saw, frozen to this shop run,
  // so the lender-intelligence recommender can later score lenders on SIMILAR
  // paper. Best-effort — a snapshot failure must NEVER fail a completed shop.
  const runId = (result as { run_id?: string }).run_id;
  if (body.dry_run !== true && runId) {
    try {
      const uw = (appData.underwriting_jsonb || appData.underwriting || {}) as Record<string, unknown>;
      const n = (...vals: unknown[]): number | null => {
        for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
        return null;
      };
      const s = (...vals: unknown[]): string | null => {
        for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
        return null;
      };
      await db.from("deal_paper_snapshot").upsert(
        {
          tenant_id: sess.tenantId,
          application_id: applicationId,
          shop_run_id: runId,
          paper_grade: s(appData.paper_grade, uw.paper_grade),
          position_count: n(appData.position_count, uw.position_count, uw.active_positions),
          total_mca_balance: n(appData.total_mca_balance, uw.total_mca_balance),
          leverage_ratio: n(appData.leverage_ratio, uw.leverage_ratio),
          monthly_revenue: n(appData.monthly_revenue, uw.monthly_revenue, uw.avg_monthly_deposits),
          nsf_count: n(appData.nsf_count_avg, uw.nsf_count_avg, uw.nsf_count),
          avg_daily_balance: n(appData.avg_daily_balance, uw.avg_daily_balance),
          months_covered: n(appData.months_covered, uw.months_covered),
          applicant_fico: n(appData.applicant_fico, appData.fico, uw.fico),
          time_in_business_months: n(appData.time_in_business_months, uw.time_in_business_months),
          industry: s(appData.industry, uw.industry),
          merchant_state: s(appData.merchant_state, uw.merchant_state),
          requested_amount: n(appData.requested_amount, appData.amount, uw.requested_amount),
        },
        { onConflict: "tenant_id,shop_run_id" },
      );
    } catch {
      /* best-effort snapshot */
    }
  }

  return NextResponse.json(result);
}
