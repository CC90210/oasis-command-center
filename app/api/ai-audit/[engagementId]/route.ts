/**
 * /api/ai-audit/[engagementId] — one engagement: read it, and every action a
 * founder takes on it.
 *
 * GET → the engagement view (lib/ai-audit/view.ts).
 * POST { action, ... } → one of:
 *   set_stage          { to, expected_row_version }      a manual move (MANUAL_STAGE_TARGETS only)
 *   save_details       { business_name, business_type, contact_name, contact_email, expected_row_version }
 *   save_profile_field { field }                          one discovery fact, with its label and source
 *   delete_profile_field { field_key }
 *   save_audit         { doc, expected_row_version }      the 9-section draft
 *   save_proposal      { content, expected_row_version }  the priced proposal draft
 *   submit             { expected_row_version }          check, freeze, print the PDF (nothing is sent)
 *   reopen             { expected_row_version }          take a submission back for edits
 *   retry_delivery                                        file a fresh final approval after a failed one
 *   recheck_payment                                       ask Stripe about every open checkout
 *   revoke_link                                           the client's link stops working
 *   retry_onboarding                                      run the onboarding steps again (idempotent)
 *
 * Nothing here sends anything to the client: delivery happens only when the
 * owner approves the deliver_ai_audit approval (lib/ai-audit/delivery.ts).
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireAiAuditSession } from "@/lib/ai-audit/access";
import {
  BUSINESS_TYPES,
  MANUAL_STAGE_TARGETS,
  isAiAuditStage,
  isOneOf,
} from "@/lib/ai-audit/rules";
import { validateAuditDoc } from "@/lib/ai-audit/doc";
import { validateProposalContent } from "@/lib/ai-audit/proposal";
import { validateProfileField } from "@/lib/ai-audit/profile";
import { getEngagement, getSettings, patchEngagement, recordEvent, type Actor } from "@/lib/ai-audit/store";
import { advanceEngagement } from "@/lib/ai-audit/lifecycle";
import { deleteProfileField, saveAuditDraft, saveProfileField, saveProposalDraft } from "@/lib/ai-audit/versions";
import { reopenForEdits, requestDeliveryApproval, submitForFinalApproval } from "@/lib/ai-audit/delivery";
import { listCheckouts, verifyCheckout } from "@/lib/ai-audit/payment";
import { revokeShareLink } from "@/lib/ai-audit/link";
import { runOnboarding } from "@/lib/ai-audit/onboarding";
import { engagementView } from "@/lib/ai-audit/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ engagementId: string }> };
const NO_STORE = { "cache-control": "no-store" };
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function rowVersion(body: Record<string, unknown>): number | null {
  const n = Number(body.expected_row_version);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function casError(error: string) {
  if (error === "conflict") return json(409, { ok: false, error: "changed_elsewhere_refresh" });
  if (error === "not_found") return json(404, { ok: false, error: "not_found" });
  return json(409, { ok: false, error });
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const access = await requireAiAuditSession();
  if (!access.ok) return access.response;
  const { engagementId } = await ctx.params;
  const view = await engagementView(access.session.db, access.session.tenantId, engagementId, new Date());
  if (!view) return json(404, { ok: false, error: "not_found" });
  return json(200, { ok: true, view, viewer: { is_owner: access.session.isOwner } });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const access = await requireAiAuditSession();
  if (!access.ok) return access.response;
  const s = access.session;
  const { engagementId } = await ctx.params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.action !== "string") return json(400, { ok: false, error: "action_required" });
  const engagement = await getEngagement(s.db, s.tenantId, engagementId);
  if (!engagement) return json(404, { ok: false, error: "not_found" });
  const actor: Actor = { type: "user", id: s.userId };
  const now = new Date();

  switch (body.action) {
    case "set_stage": {
      const to = body.to;
      const rv = rowVersion(body);
      if (!isAiAuditStage(to) || !MANUAL_STAGE_TARGETS.includes(to)) return json(400, { ok: false, error: "stage_not_settable_by_hand" });
      if (!rv) return json(400, { ok: false, error: "expected_row_version_required" });
      const r = await advanceEngagement(s.db, { tenantId: s.tenantId, engagementId, to, actor, now, expectedRowVersion: rv, event: "stage_set_by_owner" });
      if (!r.ok) return casError(r.error);
      return json(200, { ok: true, row_version: r.engagement.row_version, stage: r.engagement.stage, lead: r.lead ?? null });
    }
    case "save_details": {
      const rv = rowVersion(body);
      if (!rv) return json(400, { ok: false, error: "expected_row_version_required" });
      const name = typeof body.business_name === "string" ? body.business_name.trim().slice(0, 200) : engagement.business_name;
      const contact = typeof body.contact_name === "string" ? body.contact_name.trim().slice(0, 120) : engagement.contact_name;
      const email = typeof body.contact_email === "string" ? body.contact_email.trim().toLowerCase() : engagement.contact_email;
      if (email && !EMAIL_RE.test(email)) return json(400, { ok: false, error: "contact_email_invalid" });
      const type = body.business_type === undefined ? engagement.business_type : body.business_type;
      if (type !== null && !isOneOf(BUSINESS_TYPES, type)) return json(400, { ok: false, error: "business_type_invalid" });
      const r = await patchEngagement(s.db, {
        tenantId: s.tenantId,
        id: engagementId,
        expectedRowVersion: rv,
        patch: { business_name: name || null, contact_name: contact || null, contact_email: email || null, business_type: type },
        event: "details_saved",
        actor,
        now,
      });
      if (!r.ok) return casError(r.error);
      return json(200, { ok: true, row_version: r.engagement.row_version });
    }
    case "save_profile_field": {
      const field = validateProfileField(body.field);
      if (!field.ok) return json(400, { ok: false, error: "field_invalid", field: field.field, detail: field.error });
      try {
        const saved = await saveProfileField(s.db, { tenantId: s.tenantId, engagementId, field: field.value, actor, now });
        return json(200, { ok: true, field: saved });
      } catch (err) {
        return json(409, { ok: false, error: err instanceof Error && /frozen/.test(err.message) ? "profile_frozen" : "save_failed" });
      }
    }
    case "delete_profile_field": {
      const key = typeof body.field_key === "string" ? body.field_key : "";
      const removed = await deleteProfileField(s.db, { tenantId: s.tenantId, engagementId, fieldKey: key, actor, now });
      return json(200, { ok: true, removed });
    }
    case "save_audit": {
      const rv = rowVersion(body);
      if (!rv) return json(400, { ok: false, error: "expected_row_version_required" });
      const doc = validateAuditDoc(body.doc);
      if (!doc.ok) return json(400, { ok: false, error: "audit_invalid", path: doc.path, detail: doc.message });
      const r = await saveAuditDraft(s.db, { tenantId: s.tenantId, engagementId, doc: doc.doc, actor, now, expectedRowVersion: rv });
      if (!r.ok) return casError(r.error);
      const after = await getEngagement(s.db, s.tenantId, engagementId);
      return json(200, { ok: true, version_id: r.version.id, created: r.created, row_version: after?.row_version ?? null });
    }
    case "save_proposal": {
      const rv = rowVersion(body);
      if (!rv) return json(400, { ok: false, error: "expected_row_version_required" });
      const content = validateProposalContent(body.content);
      if (!content.ok) return json(400, { ok: false, error: "proposal_invalid", field: content.field, detail: content.error });
      const { settings } = await getSettings(s.db, s.tenantId);
      const r = await saveProposalDraft(s.db, { tenantId: s.tenantId, engagementId, content: content.value, actor, now, expectedRowVersion: rv, tax: settings.tax });
      if (!r.ok) return casError(r.error);
      const after = await getEngagement(s.db, s.tenantId, engagementId);
      return json(200, { ok: true, version_id: r.version.id, created: r.created, row_version: after?.row_version ?? null });
    }
    case "submit": {
      const rv = rowVersion(body);
      if (!rv) return json(400, { ok: false, error: "expected_row_version_required" });
      const r = await submitForFinalApproval(s.db, { tenantId: s.tenantId, engagementId, expectedRowVersion: rv, actor, now });
      if (!r.ok) return r.error === "conflict" ? casError("conflict") : json(409, { ok: false, error: r.error, problems: r.problems ?? [] });
      return json(200, { ok: true, row_version: r.engagement.row_version, stage: r.engagement.stage });
    }
    case "reopen": {
      const rv = rowVersion(body);
      if (!rv) return json(400, { ok: false, error: "expected_row_version_required" });
      const r = await reopenForEdits(s.db, { tenantId: s.tenantId, engagementId, expectedRowVersion: rv, actor, now });
      if (!r.ok) return r.error === "conflict" ? casError("conflict") : json(409, { ok: false, error: r.error });
      return json(200, { ok: true, row_version: r.engagement.row_version, stage: r.engagement.stage });
    }
    case "retry_delivery": {
      if (!s.isOwner) return json(403, { ok: false, error: "owner_only" });
      const r = await requestDeliveryApproval(s.db, { tenantId: s.tenantId, engagementId, now, retry: true });
      if (!r.ok) return json(409, { ok: false, error: r.error });
      return json(200, { ok: true, approval_id: r.approvalId, created: r.created });
    }
    case "recheck_payment": {
      const checkouts = (await listCheckouts(s.db, s.tenantId, engagementId)).filter((c) => (c.status === "open" || c.status === "expired" || c.status === "paid") && c.stripe_session_id);
      const results = [];
      for (const c of checkouts.slice(0, 5)) {
        results.push({ checkout_id: c.id, ...(await verifyCheckout(s.db, { tenantId: s.tenantId, checkoutId: c.id, now, trigger: "owner" })) });
      }
      return json(200, { ok: true, results });
    }
    case "revoke_link": {
      if (!engagement.share_link_id) return json(409, { ok: false, error: "no_link" });
      const revoked = await revokeShareLink(s.db, s.tenantId, engagement.share_link_id, "revoked_by_owner", now);
      if (revoked) await recordEvent(s.db, { tenantId: s.tenantId, engagementId, event: "link_revoked", actor, now, refType: "share_link", refId: engagement.share_link_id });
      return json(200, { ok: true, revoked });
    }
    case "retry_onboarding": {
      const r = await runOnboarding(s.db, { tenantId: s.tenantId, engagementId, now });
      return json(r.ok ? 200 : 409, { ok: r.ok, done: r.done, ...(r.ok ? {} : { error: r.error }) });
    }
    default:
      return json(400, { ok: false, error: "unknown_action" });
  }
}
