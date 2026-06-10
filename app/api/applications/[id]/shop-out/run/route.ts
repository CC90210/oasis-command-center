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
import type { SubmissionDeal } from "@/lib/lenders/templates/jordan-submission";
import type { ApplicationProfile } from "@/lib/lenders/match-fitness";

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
  const deal: SubmissionDeal = {
    merchant_legal_name: String(appData.merchant_legal_name || appData.business_name || ""),
    industry: String(appData.industry || ""),
    time_in_business: String(appData.time_in_business || ""),
    monthly_revenue: typeof appData.monthly_revenue === "number" ? appData.monthly_revenue : NaN,
    requested_amount: typeof appData.requested_amount === "number" ? appData.requested_amount : NaN,
    position_count: typeof appData.position_count === "number" ? appData.position_count : NaN,
    positions_balance: typeof appData.positions_balance === "number" ? appData.positions_balance : NaN,
    positions_payment: typeof appData.positions_payment === "number" ? appData.positions_payment : NaN,
    positions_payment_frequency: String(appData.positions_payment_frequency || ""),
    bank_statements_months: typeof appData.bank_statements_months === "number" ? appData.bank_statements_months : NaN,
    bank_statements_trend: String(appData.bank_statements_trend || ""),
    narrative_summary: String(appData.narrative_summary || ""),
    open_to_best_offer: typeof appData.open_to_best_offer === "boolean" ? appData.open_to_best_offer : false,
    stip_labels: Array.isArray(appData.stip_labels)
      ? (appData.stip_labels as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
  };

  // ApplicationProfile shape for buildShopOutPlan match scoring.
  const application: ApplicationProfile = {
    id: applicationId,
    monthly_revenue: typeof appData.monthly_revenue === "number" ? appData.monthly_revenue : undefined,
    time_in_business_months: typeof appData.time_in_business_months === "number" ? appData.time_in_business_months : undefined,
    applicant_fico: typeof appData.applicant_fico === "number" ? appData.applicant_fico : undefined,
    requested_amount: typeof appData.requested_amount === "number" ? appData.requested_amount : undefined,
    desired_product: typeof appData.desired_product === "string" ? appData.desired_product : undefined,
  };

  // Derive the agent CC list (Adon spec section 2).
  // We look at application.data fields that name reps and intersect
  // against agents.config.json. The operator's checkbox finalization
  // (body.cc_emails) is the source of truth IF present — otherwise we
  // start from the derived list.
  const repFields: Array<unknown> = [
    appData.assigned_rep_email,
    appData.assigned_rep_id,
    appData.owner_id,
    appData.assignee_id,
    appData.rep,
    appData.agent,
    appData.assigned,
    appData.owner,
  ];
  const repEmails: string[] = [];
  for (const f of repFields) {
    if (typeof f === "string" && f.includes("@")) repEmails.push(f.toLowerCase().trim());
  }
  // For id-shaped fields (uuid), look up via user_profiles.email.
  const idFields = repFields.filter(
    (f): f is string => typeof f === "string" && UUID_RE.test(f),
  );
  if (idFields.length > 0) {
    const profiles = await db
      .from("user_profiles")
      .select("auth_user_id, email")
      .in("auth_user_id", idFields);
    for (const p of (profiles.data || []) as Array<{ email: string | null }>) {
      if (p.email) repEmails.push(p.email.toLowerCase().trim());
    }
  }
  const agentEmails = new Set(getAgents().map((a) => a.email.toLowerCase().trim()));
  const derivedCcs = Array.from(
    new Set(repEmails.filter((e) => agentEmails.has(e))),
  );

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
    attachments: Array.isArray(body.attachments) ? body.attachments : [],
    dryRun: body.dry_run === true,
  });

  if (!result.ok) {
    return jsonError(result.status, result.error, {
      ...(result.missing ? { missing: result.missing } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
    });
  }

  return NextResponse.json(result);
}
