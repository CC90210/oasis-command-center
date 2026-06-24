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
import { resolveSessionContext } from "@/lib/api-auth";
import { canViewLead, leadScopingEnabled } from "@/lib/lead-scope";
import { buildShopOutPlan, recordShopOutThreads, autoAdvanceToShopping } from "@/lib/lenders/shop-out";
import { complianceProfileInputs } from "@/lib/lenders/match-fitness";
import { deriveDealSigner, resolveSignerForOperator } from "@/lib/config/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Generous bound for the synchronous auto-dispatch below. Each lender
// SMTP send takes 1-3s through send_gateway; with the 20-lender cap
// (Codex 2026-05-24) plus the 65s exec-tool proxy ceiling, 120s gives
// comfortable headroom for the full batch + the network round trip.
export const maxDuration = 120;

/**
 * Auto-trigger the physical SMTP dispatch for every pending thread on
 * this application by calling the bridge tool `shop_out_send_batch`
 * through the existing /api/bridge/exec-tool proxy (which enforces the
 * role gate — owner/admin only — and forwards to the operator's bridge).
 *
 * Closes Phase 6.3-bis: shop-out used to insert threads at status=pending
 * and require the operator to manually fire the send via Solara chat.
 * The bridge tool was wired (bravo_cli/bridge_tools.py::_tool_shop_out_send_batch)
 * but never auto-triggered from here. 2026-06-10: CC clicked Send and
 * nothing left the VPS. Wiring it up.
 *
 * Best-effort: any failure (timeout, role gate, bridge down) leaves the
 * threads at pending so the operator can retry. Never blocks the queue
 * confirmation.
 */
async function triggerPhysicalSend(
  req: NextRequest,
  applicationId: string,
  signer: { name: string; email: string; phone: string },
): Promise<{
  status: "sent" | "partial" | "error" | "skipped";
  sent_count?: number;
  failed_count?: number;
  total_pending?: number;
  message?: string;
}> {
  try {
    const url = new URL("/api/bridge/exec-tool", req.url);
    const cookie = req.headers.get("cookie") || "";
    const sendRes = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        tool_name: "shop_out_send_batch",
        application_id: applicationId,
        // 2026-06-10 per-user signing: dashboard resolves the operator
        // who clicked Send → looks up their agent entry in
        // agents.config.json → passes signer name/email/phone. Bridge
        // tool sets BRAVO_FROM_DISPLAY/BRAVO_FROM_EMAIL env vars when
        // spawning send_gateway, so each rep's email signs with THEIR
        // name (Jordan signs Jordan, Alex signs Alex, Matt signs Matt).
        // When the operator isn't in agents.config.json, the
        // signer is the shared "SunBiz Submissions" identity.
        signer_name: signer.name,
        signer_email: signer.email,
        signer_phone: signer.phone,
      }),
      // 110s — comfortably under the route's maxDuration (120s) and the
      // /api/bridge/exec-tool proxy's PROXY_TIMEOUT_MS (65s) governs the
      // upstream wait, so this is mostly the network buffer.
      signal: AbortSignal.timeout(110_000),
    });
    const sendData = await sendRes.json();
    if (!sendRes.ok) {
      return {
        status: "error",
        message: sendData?.error || `exec-tool HTTP ${sendRes.status}`,
      };
    }
    // /api/bridge/exec-tool returns the bridge's response verbatim. The
    // shop_out_send_batch tool wraps its result in the standard exec-tool
    // envelope: { output: "<json string>", is_error: false }.
    if (sendData?.is_error) {
      return {
        status: "error",
        message: String(sendData?.output || "bridge tool returned is_error=true"),
      };
    }
    let parsed: {
      sent?: number;
      failed?: number;
      total_pending?: number;
      failures?: unknown[];
    };
    try {
      parsed = JSON.parse(sendData?.output || "{}");
    } catch {
      return { status: "error", message: "bridge tool returned non-JSON output" };
    }
    const sent = typeof parsed.sent === "number" ? parsed.sent : 0;
    const failed = typeof parsed.failed === "number" ? parsed.failed : 0;
    const totalPending = typeof parsed.total_pending === "number" ? parsed.total_pending : 0;
    let status: "sent" | "partial" | "error";
    if (totalPending === 0) {
      // No pending threads (e.g. operator double-fired) → not an error.
      status = "sent";
    } else if (sent > 0 && failed === 0) {
      status = "sent";
    } else if (sent > 0 && failed > 0) {
      status = "partial";
    } else {
      status = "error";
    }
    return {
      status,
      sent_count: sent,
      failed_count: failed,
      total_pending: totalPending,
    };
  } catch (e) {
    return {
      status: "error",
      message: e instanceof Error ? e.message : "auto-trigger threw unknown error",
    };
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  // Switched from resolveTenantId() to the fuller resolveSessionContext()
  // so we have the operator's email + userId for per-user signing.
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const tenantId = sess.tenantId;
  const { id: applicationId } = await ctx.params;

  // Resolve the operator → agent entry → signer the bridge tool will
  // use for BRAVO_FROM_DISPLAY when spawning send_gateway. Shared with
  // /api/leads/[id]/email + lender-threads/[threadId]/retry — see
  // lib/config/agents.ts:resolveSignerForOperator.
  const signer = resolveSignerForOperator(sess.email);

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
  // Adon MCA SOP §4 (2026-06-11) — hard cap ~12 lenders per action.
  // "Prevents an accidental 40-lender blast that burns the deal's
  // reputation with funders." Override via x-shopout-override: 1
  // header — operator must explicitly acknowledge the rep risk.
  // Dry-run scoring still looks at every lender so the UI can rank a
  // directory of any size without 13+ lenders making the page unusable.
  const operatorOverride = req.headers.get("x-shopout-override") === "1";
  const HARD_CAP = 12;
  if (!body.dry_run && lenderIds.length > HARD_CAP && !operatorOverride) {
    return NextResponse.json(
      {
        ok: false,
        error: "too_many_lenders",
        hint: `Adon MCA SOP §4: max ${HARD_CAP} lenders per shop-out (you selected ${lenderIds.length}). Trim to ${HARD_CAP} OR send header x-shopout-override: 1 to acknowledge the rep risk.`,
      },
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

  // Per-agent lock: only the application's owner/collaborator (or an admin) may
  // shop it out. Without this a non-owner with the app UUID could dry-run
  // another rep's deal details and create lender-thread state on it before any
  // per-record check. 404 (not 403) so we don't confirm it exists. (Codex audit
  // 2026-06-22.)
  if (!canViewLead({ isAdmin: sess.isAdmin, userId: sess.userId }, appData, leadScopingEnabled())) {
    return NextResponse.json({ ok: false, error: "application_not_found" }, { status: 404 });
  }
  const application = {
    id: applicationId,
    // Merchant name — drives the SOP subject "New Deal ({{business_name}})"
    // and the body's Business: line. Was missing — caused "New Deal ()" with
    // empty parens + blank Business: in the test on 2026-06-11.
    business_name:
      typeof appData.business_name === "string" && appData.business_name.trim()
        ? appData.business_name.trim()
        : typeof appData.merchant_name === "string"
          ? appData.merchant_name.trim()
          : undefined,
    monthly_revenue: typeof appData.monthly_revenue === "number" ? appData.monthly_revenue : undefined,
    time_in_business_months: typeof appData.time_in_business_months === "number" ? appData.time_in_business_months : undefined,
    applicant_fico: typeof appData.applicant_fico === "number" ? appData.applicant_fico : undefined,
    requested_amount: typeof appData.requested_amount === "number" ? appData.requested_amount : undefined,
    desired_product: typeof appData.desired_product === "string" ? appData.desired_product : undefined,
    // Adon SOP §1/§4 — merchant identity for restricted-list matching
    // (merchant_state + industry), via the shared resolver so every scoring
    // path maps these identically.
    ...complianceProfileInputs(appData),
    // Position count flows from the underwriter chain (debt_detector
    // output) → application.data.position_count. match-fitness's
    // position-range gate uses it; the body template's {{position_count}}
    // shows it to the lender.
    position_count: typeof appData.position_count === "number" ? appData.position_count : undefined,
  };

  // SunBiz directive 2026-05-31: under the shared-inbox From: model
  // (all emails fire from submissions@), the assigned rep stays on
  // each lender thread by being CC'd. Resolve their email here so
  // buildShopOutPlan can merge it into the per-row CC alongside the
  // operator's typed list and the lender's stored submission_cc_emails.
  // application.data.assigned_to holds an auth_user_id (set by
  // /api/leads/[id]/assign); join through user_profiles to get the email.
  let assignedRepEmail: string | null = null;
  const assignedTo = typeof appData.assigned_to === "string" ? appData.assigned_to : null;
  if (assignedTo) {
    const profileRes = await db
      .from("user_profiles")
      .select("email")
      .eq("auth_user_id", assignedTo)
      .maybeSingle();
    const email = (profileRes.data as { email: string | null } | null)?.email;
    if (typeof email === "string" && email.includes("@")) {
      assignedRepEmail = email;
    }
  }

  // ── Personalize the signer to the CC'd agent (Adon spec 2.4 + CC 2026-06-16).
  // When exactly ONE roster agent is on the deal's email — the operator's CC
  // list OR the auto-CC'd assigned rep — the deal is theirs, so they sign the
  // body ({{agent.first_name}}), the signature (— Name), AND the footer
  // ("receiving this from Name at SunBiz Funding"). All three flow from the
  // `signer` payload below + the body's assigned_rep_email. This makes the SENT
  // email match the client-side preview (deriveSignerName), which previously
  // diverged because the send signed as whoever clicked Send
  // (resolveSignerForOperator → "Matt"). Zero or multiple agents → keep the
  // operator signer (no regression for the shared-inbox case).
  let effectiveSigner = signer;
  let effectiveAgentEmail = assignedRepEmail;
  const dealSigner = deriveDealSigner([...ccEmails, assignedRepEmail]);
  if (dealSigner) {
    effectiveSigner = { ...dealSigner, phone: dealSigner.phone || signer.phone };
    effectiveAgentEmail = dealSigner.email;
  }

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
    assigned_rep_email: effectiveAgentEmail,
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
    // Per-row CC = operator's global cc list ∪ lender's stored
    // submission_cc_emails (SOP routing). buildShopOutPlan computed the
    // merge already; we just pass it through here so each row carries
    // its own list to application_lender_threads.cc_emails.
    cc_emails: row.recipient_cc_emails,
    error: !row.recipient_email
      ? "missing lender contact email"
      : row.blockers.length > 0
        ? `match blocker(s): ${row.blockers.join("; ")}`
        : undefined,
  }));

  // 2026-05-25 (migration 069) — resolve assigned-rep phone at queue
  // time so shop_out_sender.py can substitute {{owner_phone}} in body
  // templates with the correct rep (Jordan / Ethan / Matt / Emily).
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

  // Ezra 2026-06-24: a real shop-out auto-advances the deal to "shopping" so the
  // operator never drags it across the board. Shared with the /shop-out/run path.
  if (queued > 0) {
    await autoAdvanceToShopping(tenantId, applicationId);
  }

  // Phase 6.3-bis: auto-fire the physical SMTP dispatch for every thread
  // we just queued at status='pending'. Synchronous so the response
  // carries the real sent/failed counts. Best-effort: any failure
  // leaves threads at pending so the operator can retry.
  const physicalSend =
    queued > 0
      ? await triggerPhysicalSend(req, applicationId, effectiveSigner)
      : { status: "skipped" as const, message: "no threads queued (all blocked)" };

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
    // Real result from the bridge tool (or error message if the
    // auto-trigger failed). UI uses this to decide whether to render
    // "5 lenders contacted" vs. "queued, retry the send" vs. partial.
    physical_send: physicalSend,
  });
}
