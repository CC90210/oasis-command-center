/**
 * POST /api/applications/[id]/shop-out
 *
 * Operator triggers a multi-lender outreach for one application.
 * Phase 6.3 of SunBiz CRM. Body:
 *
 *   {
 *     lender_ids: string[],
 *     cc_emails: string[],
 *     attachments: Array<{filename, storage_path, mime_type, size_bytes}>,
 *     subject_template?: string,   // optional override
 *     body_template?: string,
 *     dry_run?: boolean             // if true, returns the plan only
 *                                   // without firing any sends
 *   }
 *
 * Response:
 *   {
 *     ok: true,
 *     plan: ShopOutPlanRow[],  // what would have / did go out
 *     sent: number,
 *     failed: number,
 *     missing_recipients: string[]  // lenders without contact email
 *   }
 *
 * Side effects (when dry_run=false):
 *   - One email per lender via the operator's send_gateway (CASL +
 *     cooldown enforced; attachments included). Phase 6 future work
 *     to wire the actual physical-send subprocess; v1 inserts the
 *     application_lender_threads row at status=pending and surfaces
 *     a TODO for the operator to send manually until that lands.
 *   - One application_lender_threads row per lender (status=sent on
 *     success, =error on failure).
 *
 * Auth: session cookie + tenant_id match on the application row.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveTenantId } from "@/lib/api-auth";
import { buildShopOutPlan, recordShopOutThreads } from "@/lib/lenders/shop-out";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const tenantId = await resolveTenantId();
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const { id: applicationId } = await ctx.params;

  let body: {
    lender_ids?: string[];
    cc_emails?: string[];
    attachments?: Array<{ filename: string; storage_path: string; mime_type: string; size_bytes: number }>;
    subject_template?: string;
    body_template?: string;
    dry_run?: boolean;
    // 2026-05-25 second-meeting expansion. Operator acknowledged the
    // severity-tiered warnings via the Proceed Anyway dialog. Recorded
    // to shop_out_warnings after the threads queue so the audit trail
    // captures who overrode what + why.
    acknowledged_warnings?: Array<{
      lender_id: string;
      warning_codes: string[];
      override_note: string;
    }>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const lenderIds = Array.isArray(body.lender_ids) ? body.lender_ids.filter((s) => typeof s === "string") : [];
  if (lenderIds.length === 0) {
    return NextResponse.json(
      { ok: false, error: "lender_ids_required" },
      { status: 400 },
    );
  }
  // 20-cap only applies to real sends. Dry-run scoring needs to look at
  // every lender so the Shopping Out UI can rank a directory of any size
  // without 21+ lenders making the page unusable (Codex review 2026-05-24).
  if (!body.dry_run && lenderIds.length > 20) {
    return NextResponse.json(
      { ok: false, error: "too_many_lenders", hint: "Max 20 lenders per shop-out. Re-shop unfunded leads next month with a different cohort." },
      { status: 400 },
    );
  }

  const ccEmails = Array.isArray(body.cc_emails)
    ? body.cc_emails.filter((s) => typeof s === "string" && s.includes("@"))
    : [];
  // Defense-in-depth: every attachment's storage_path MUST be anchored
  // under this operator's tenant_id folder. Without this an authenticated
  // admin from tenant A could put a foreign tenant's storage_path in the
  // request body and the downstream send_gateway would happily attach it.
  // Matches the same confused-deputy fix in /api/lead-documents/[id].
  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
  const tenantPrefix = `${tenantId}/`;
  const rejectedAttachments: Array<{ filename: string; reason: string }> = [];
  const attachments = rawAttachments.filter((att) => {
    if (!att || typeof att !== "object") return false;
    const path = typeof att.storage_path === "string" ? att.storage_path : "";
    if (!path.startsWith(tenantPrefix)) {
      rejectedAttachments.push({
        filename: typeof att.filename === "string" ? att.filename : "(unnamed)",
        reason: "storage_path_outside_tenant",
      });
      return false;
    }
    return true;
  });
  if (rejectedAttachments.length > 0 && attachments.length === 0) {
    // Every attachment was foreign — refuse the request entirely so the
    // operator can't accidentally fire a shop-out with zero docs.
    return NextResponse.json(
      {
        ok: false,
        error: "all_attachments_rejected",
        rejected: rejectedAttachments,
      },
      { status: 400 },
    );
  }

  // Pull the application row to confirm tenant + extract the profile
  // for match scoring. Application is a tenant_records row with the
  // lead's monthly_revenue / time_in_business / FICO / requested_amount
  // fields denormalized at form-submission time.
  const db = getServiceSupabase();
  const appRow = await db
    .from("tenant_records")
    .select("id, data")
    .eq("tenant_id", tenantId)
    .eq("entity_type", "application")
    .eq("id", applicationId)
    .maybeSingle();
  if (appRow.error || !appRow.data) {
    return NextResponse.json({ ok: false, error: "application_not_found" }, { status: 404 });
  }
  const appData = (appRow.data as { data: Record<string, unknown> }).data || {};
  const application = {
    id: applicationId,
    monthly_revenue: typeof appData.monthly_revenue === "number" ? appData.monthly_revenue : undefined,
    time_in_business_months: typeof appData.time_in_business_months === "number" ? appData.time_in_business_months : undefined,
    applicant_fico: typeof appData.applicant_fico === "number" ? appData.applicant_fico : undefined,
    requested_amount: typeof appData.requested_amount === "number" ? appData.requested_amount : undefined,
    desired_product: typeof appData.desired_product === "string" ? appData.desired_product : undefined,
  };

  // Build the plan first — operator sees this on dry_run and we use
  // it for the actual send pass below.
  const planResult = await buildShopOutPlan({
    tenant_id: tenantId,
    application,
    lender_ids: lenderIds,
    cc_emails: ccEmails,
    attachments,
    subject_template: body.subject_template,
    body_template: body.body_template,
  });
  if (!planResult.ok) {
    return NextResponse.json({ ok: false, error: planResult.error }, { status: 500 });
  }

  // Dry-run path: return the plan without firing.
  if (body.dry_run) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      plan: planResult.plan,
      sent: 0,
      failed: 0,
      missing_recipients: planResult.missing_recipients,
      // Always surface rejected_attachments so the operator can see WHICH
      // docs got dropped — even on a partial-acceptance pass (9 valid +
      // 1 foreign). Previously this was only set when ALL attachments
      // failed, which silently shipped incomplete packets.
      rejected_attachments: rejectedAttachments,
    });
  }

  // ---------------------------------------------------------------------------
  // Queue pass.
  //
  // CRITICAL: this route inserts application_lender_threads rows at
  // status='pending' (the new value — was 'sent'/'error' which was
  // dishonest because no email actually fires here today). The physical
  // SMTP send is operator-machine-bound for two reasons:
  //   1. Bank statement attachments are sensitive tenant data; we don't
  //      want them transiting Vercel even via Supabase Storage signed URLs
  //   2. send_gateway is Python on the operator's machine; the chokepoint
  //      pattern (CASL + cooldown + daily-cap) lives there
  //
  // The full flow Phase 6.3-bis will ship is:
  //   route here (queues at 'pending') -> bridge /exec-tool with
  //   tool_name='shop_out_send_batch' -> Python loops through lender
  //   threads at 'pending', fires each via send_gateway.send(channel=
  //   'email', attachments=[bank statements]) -> writes gmail_thread_id
  //   + flips status='sent'. The response classifier daemon (Phase 6.4
  //   already shipped) picks up replies from there.
  //
  // Until 6.3-bis: operator sees `queued: N` (NOT `sent: N`) so the
  // UI is honest about what happened. They can manually run the send
  // by triggering the bridge tool, or wait for 6.3-bis. No silent gap.
  const entries = planResult.plan.map((row) => ({
    lender_id: row.lender_id,
    subject: row.rendered_subject,
    // Persist the rendered body per-lender so the bridge-side sender
    // (scripts/shop_out_sender.py) can fire SMTP with exactly the copy
    // the operator approved — including any body_template override they
    // passed in this request. Migration 065 added the column.
    body: row.rendered_body,
    sent: false,  // physical send happens bridge-side once the daemon picks it up
    error: !row.recipient_email
      ? "missing lender contact email"
      : row.blockers.length > 0
        ? `match blocker(s): ${row.blockers.join("; ")}`
        : undefined,
  }));

  // 2026-05-25 (migration 069) — resolve assigned-rep phone at queue
  // time so shop_out_sender.py can substitute {{owner_phone}} in body
  // templates with the correct rep (Jordan / Ethan / Ezra / Emily).
  // Stored on each thread row so reassignment AFTER queue doesn't
  // silently change the outbound.
  const ownerPhone =
    typeof appData.assigned_rep_phone === "string" && appData.assigned_rep_phone.trim()
      ? appData.assigned_rep_phone.trim()
      : null;

  const inserted = await recordShopOutThreads({
    tenant_id: tenantId,
    application_id: applicationId,
    cc_emails: ccEmails,
    entries,
    // Validated attachments (the foreign-tenant ones already got
    // filtered out above into rejectedAttachments). Persisted per-
    // thread so the sender doesn't have to re-resolve them.
    attachments,
    owner_phone: ownerPhone,
  });
  if (!inserted.ok) {
    return NextResponse.json({ ok: false, error: inserted.error }, { status: 500 });
  }

  // 2026-05-25 second-meeting expansion — persist the operator's
  // overrides of any severity-tiered warnings to shop_out_warnings.
  // The threads already queued above; this is the audit trail only.
  // Best-effort: a write failure here doesn't roll back the queued
  // sends (operator already saw + chose to proceed in the UI).
  const acknowledgedWarnings = Array.isArray(body.acknowledged_warnings)
    ? body.acknowledged_warnings.filter(
        (w) => w && typeof w.lender_id === "string" && Array.isArray(w.warning_codes),
      )
    : [];
  if (acknowledgedWarnings.length > 0) {
    const warningRows = acknowledgedWarnings.flatMap((ack) => {
      const planRow = planResult.plan.find((p) => p.lender_id === ack.lender_id);
      if (!planRow) return [];
      const matchedWarnings = (planRow.warnings || []).filter((w) =>
        ack.warning_codes.includes(w.code),
      );
      const thread = inserted.threads.find((t) => t.lender_id === ack.lender_id);
      return matchedWarnings.map((w) => ({
        tenant_id: tenantId,
        application_id: applicationId,
        lender_id: ack.lender_id,
        severity: w.severity,
        reason_code: w.code,
        reason_detail: w.detail,
        overridden: true,
        override_note: ack.override_note || null,
        overridden_at: new Date().toISOString(),
        thread_id: thread?.id || null,
      }));
    });
    if (warningRows.length > 0) {
      await db.from("shop_out_warnings").insert(warningRows);
    }
  }

  const queued = entries.filter((e) => !e.error).length;
  const blocked = entries.length - queued;
  return NextResponse.json({
    ok: true,
    plan: planResult.plan,
    queued,
    blocked,
    missing_recipients: planResult.missing_recipients,
    // Always surface rejected_attachments — partial-acceptance was
    // silently dropping foreign-tenant paths before, which gave
    // operators a false-positive "package complete" signal.
    rejected_attachments: rejectedAttachments,
    // Surface the physical-send gap honestly in the response so the
    // operator UI doesn't misreport "5 lenders contacted" when no
    // SMTP fired. Phase 6.3-bis closes this.
    physical_send: {
      status: "pending",
      hint:
        "Lender threads queued at status='pending'. Physical SMTP send via send_gateway is Phase 6.3-bis (bridge /exec-tool shop_out_send_batch handler). Until that ships, run `python scripts/send_gateway.py send` per thread, or trigger via Solara chat.",
    },
  });
}
