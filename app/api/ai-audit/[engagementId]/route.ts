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
 *   retry_delivery     { confirm_not_sent? }              file a fresh final approval after a failed one (after an uncertain send, only with confirm_not_sent)
 *   confirm_delivery_sent                                 after an uncertain send: CC saw it in the Sent folder, record the delivery
 *   recheck_payment                                       ask Stripe about every open checkout
 *   revoke_link                                           the client's link stops working
 *   retry_onboarding                                      run the onboarding steps again (idempotent)
 *   retry_pdf                                             after three failed prints: forget them and print again
 *   save_call_note     { question_id, notes, expected_version, after_text? }  one question's notes (live-call screen)
 *   start_call / end_call                                 the call's clock
 *   delete_transcript  { transcript_id }                  wipe a transcript's lines (and the quotes taken from it); owner only
 *   request_authorization { engine? }                     file Gate 1 for the current profile (only the owner approves it)
 *   build_brief                                           build a new version of the pre-call brief (reads the client's public website)
 *   extract_profile    { engine? }                         draft profile facts from the consented transcripts (before Gate 1)
 *   create_meet_room                                      the lead's Oasis Meet call room: the open one, or a new one
 *   attach_meet_transcript { room_id, ai? }               attach a room's ready Meet transcript; `ai` (the client's answer
 *                                                         about AI analysis, said by hand) is the owner's only
 * (Adding a transcript has its own route, ./transcript, for its larger body.)
 *
 * Nothing here sends anything to the client: delivery happens only when the
 * owner approves the deliver_ai_audit approval (lib/ai-audit/delivery.ts).
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireAiAuditSession } from "@/lib/ai-audit/access";
import {
  BUSINESS_TYPES,
  MANUAL_STAGE_TARGETS,
  PROFILE_EDIT_STAGES,
  isAiAuditStage,
  isOneOf,
} from "@/lib/ai-audit/rules";
import { validateAuditDoc } from "@/lib/ai-audit/doc";
import { validateProposalContent } from "@/lib/ai-audit/proposal";
import { validateProfileField } from "@/lib/ai-audit/profile";
import { getEngagement, getSettings, patchEngagement, recordEvent, type Actor } from "@/lib/ai-audit/store";
import { advanceEngagement } from "@/lib/ai-audit/lifecycle";
import { deleteProfileField, saveAuditDraft, saveProfileField, saveProposalDraft } from "@/lib/ai-audit/versions";
import { confirmUncertainDelivery, reopenForEdits, requestDeliveryApproval, submitForFinalApproval } from "@/lib/ai-audit/delivery";
import { expireOpenCheckouts, listCheckouts, verifyCheckout } from "@/lib/ai-audit/payment";
import { clearPdfFailures, queuePdfJob } from "@/lib/ai-audit/pdf";
import { getAuditVersion } from "@/lib/ai-audit/versions";
import { markCall, saveCallNote } from "@/lib/ai-audit/call-notes";
import { deleteTranscript } from "@/lib/ai-audit/transcripts";
import { requestAuthorization, withdrawAuthorization, withdrawAuthorizationIfStale } from "@/lib/ai-audit/authorize";
import { cancelExtraction, startExtraction } from "@/lib/ai-audit/extraction";
import { buildBrief, defaultSiteDeps } from "@/lib/ai-audit/briefs";
import { attachMeetTranscript, createAuditRoom } from "@/lib/ai-audit/meet-link";
import { meetMediaReady } from "@/lib/meet/handlers";
import { liveMeetDeps } from "@/lib/meet/live-deps";
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
      // Not while the audit email is going out: the send already checked the stage and the authorization.
      const r = await advanceEngagement(s.db, { tenantId: s.tenantId, engagementId, to, actor, now, expectedRowVersion: rv, event: "stage_set_by_owner", unlessDeliveryInFlight: true });
      if (!r.ok) return casError(r.error);
      // A Gate 1 card still waiting no longer describes an engagement that moved away from it.
      if (to !== "transcript_review") await withdrawAuthorization(s.db, s.tenantId, r.engagement, actor, now, "stage_moved");
      // A declined or cancelled engagement's payment link must stop working at Stripe too.
      // A failure here is retried by the tick (closedEngagementsWithOpenCheckouts).
      let checkouts: { expired: number; failed: number } | null = null;
      if (to === "declined" || to === "cancelled") {
        try {
          checkouts = await expireOpenCheckouts(s.db, s.tenantId, engagementId, now);
        } catch (err) {
          console.error("[ai-audit.route] could not expire checkouts after closing", { engagementId, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return json(200, { ok: true, row_version: r.engagement.row_version, stage: r.engagement.stage, lead: r.lead ?? null, checkouts });
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
      // The business's name and type are part of what Gate 1 authorizes; after
      // it, only the contact (who receives the audit, bound again at Gate 2)
      // may change (review of phase 2, F3). The row version makes this check
      // hold: an approval in between moves it, and this save then conflicts.
      const bindingChanges = (name || null) !== engagement.business_name || type !== engagement.business_type;
      if (!PROFILE_EDIT_STAGES.includes(engagement.stage) && bindingChanges) {
        return json(409, { ok: false, error: "details_frozen" });
      }
      const r = await patchEngagement(s.db, {
        tenantId: s.tenantId,
        id: engagementId,
        expectedRowVersion: rv,
        patch: { business_name: name || null, contact_name: contact || null, contact_email: email || null, business_type: type },
        event: "details_saved",
        actor,
        now,
        // The check above read the engagement before this write: an approval in
        // between could pass it on the version the approval leaves. The UPDATE
        // itself says "still before Gate 1" (review of phase 2, second pass).
        ...(bindingChanges ? { onlyInStages: PROFILE_EDIT_STAGES } : {}),
      });
      if (!r.ok && bindingChanges && r.engagement && !PROFILE_EDIT_STAGES.includes(r.engagement.stage)) return json(409, { ok: false, error: "details_frozen" });
      if (!r.ok) return casError(r.error);
      const withdrawn = await withdrawAuthorizationIfStale(s.db, s.tenantId, engagementId, actor, now);
      const after = withdrawn ? await getEngagement(s.db, s.tenantId, engagementId) : null;
      return json(200, { ok: true, row_version: after?.row_version ?? r.engagement.row_version, authorization_withdrawn: withdrawn });
    }
    case "save_profile_field": {
      const field = validateProfileField(body.field);
      if (!field.ok) return json(400, { ok: false, error: "field_invalid", field: field.field, detail: field.error });
      try {
        const saved = await saveProfileField(s.db, { tenantId: s.tenantId, engagementId, field: field.value, actor, now });
        await withdrawAuthorizationIfStale(s.db, s.tenantId, engagementId, actor, now);
        return json(200, { ok: true, field: saved });
      } catch (err) {
        if (err instanceof Error && /frozen/.test(err.message)) return json(409, { ok: false, error: "profile_frozen" });
        console.error("[ai-audit.route] save_profile_field failed", { engagementId, error: err instanceof Error ? err.stack : String(err) });
        return json(500, { ok: false, error: "save_failed" });
      }
    }
    case "delete_profile_field": {
      const key = typeof body.field_key === "string" ? body.field_key : "";
      try {
        const removed = await deleteProfileField(s.db, { tenantId: s.tenantId, engagementId, fieldKey: key, actor, now });
        await withdrawAuthorizationIfStale(s.db, s.tenantId, engagementId, actor, now);
        return json(200, { ok: true, removed });
      } catch (err) {
        if (err instanceof Error && /frozen/.test(err.message)) return json(409, { ok: false, error: "profile_frozen" });
        throw err;
      }
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
      const r = await saveProposalDraft(s.db, { tenantId: s.tenantId, engagementId, content: content.value, actor, now, expectedRowVersion: rv, tax: settings.tax, ownerMayPrice: s.isOwner });
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
      const r = await requestDeliveryApproval(s.db, { tenantId: s.tenantId, engagementId, now, retry: true, confirmNotSent: body.confirm_not_sent === true });
      if (!r.ok) return json(409, { ok: false, error: r.error });
      return json(200, { ok: true, approval_id: r.approvalId, created: r.created });
    }
    case "confirm_delivery_sent": {
      if (!s.isOwner) return json(403, { ok: false, error: "owner_only" });
      const r = await confirmUncertainDelivery(s.db, { tenantId: s.tenantId, engagementId, actor });
      if (!r.ok) return json(409, { ok: false, error: r.error });
      return json(200, { ok: true });
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
    case "retry_pdf": {
      if (engagement.stage !== "final_review") return json(409, { ok: false, error: "not_in_final_review" });
      const audit = engagement.current_audit_version_id ? await getAuditVersion(s.db, s.tenantId, engagement.current_audit_version_id) : null;
      if (!audit || audit.status !== "awaiting_approval" || audit.pdf_sha256) return json(409, { ok: false, error: "no_pdf_to_retry" });
      const cleared = await clearPdfFailures(s.db, s.tenantId, audit.id);
      const queued = await queuePdfJob(s.db, { tenantId: s.tenantId, engagementId, auditVersionId: audit.id, contentSha256: audit.content_sha256, now });
      if (engagement.health !== "ok") {
        await patchEngagement(s.db, { tenantId: s.tenantId, id: engagementId, expectedRowVersion: engagement.row_version, patch: { health: "ok", health_reason: null }, event: "pdf_retry", actor, now, meta: { cleared } });
      } else {
        await recordEvent(s.db, { tenantId: s.tenantId, engagementId, event: "pdf_retry", actor, now, meta: { cleared } });
      }
      return json(200, { ok: true, queued, cleared });
    }
    case "save_call_note": {
      const questionId = typeof body.question_id === "string" ? body.question_id : "";
      const notes = typeof body.notes === "string" ? body.notes : null;
      const expected = Number(body.expected_version);
      if (notes === null || !Number.isInteger(expected) || expected < 0) return json(400, { ok: false, error: "note_invalid" });
      const afterText = typeof body.after_text === "string" ? body.after_text : null;
      const r = await saveCallNote(s.db, { tenantId: s.tenantId, engagementId, questionId, notes, expectedVersion: expected, afterText, actor, now });
      if (!r.ok) return json(r.error === "conflict" || r.error === "stage_closed" ? 409 : r.error === "not_found" ? 404 : 400, { ok: false, error: r.error, ...("current" in r ? { current: r.current } : {}) });
      // Gate 1 binds the notes: a real change withdraws a card still waiting.
      await withdrawAuthorizationIfStale(s.db, s.tenantId, engagementId, actor, now);
      return json(200, { ok: true, note: r.note });
    }
    case "start_call":
    case "end_call": {
      const r = await markCall(s.db, { tenantId: s.tenantId, engagementId, what: body.action === "start_call" ? "start" : "end", actor, now });
      if (!r.ok) return json(409, { ok: false, error: r.error });
      return json(200, { ok: true, row_version: r.engagement.row_version, call_started_at: r.engagement.call_started_at, call_ended_at: r.engagement.call_ended_at });
    }
    case "delete_transcript": {
      // Deleting cannot be undone, and after Gate 1 it voids the authorization: the owner's call (review of phase 2, F9).
      if (!s.isOwner) return json(403, { ok: false, error: "owner_only" });
      const id = typeof body.transcript_id === "string" ? body.transcript_id : "";
      const r = await deleteTranscript(s.db, { tenantId: s.tenantId, engagementId, id, actor, now });
      if (!r.ok) return json(r.error === "not_found" ? 404 : 409, { ok: false, error: r.error });
      await withdrawAuthorizationIfStale(s.db, s.tenantId, engagementId, actor, now);
      return json(200, { ok: true });
    }
    case "extract_profile": {
      // Reading a client's call with a model is processing their data: the owner's press, as Gate 1 is (review of phase 2b, M1).
      if (!s.isOwner) return json(403, { ok: false, error: "owner_only" });
      const engine = body.engine === "cloud_workspace" ? "cloud_workspace" : "mac_claude";
      const r = await startExtraction(s.db, { tenantId: s.tenantId, engagementId, engine, actor, now });
      if (!r.ok) return json(409, { ok: false, error: r.error });
      return json(200, { ok: true, step_id: r.stepId, windows: r.windows, created: r.created });
    }
    case "cancel_extraction": {
      if (!s.isOwner) return json(403, { ok: false, error: "owner_only" });
      const r = await cancelExtraction(s.db, { tenantId: s.tenantId, engagementId, actor, now });
      if (!r.ok) return json(409, { ok: false, error: r.error });
      return json(200, { ok: true, step_id: r.stepId });
    }
    case "build_brief": {
      const r = await buildBrief(s.db, { tenantId: s.tenantId, engagementId, actor, now, deps: defaultSiteDeps() });
      if (!r.ok) return json(r.error === "not_found" ? 404 : r.error === "not_installed" ? 503 : 409, { ok: false, error: r.error === "not_found" ? r.error : `brief_${r.error}` });
      return json(200, { ok: true, brief_id: r.brief.id, version_no: r.brief.version_no, status: r.brief.status });
    }
    case "create_meet_room": {
      // The lead's call room: the one already booked or made, or a new one, made only where a call can connect and
      // recorded only where Meet records (the checks Meet's own room route makes).
      const meet = liveMeetDeps();
      const r = await createAuditRoom(s.db, {
        tenantId: s.tenantId,
        engagementId,
        hostUserId: actor.id ?? "",
        now,
        meet: { mediaReady: () => meetMediaReady(meet), recordingAvailable: (tenantId) => meet.recording.available(tenantId) },
      });
      if (!r.ok) return json(r.error === "not_found" ? 404 : r.error === "meet_not_configured" ? 503 : 409, { ok: false, error: r.error });
      return json(200, { ok: true, room_id: r.roomId, code: r.code, created: r.created });
    }
    case "attach_meet_transcript": {
      const roomId = typeof body.room_id === "string" ? body.room_id : "";
      // The client's answer about AI analysis, said by hand: the workspace owner's word, as every gate is (review of phase 2c, F2).
      const ai = typeof body.ai === "boolean" ? body.ai : undefined;
      if (ai !== undefined && !s.isOwner) return json(403, { ok: false, error: "owner_only" });
      const r = await attachMeetTranscript(s.db, { tenantId: s.tenantId, engagementId, roomId, actor, now, ai, byOwner: s.isOwner });
      if (!r.ok) {
        const status = r.error === "not_found" ? 404 : r.error === "owner_only" ? 403 : 409;
        return json(status, { ok: false, error: r.error, ...(r.holds?.length ? { detail: r.holds.map((h) => h.words).join("; ") } : {}) });
      }
      if (!r.duplicate) await withdrawAuthorizationIfStale(s.db, s.tenantId, engagementId, actor, now);
      return json(200, { ok: true, transcript_id: r.transcriptId, duplicate: r.duplicate });
    }
    case "request_authorization": {
      const r = await requestAuthorization(s.db, { tenantId: s.tenantId, engagementId, actor, now, engine: body.engine });
      if (!r.ok) return json(409, { ok: false, error: r.error });
      return json(200, { ok: true, approval_id: r.approvalId, created: r.created });
    }
    default:
      return json(400, { ok: false, error: "unknown_action" });
  }
}
