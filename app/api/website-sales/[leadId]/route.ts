import { NextRequest, NextResponse } from "next/server";
import { mayHostAuditCall, mayQuoteAndClose } from "@/lib/team-roles";
import { resolveSessionContext } from "@/lib/api-auth";
import { isUniqueViolationError } from "@/lib/api-helpers";
import { getServiceSupabase } from "@/lib/supabase-server";
import { WEBSITE_PACKAGES, WEBSITE_SALES_STAGES, isSellableAutomation, validateQuote, type WebsitePackageId } from "@/lib/website-sales";
import {
  dispositionPatch,
  mayAgentBookFounder,
  mayAgentQualify,
  mayCloseWebsiteDeal,
  mayRecordDisposition,
  maySendWebsiteProposal,
  mayUseDirectAdvance,
  mayWorkWebsiteSalesLifecycle,
  mayCreditAdminVerifiedCloser,
  nextOasisLifecycleStage,
  resolveWebsiteSalesCloseParties,
  resolveWebsiteSalesHandoffRep,
  type RepDisposition,
} from "@/lib/website-sales-workflow";
import { runStageTransitionHooks } from "@/lib/portals/stage-hooks";
import { getTenantIntegrationValue } from "@/lib/tenant-integration-store";
import {
  normalizeWebsiteBuildBrief,
  websiteBuildBriefIsReady,
} from "@/lib/website-sales-build-brief";
import {
  createStripeWebsiteCheckout,
  verifyManualWebsitePayment,
  verifyStripeWebsitePayment,
  type VerifiedWebsitePayment,
  type WebsitePaymentProvider,
} from "@/lib/website-sales-payment";
import {
  OASIS_COLD_OUTBOUND_MOTION,
  OASIS_WEBSITE_SALES_PROGRAM,
  isWebsiteSalesTenantSlug,
} from "@/lib/leads/canonical-lead-fields";
import { normalizeCollaborators } from "@/lib/lead-scope";
import { mayOperateOasisDeliveryStage, ownsOasisSalesRecord } from "@/lib/oasis-sales-pipeline-policy";
import {
  activateVerifiedFounderMeeting,
  cancelVerifiedFounderMeeting,
  closeVerifiedFounderMeeting,
  createVerifiedFounderMeeting,
  founderMeetingSmsConsentErrorResponse,
  grantFounderMeetingSmsConsent,
  prepareVerifiedFounderMeetingCancellation,
  rescheduleVerifiedFounderMeeting,
  type VerifiedFounderMeeting,
} from "@/lib/website-sales-founder-meeting";
import { readCurrentHttpsConsentArtifact } from "@/lib/sms/consent";
import {
  SMS_CONSENT_DISCLOSURE,
  SMS_CONSENT_DISCLOSURE_VERSION,
} from "@/lib/sms/auto-responses";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPositiveCentAmount(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value > 0 &&
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-7
  );
}

function storedCheckout(data: Record<string, unknown>): { reference: string; url: string } | null {
  const reference = typeof data.stripe_checkout_session_id === "string"
    ? data.stripe_checkout_session_id.trim()
    : "";
  const url = typeof data.stripe_checkout_url === "string" ? data.stripe_checkout_url.trim() : "";
  return /^cs_live_[A-Za-z0-9_]+$/.test(reference) && url.startsWith("https://checkout.stripe.com/")
    ? { reference, url }
    : null;
}

function lifecycleInteractionType(action: string): string {
  if (action === "disposition") return "call_disposition";
  if (action === "qualify") return "qualification_completed";
  if (action === "book_founder") return "founder_handoff";
  if (action === "complete_audit") return "audit_completed";
  if (action === "proposal") return "proposal_sent";
  if (action === "create_payment_link") return "payment_link_created";
  if (action === "deal_outcome") return "deal_outcome";
  if (action === "record_payment") return "deal_closed";
  if (action === "founder_meeting_sms_consent") return "sms_consent_captured";
  return "stage_changed";
}

function verifiedFounderSmsConsentArtifact(value: unknown, nowMs: number): Record<string, unknown> {
  const verdict = readCurrentHttpsConsentArtifact(value, nowMs);
  if (!verdict.ok) throw new Error("invalid_sms_consent_artifact");
  const artifact = verdict.artifact;
  if (
    artifact.disclosureText !== SMS_CONSENT_DISCLOSURE ||
    artifact.disclosureVersion !== SMS_CONSENT_DISCLOSURE_VERSION ||
    artifact.sellerNamed !== "OASIS AI Solutions" ||
    artifact.method !== "verbal"
  ) {
    throw new Error("invalid_sms_consent_artifact");
  }
  return {
    disclosure_text: artifact.disclosureText,
    disclosure_version: artifact.disclosureVersion,
    seller_named: artifact.sellerNamed,
    captured_at: artifact.capturedAtIso,
    method: artifact.method,
    source_url: artifact.sourceUrl,
  };
}

/**
 * Resolve the opener rep's invite copy. The opener is CC'd on the audit
 * invite when they are not the host/closer; a missing or malformed profile
 * degrades to no copy instead of blocking a verified booking.
 */
async function resolveOpenerAttendee(
  db: ReturnType<typeof getServiceSupabase>,
  tenantId: string,
  openerUserId: unknown,
  excludeEmail: unknown,
): Promise<{ email: string; displayName?: string } | null> {
  const userId = typeof openerUserId === "string" && UUID.test(openerUserId.trim())
    ? openerUserId.trim().toLowerCase()
    : "";
  if (!userId) return null;
  const profile = await db
    .from("user_profiles")
    .select("email,full_name")
    .eq("tenant_id", tenantId)
    .eq("auth_user_id", userId)
    .maybeSingle();
  if (profile.error || !profile.data) return null;
  const email = typeof profile.data.email === "string" ? profile.data.email.trim().toLowerCase() : "";
  const excluded = typeof excludeEmail === "string" ? excludeEmail.trim().toLowerCase() : "";
  if (!email.includes("@") || email === excluded) return null;
  const fullName = typeof profile.data.full_name === "string" ? profile.data.full_name.trim() : "";
  return fullName ? { email, displayName: fullName } : { email };
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok:false,error:"unauthorized" },{status:401});
  const { leadId } = await params;
  if (!UUID.test(leadId)) return NextResponse.json({ok:false,error:"invalid_lead_id"},{status:400});
  const mayBeDeliveryOperator = session.teamRole.trim().toLowerCase() === "builder";
  if (!mayWorkWebsiteSalesLifecycle(session.teamRole, session.isAdmin) && !mayBeDeliveryOperator) {
    return NextResponse.json({ok:false,error:"forbidden_sales_role"},{status:403});
  }
  const db = getServiceSupabase();
  const lead = await db.from("tenant_records").select("id,data").eq("tenant_id", session.tenantId).eq("id",leadId).eq("entity_type","lead").maybeSingle();
  if (!lead.data) return NextResponse.json({ok:false,error:"lead_not_found"},{status:404});
  // The lead's fields live in the row's `data` JSON column — the row object
  // itself only has {id, data}. Reading sales_program/assigned_to off the row
  // (the pre-v2 shape of this line) made every request 404 as
  // not_website_sales_lead before any action could run.
  const row = lead.data as { id: string; data?: unknown };
  const current = (row.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data : {}) as Record<string,unknown>;
  // Legacy oasis-ai-cc rows predate sales_program and are still legitimate
  // OASIS pipeline leads. The old row-only gate made every lifecycle button
  // return 404 on that account. Resolve the tenant server-side and permit the
  // workflow only for an OASIS sales tenant; a foreign tenant cannot turn an
  // arbitrary lead into a website-sales lead by omitting the marker.
  const tenant = await db
    .from("tenants")
    .select("slug")
    .eq("id", session.tenantId)
    .maybeSingle();
  if (tenant.error) {
    return NextResponse.json({ok:false,error:"tenant_lookup_failed",detail:tenant.error.message},{status:500});
  }
  const tenantSlug = typeof tenant.data?.slug === "string" ? tenant.data.slug : null;
  const isOasisSalesTenant = isWebsiteSalesTenantSlug(tenantSlug);
  if (current.sales_program !== OASIS_WEBSITE_SALES_PROGRAM && !isOasisSalesTenant) {
    return NextResponse.json({ok:false,error:"not_website_sales_lead"},{status:404});
  }
  if (current.sales_motion !== OASIS_COLD_OUTBOUND_MOTION) {
    return NextResponse.json({ok:false,error:"not_cold_outbound_lead"},{status:409});
  }
  const currentStage = typeof current.stage === "string" ? current.stage : "";
  const assignedToUser = String(current.assigned_to || "").toLowerCase() === session.userId.toLowerCase();
  const attributedToUser = String(current.attributed_rep_user_id || "").toLowerCase() === session.userId.toLowerCase();
  const actorOwnsSalesLead = ownsOasisSalesRecord({ id: row.id, data: current }, session.userId);
  // A manager's frozen attribution survives a handoff for reporting, but it is
  // not continuing write authority. Managers operate their own assigned lead
  // normally and coach every other roster lead read-only. The explicit
  // admin_access toggle retains its existing tenant-wide semantics via
  // session.isAdmin.
  if (
    session.teamRole.trim().toLowerCase() === "manager" &&
    !session.isAdmin &&
    !assignedToUser
  ) {
    return NextResponse.json({ok:false,error:"lead_not_assigned_to_agent"},{status:403});
  }
  const builderMayRunDelivery = mayOperateOasisDeliveryStage(session.teamRole, currentStage);
  const builderOwnsDelivery = builderMayRunDelivery && ownsOasisSalesRecord(
    { id:row.id, data:current },
    session.userId,
  );
  // CC, 2026-08-25: a builder working HIS OWN sales lead (assigned, or frozen
  // attribution) walks the normal rep path through this route. The delivery
  // lane below exists for his BUILD work; letting it intercept the selling
  // half 403'd every structured sales action a selling builder clicked.
  const builderOnOwnSalesLead = mayBeDeliveryOperator && (assignedToUser || attributedToUser);
  if (mayBeDeliveryOperator && !builderOnOwnSalesLead && (!builderMayRunDelivery || !builderOwnsDelivery)) {
    return NextResponse.json({
      ok:false,
      error:builderMayRunDelivery ? "builder_not_assigned_to_lead" : "builder_delivery_stage_only",
    },{status:403});
  }
  if (!session.isAdmin && !builderOwnsDelivery && !assignedToUser && !attributedToUser && !actorOwnsSalesLead) {
    return NextResponse.json({ok:false,error:"lead_not_assigned_to_agent"},{status:403});
  }
  // Role and ownership are both load-bearing. Explicit closers and legacy
  // full-stack agents may quote or close; explicit openers cannot. Ownership
  // may come from current assignment or frozen attribution, so a legacy
  // full-stack rep keeps the ability to close a deal they originated.
  const repMayRunDeal = mayQuoteAndClose(session.teamRole) && (assignedToUser || attributedToUser || actorOwnsSalesLead);
  const body = await req.json().catch(() => null) as Record<string,unknown>|null;
  if (!body || typeof body.action !== "string") return NextResponse.json({ok:false,error:"invalid_body"},{status:400});
  if (builderMayRunDelivery && !builderOnOwnSalesLead && body.action !== "advance") {
    return NextResponse.json({ok:false,error:"builder_delivery_action_only"},{status:403});
  }
  const trackedAction = ["advance","disposition","qualify","book_founder","founder_meeting_sms_consent","complete_audit","set_stage","proposal","create_payment_link","deal_outcome","record_payment"].includes(body.action);
  const requestId = typeof body.requestId === "string" && UUID.test(body.requestId) ? body.requestId : null;
  if (trackedAction && !requestId) return NextResponse.json({ok:false,error:"request_id_required"},{status:400});
  if (requestId) {
    const prior = await db
      .from("lead_interactions")
      .select("id,lead_id,metadata")
      .eq("tenant_id",session.tenantId)
      .eq("agent_source","website_sales_pipeline")
      .eq("metadata->>request_id",requestId)
      .limit(1);
    if (prior.error) return NextResponse.json({ok:false,error:"idempotency_check_failed",detail:prior.error.message,correlationId:requestId},{status:500});
    const duplicate = (prior.data || [])[0] as { lead_id?: unknown; metadata?: unknown }|undefined;
    if (duplicate) {
      if (duplicate.lead_id !== leadId) {
        return NextResponse.json({ok:false,error:"request_id_reused_for_different_lead"},{status:409});
      }
      const metadata = duplicate.metadata as Record<string,unknown>|null;
      if (metadata?.action !== undefined && metadata.action !== body.action) {
        return NextResponse.json({ok:false,error:"request_id_reused_for_different_action"},{status:409});
      }
      if (
        body.action === "deal_outcome" &&
        metadata?.deal_outcome !== undefined &&
        metadata.deal_outcome !== body.outcome
      ) {
        return NextResponse.json({ok:false,error:"request_id_reused_for_different_outcome"},{status:409});
      }
      if (body.action === "book_founder") {
        const founderUserId = typeof body.founderUserId === "string" ? body.founderUserId.trim() : "";
        const meetingAt = typeof body.meetingAt === "string" ? body.meetingAt.trim() : "";
        const promisedDemo = typeof body.promisedDemo === "string" ? body.promisedDemo.trim() : "";
        const handoffNote = typeof body.note === "string" ? body.note.trim() : "";
        const expectedOrganizerEmail = typeof current.audit_host_email === "string"
          ? current.audit_host_email.trim()
          : "";
        const confirmations = body.confirmations && typeof body.confirmations === "object" && !Array.isArray(body.confirmations)
          ? body.confirmations as Record<string, unknown>
          : null;
        const contact = body.contact && typeof body.contact === "object" && !Array.isArray(body.contact)
          ? body.contact as Record<string, unknown>
          : {};
        if (
          !UUID.test(founderUserId) ||
          !meetingAt ||
          !promisedDemo ||
          !handoffNote ||
          !expectedOrganizerEmail ||
          !confirmations ||
          confirmations.contactConfirmed !== true ||
          confirmations.clientAgreedToTime !== true ||
          confirmations.handoffComplete !== true
        ) {
          return NextResponse.json({ok:false,error:"booking_request_mismatch"},{status:409});
        }
        let existingMeeting: VerifiedFounderMeeting;
        try {
          existingMeeting = await createVerifiedFounderMeeting({
            tenantId:session.tenantId,
            leadId,
            actorUserId:session.userId,
            hostUserId:founderUserId,
            requestId,
            meetingAt,
            contact,
            clientAgenda:promisedDemo,
            handoffNote,
            smsConsent:body.smsConsent === true,
            expectedOrganizerEmail,
            confirmations:{
              contactConfirmed:true,
              clientAgreedToTime:true,
              handoffComplete:true,
            },
          });
          await activateVerifiedFounderMeeting(session.tenantId, existingMeeting.appointmentId);
        } catch (error) {
          const detail = error instanceof Error ? error.message : "booking_request_mismatch";
          return NextResponse.json({
            ok:false,
            error:detail.split(":",1)[0],
            detail,
            stageUpdated:true,
          },{status:detail.startsWith("booking_request_mismatch") ? 409 : 503});
        }
        return NextResponse.json({
          ok:true,
          idempotent:true,
          meeting:{
            appointmentId:existingMeeting.appointmentId,
            meetingAt:existingMeeting.meetingAt,
            timezone:existingMeeting.timezone,
            eventId:existingMeeting.receipt.eventId,
            calendarUrl:existingMeeting.receipt.htmlLink,
            meetLink:existingMeeting.receipt.meetLink,
          },
        });
      }
      if (body.action === "deal_outcome" && body.outcome === "reschedule") {
        const appointmentId = typeof current.calendar_appointment_id === "string"
          ? current.calendar_appointment_id.trim()
          : "";
        if (!UUID.test(appointmentId)) {
          return NextResponse.json({ok:false,error:"verified_meeting_receipt_missing"},{status:409});
        }
        const existingMeeting = await db.from("call_appointments")
          .select("id,scheduled_for,timezone,google_event_id,google_event_html_link,google_meet_link,calendar_status,last_reschedule_request_id,pending_request_id")
          .eq("tenant_id",session.tenantId)
          .eq("lead_id",leadId)
          .eq("id",appointmentId)
          .maybeSingle();
        const meeting = existingMeeting.data as Record<string, unknown> | null;
        if (
          existingMeeting.error ||
          !meeting ||
          meeting.calendar_status !== "verified" ||
          ![meeting.last_reschedule_request_id, meeting.pending_request_id].includes(requestId)
        ) {
          return NextResponse.json({ok:false,error:"verified_meeting_receipt_missing"},{status:409});
        }
        try {
          await activateVerifiedFounderMeeting(session.tenantId, appointmentId);
        } catch (error) {
          return NextResponse.json({
            ok:false,
            error:"meeting_activation_failed",
            detail:error instanceof Error ? error.message : "meeting_activation_failed",
            stageUpdated:true,
          },{status:503});
        }
        return NextResponse.json({
          ok:true,
          idempotent:true,
          meeting:{
            appointmentId,
            meetingAt:meeting.scheduled_for,
            timezone:meeting.timezone,
            eventId:meeting.google_event_id,
            calendarUrl:meeting.google_event_html_link,
            meetLink:meeting.google_meet_link,
          },
        });
      }
      if (body.action === "deal_outcome" && body.outcome === "lost") {
        const appointmentId = typeof current.calendar_appointment_id === "string"
          ? current.calendar_appointment_id.trim()
          : "";
        if (UUID.test(appointmentId)) {
          try {
            const cancellation = await cancelVerifiedFounderMeeting({
              tenantId:session.tenantId,
              leadId,
              appointmentId,
              requestId,
            });
            return NextResponse.json({
              ok:true,
              idempotent:true,
              cancellationDisposition:cancellation.disposition,
            });
          } catch (error) {
            return NextResponse.json({
              ok:false,
              error:"calendar_cancel_failed",
              detail:error instanceof Error ? error.message : "calendar_cancel_failed",
              stageUpdated:true,
            },{status:503});
          }
        }
      }
      if (body.action === "founder_meeting_sms_consent") {
        const appointmentId = typeof current.calendar_appointment_id === "string"
          ? current.calendar_appointment_id.trim()
          : "";
        if (!UUID.test(appointmentId)) {
          return NextResponse.json({ok:false,error:"verified_meeting_required"},{status:409});
        }
        let artifact: Record<string, unknown>;
        try {
          artifact = verifiedFounderSmsConsentArtifact(body.smsConsentArtifact, Date.now());
          await grantFounderMeetingSmsConsent({
            tenantId:session.tenantId,
            leadId,
            appointmentId,
            consentedPhone:current.phone,
            capturedAt:new Date(String(artifact.captured_at)),
          });
        } catch (error) {
          const failure = founderMeetingSmsConsentErrorResponse(error);
          return NextResponse.json(failure.body, { status: failure.status });
        }
        return NextResponse.json({ok:true,idempotent:true});
      }
      const checkout = body.action === "create_payment_link" ? storedCheckout(current) : null;
      return NextResponse.json({
        ok:true,
        idempotent:true,
        ...(checkout ? { checkoutReference:checkout.reference, checkoutUrl:checkout.url } : {}),
      });
    }
  }
  if (trackedAction && typeof body.expectedStage !== "string") {
    return NextResponse.json({ok:false,error:"expected_stage_required"},{status:400});
  }
  if (trackedAction && body.expectedStage !== currentStage) {
    return NextResponse.json(
      {ok:false,error:"stage_changed_refresh",currentStage},
      {status:409},
    );
  }
  const occurredAt = new Date().toISOString();
  const transitionNote = typeof body.note === "string" ? body.note.trim() : "";
  if (transitionNote.length > 4000) {
    return NextResponse.json({ok:false,error:"transition_note_too_long"},{status:400});
  }
  let patch: Record<string,unknown> = {};
  let verifiedMeeting: VerifiedFounderMeeting | null = null;
  let smsConsentAfterTransition: { appointmentId: string; capturedAt: Date } | null = null;
  let cancellationAfterTransition: { appointmentId: string; requestId: string } | null = null;
  let cancellationDisposition: "cancelled" | "preserved" | "pending" | null = null;
  if (body.action === "founder_meeting_sms_consent") {
    const appointmentId = typeof current.calendar_appointment_id === "string"
      ? current.calendar_appointment_id.trim()
      : "";
    if (!UUID.test(appointmentId)) {
      return NextResponse.json({ok:false,error:"verified_meeting_required"},{status:409});
    }
    let artifact: Record<string, unknown>;
    try {
      artifact = verifiedFounderSmsConsentArtifact(body.smsConsentArtifact, Date.now());
    } catch (error) {
      const code = error instanceof Error ? error.message : "invalid_sms_consent_artifact";
      return NextResponse.json({ok:false,error:code},{status:400});
    }
    patch = {
      stage: currentStage,
      founder_meeting_sms_consent: true,
      founder_meeting_sms_consent_artifact: artifact,
    };
    smsConsentAfterTransition = {
      appointmentId,
      capturedAt: new Date(String(artifact.captured_at)),
    };
  } else if (body.action === "disposition") {
    const disposition = String(body.disposition || "");
    const allowed = ["attempted", "voicemail", "connected", "lost"];
    if (!allowed.includes(disposition)) return NextResponse.json({ok:false,error:"invalid_disposition"},{status:400});
    if (!mayRecordDisposition(currentStage, disposition as RepDisposition)) return NextResponse.json({ok:false,error:"invalid_stage_transition"},{status:409});
    const nextActionAt = typeof body.nextActionAt === "string" && body.nextActionAt ? body.nextActionAt : null;
    try { patch = dispositionPatch(disposition as RepDisposition,nextActionAt,occurredAt,String(body.lossReason || "")); }
    catch (error) { return NextResponse.json({ok:false,error:error instanceof Error ? error.message : "invalid_disposition"},{status:400}); }
  } else if (body.action === "qualify") {
    if (!mayAgentQualify(currentStage)) return NextResponse.json({ok:false,error:"connect_before_qualifying"},{status:409});
    const q = body.qualification as Record<string,unknown>|undefined;
    if (!q || !["authorityConfirmed","websiteProblemConfirmed","timingConfirmed","minimumInvestmentConfirmed"].every(k => q[k] === true)) return NextResponse.json({ok:false,error:"qualification_incomplete"},{status:400});
    patch = { qualification:q, stage:"qualified", qualified_at:occurredAt };
  } else if (body.action === "book_founder") {
    const qualification = body.qualification as Record<string,unknown>|undefined;
    const qualificationIncluded = Boolean(
      qualification &&
      ["authorityConfirmed","websiteProblemConfirmed","timingConfirmed","minimumInvestmentConfirmed"]
        .every((key) => qualification[key] === true),
    );
    if (!mayAgentBookFounder(currentStage, qualificationIncluded)) {
      return NextResponse.json({ok:false,error:"qualify_before_booking"},{status:409});
    }
    const confirmations = body.confirmations && typeof body.confirmations === "object" && !Array.isArray(body.confirmations)
      ? body.confirmations as Record<string, unknown>
      : null;
    if (
      !confirmations ||
      confirmations.contactConfirmed !== true ||
      confirmations.clientAgreedToTime !== true ||
      confirmations.handoffComplete !== true
    ) {
      return NextResponse.json({ok:false,error:"booking_confirmations_required"},{status:400});
    }
    const qualifiedDuringHandoff = currentStage !== "qualified";
    if (!transitionNote) return NextResponse.json({ok:false,error:"handoff_note_required"},{status:400});
    const founderUserId = typeof body.founderUserId === "string" ? body.founderUserId.trim() : "";
    const meetingAt = typeof body.meetingAt === "string" ? body.meetingAt.trim() : "";
    const promisedDemo = typeof body.promisedDemo === "string" ? body.promisedDemo.trim() : "";
    if (!UUID.test(founderUserId) || !meetingAt || !promisedDemo || !requestId) return NextResponse.json({ok:false,error:"invalid_handoff"},{status:400});
    if (!Number.isFinite(Date.parse(meetingAt)) || Date.parse(meetingAt) <= Date.now()) return NextResponse.json({ok:false,error:"meeting_must_be_in_future"},{status:400});
    if (promisedDemo.length > 500) return NextResponse.json({ok:false,error:"promised_demo_too_long"},{status:400});
    const auditHost = await db.from("user_profiles").select("id,is_owner,team_role,email").eq("tenant_id",session.tenantId).eq("auth_user_id",founderUserId).maybeSingle();
    if (auditHost.error) {
      return NextResponse.json({ok:false,error:"audit_host_lookup_failed"},{status:503});
    }
    if (
      !auditHost.data ||
      (!auditHost.data.is_owner && !mayHostAuditCall(auditHost.data.team_role))
    ) return NextResponse.json({ok:false,error:"audit_host_not_authorized"},{status:400});
    const auditHostEmail = typeof auditHost.data.email === "string" ? auditHost.data.email.trim() : "";
    if (!auditHostEmail || !auditHostEmail.includes("@")) {
      return NextResponse.json({ok:false,error:"audit_host_email_required"},{status:409});
    }
    const contact = body.contact && typeof body.contact === "object" && !Array.isArray(body.contact)
      ? body.contact as Record<string,unknown>
      : {};
    let smsConsentArtifact: Record<string, unknown> | null = null;
    if (body.smsConsent === true) {
      try {
        smsConsentArtifact = verifiedFounderSmsConsentArtifact(body.smsConsentArtifact, Date.now());
      } catch (error) {
        const code = error instanceof Error ? error.message : "invalid_sms_consent_artifact";
        return NextResponse.json({ok:false,error:code},{status:400});
      }
    }
    // Resolve the opener BEFORE the provider call so their invite copy rides
    // on the original Calendar event (and every reschedule of it).
    const existingRep = resolveWebsiteSalesHandoffRep(
      current.attributed_rep_user_id,
      current.assigned_to,
      session.userId,
    );
    const openerAttendee = await resolveOpenerAttendee(db, session.tenantId, existingRep, auditHostEmail);
    try {
      verifiedMeeting = await createVerifiedFounderMeeting({
        tenantId:session.tenantId,
        leadId,
        actorUserId:session.userId,
        hostUserId:founderUserId,
        requestId,
        meetingAt,
        contact,
        clientAgenda:promisedDemo,
        handoffNote:transitionNote,
        smsConsent:body.smsConsent === true,
        expectedOrganizerEmail:auditHostEmail,
        openerAttendee,
        confirmations:{
          contactConfirmed:true,
          clientAgreedToTime:true,
          handoffComplete:true,
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "calendar_create_failed";
      const code = detail.split(":",1)[0];
      const status = ["client_email_required","client_phone_required","invalid_client_phone","invalid_client_website","client_agenda_required","handoff_note_required","sms_consent_requires_phone","meeting_must_be_in_future","booking_request_mismatch"].includes(code)
        ? 400
        : ["google_calendar_not_connected","calendar_scope_required","calendar_organizer_mismatch"].includes(code)
          ? 409
          : 503;
      return NextResponse.json({ok:false,error:code,detail,correlationId:requestId},{status});
    }
    const collaborators = [
      existingRep,
      ...normalizeCollaborators(current).filter((userId) => userId !== founderUserId),
    ].filter((userId, index, list) => list.indexOf(userId) === index).slice(0, 5);
    patch = {
      stage:"founder_meeting_booked",
      ...(qualifiedDuringHandoff
        ? {
            qualification,
            qualified_at:occurredAt,
            qualification_completed_by:session.userId,
            qualification_source:"confirmed_calendar_handoff",
          }
        : {}),
      // booked_founder is retained for existing reports while audit_host_* is
      // the accurate model: an experienced closer may host this call too.
      booked_founder:founderUserId,
      audit_host_user_id:founderUserId,
      audit_host_email:auditHostEmail,
      audit_host_role:String(auditHost.data.team_role || (auditHost.data.is_owner ? "owner" : "closer")),
      audit_duration_minutes:15,
      calendar_event_status:"verified",
      calendar_confirmation_method:"server_google_calendar_api",
      calendar_confirmed_at:occurredAt,
      calendar_confirmed_by:session.userId,
      calendar_appointment_id:verifiedMeeting.appointmentId,
      google_calendar_id:verifiedMeeting.receipt.calendarId,
      google_calendar_event_id:verifiedMeeting.receipt.eventId,
      google_calendar_event_url:verifiedMeeting.receipt.htmlLink,
      google_meet_link:verifiedMeeting.receipt.meetLink,
      google_ical_uid:verifiedMeeting.receipt.iCalUID || null,
      founder_meeting_at:meetingAt,
      next_action_at:meetingAt,
      promised_demo:promisedDemo,
      founder_handoff_note:transitionNote,
      founder_handoff_note_at:occurredAt,
      name:verifiedMeeting.contact.name,
      company:verifiedMeeting.contact.company,
      email:verifiedMeeting.contact.email,
      phone:verifiedMeeting.contact.phone,
      website:verifiedMeeting.contact.website,
      founder_meeting_sms_consent:body.smsConsent === true,
      founder_meeting_sms_consent_artifact:smsConsentArtifact,
      founder_contact_confirmed_at:occurredAt,
      founder_time_confirmed_at:occurredAt,
      founder_handoff_confirmed_at:occurredAt,
      founder_booking_confirmed_by:session.userId,
      attributed_rep_user_id:existingRep,
      attribution_frozen_at:current.attribution_frozen_at || occurredAt,
      assigned_to:founderUserId,
      collaborators,
    };
  } else if (body.action === "complete_audit") {
    if (!session.isTrueAdmin && !repMayRunDeal) {
      return NextResponse.json({ok:false,error:"founder_or_closer_only"},{status:403});
    }
    if (currentStage !== "founder_meeting_booked") {
      return NextResponse.json({ok:false,error:"founder_meeting_required"},{status:409});
    }
    const normalized = normalizeWebsiteBuildBrief(body.buildBrief, session.userId, occurredAt);
    if (!normalized.ok) {
      return NextResponse.json({ok:false,error:normalized.error},{status:400});
    }
    const appointmentId = typeof current.calendar_appointment_id === "string"
      ? current.calendar_appointment_id.trim()
      : "";
    if (UUID.test(appointmentId)) {
      try {
        await closeVerifiedFounderMeeting({
          tenantId:session.tenantId,
          leadId,
          appointmentId,
          outcome:"completed",
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "meeting_close_failed";
        return NextResponse.json({ok:false,error:detail.split(":",1)[0],detail,correlationId:requestId},{status:503});
      }
    }
    patch = {
      stage:"demo_completed",
      audit_completed_at:occurredAt,
      build_brief:normalized.brief,
      build_handoff_status:"ready_for_pricing",
    };
  } else if (body.action === "deal_outcome") {
    if (!session.isTrueAdmin && !repMayRunDeal) {
      return NextResponse.json({ok:false,error:"founder_or_closer_only"},{status:403});
    }
    if (!["founder_meeting_booked", "demo_completed", "proposal_sent"].includes(currentStage)) {
      return NextResponse.json({ok:false,error:"deal_outcome_not_available"},{status:409});
    }
    const outcome = typeof body.outcome === "string" ? body.outcome.trim() : "";
    if (!["lost", "no_show", "reschedule", "follow_up"].includes(outcome)) {
      return NextResponse.json({ok:false,error:"invalid_deal_outcome"},{status:400});
    }
    if (body.outcomeConfirmed !== true) {
      return NextResponse.json({ok:false,error:"outcome_confirmation_required"},{status:400});
    }
    if (outcome !== "lost" && !transitionNote) {
      return NextResponse.json({ok:false,error:"outcome_note_required"},{status:400});
    }
    if (outcome === "lost") {
      const lossReason = typeof body.lossReason === "string" ? body.lossReason.trim() : "";
      if (!lossReason || lossReason.length > 500) {
        return NextResponse.json({ok:false,error:"loss_reason_required"},{status:400});
      }
      const appointmentId = typeof current.calendar_appointment_id === "string"
        ? current.calendar_appointment_id.trim()
        : "";
      if (UUID.test(appointmentId) && requestId) {
        try {
          const reservation = await prepareVerifiedFounderMeetingCancellation({
            tenantId:session.tenantId,
            leadId,
            appointmentId,
            requestId,
          });
          cancellationDisposition = reservation.disposition;
          if (reservation.disposition === "pending") {
            cancellationAfterTransition = { appointmentId, requestId };
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : "meeting_cancel_reservation_failed";
          const code = detail.split(":",1)[0];
          return NextResponse.json({ok:false,error:code,detail,correlationId:requestId},{status:409});
        }
      }
      patch = {
        stage:"lost",
        deal_outcome:"lost",
        deal_outcome_at:occurredAt,
        loss_reason:lossReason,
        next_action_at:null,
        ...(UUID.test(appointmentId)
          ? { founder_meeting_status:"closed_lost", calendar_event_status:"closed_lost" }
          : {}),
      };
    } else {
      const nextActionAt = typeof body.nextActionAt === "string" ? body.nextActionAt.trim() : "";
      if (!Number.isFinite(Date.parse(nextActionAt)) || Date.parse(nextActionAt) <= Date.now()) {
        return NextResponse.json({ok:false,error:"next_action_must_be_in_future"},{status:400});
      }
      const appointmentId = typeof current.calendar_appointment_id === "string"
        ? current.calendar_appointment_id.trim()
        : "";
      if (outcome === "reschedule") {
        if (!UUID.test(appointmentId) || !requestId) {
          return NextResponse.json({ok:false,error:"verified_meeting_required"},{status:409});
        }
        try {
          const openerAttendee = await resolveOpenerAttendee(
            db,
            session.tenantId,
            // Post-booking assigned_to is the closer; attributed_rep stays the
            // opener. excludeEmail drops the copy when they are the same person.
            current.attributed_rep_user_id ?? current.assigned_to,
            current.audit_host_email,
          );
          verifiedMeeting = await rescheduleVerifiedFounderMeeting({
            tenantId:session.tenantId,
            leadId,
            appointmentId,
            requestId,
            meetingAt:nextActionAt,
            openerAttendee,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : "calendar_update_failed";
          const code = detail.split(":",1)[0];
          const status = [
            "meeting_must_be_in_future",
            "reschedule_request_mismatch",
          ].includes(code) ? 400 : [
            "verified_meeting_required",
            "meeting_no_longer_reschedulable",
            "meeting_transition_pending",
            "google_calendar_not_connected",
            "calendar_scope_required",
          ].includes(code) ? 409 : 503;
          return NextResponse.json({ok:false,error:code,detail,correlationId:requestId},{status});
        }
      } else if (outcome === "no_show" && UUID.test(appointmentId)) {
        try {
          await closeVerifiedFounderMeeting({
            tenantId:session.tenantId,
            leadId,
            appointmentId,
            outcome:"no_show",
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : "meeting_close_failed";
          const code = detail.split(":",1)[0];
          return NextResponse.json({ok:false,error:code,detail,correlationId:requestId},{status:code === "meeting_not_started" ? 409 : 503});
        }
      }
      patch = {
        stage:currentStage,
        deal_outcome:outcome,
        deal_outcome_at:occurredAt,
        next_action_at:nextActionAt,
        ...(outcome === "no_show" ? { founder_meeting_status:"no_show" } : {}),
        ...(outcome === "reschedule"
          ? {
              founder_meeting_status:"rescheduled",
              calendar_appointment_id:appointmentId,
              founder_meeting_at:verifiedMeeting?.meetingAt || nextActionAt,
              calendar_event_status:"verified",
              google_calendar_id:verifiedMeeting?.receipt.calendarId,
              google_calendar_event_id:verifiedMeeting?.receipt.eventId,
              google_calendar_event_url:verifiedMeeting?.receipt.htmlLink,
              google_meet_link:verifiedMeeting?.receipt.meetLink,
              google_ical_uid:verifiedMeeting?.receipt.iCalUID || null,
              calendar_appointment_revision:verifiedMeeting?.revision,
            }
          : {}),
        ...(outcome === "follow_up" ? { proposal_status:"follow_up_pending" } : {}),
      };
    }
  } else if (body.action === "advance") {
    const nextStage = nextOasisLifecycleStage(currentStage);
    if (!nextStage) return NextResponse.json({ok:false,error:"no_next_stage"},{status:409});
    // Reps get the missing Assigned -> Attempting Contact edge. Later rep
    // edges deliberately stay behind their structured outcome, qualification,
    // and founder-handoff gates. Admins can continue the full lifecycle.
    if (!mayUseDirectAdvance(currentStage, session.isAdmin, repMayRunDeal) && !builderMayRunDelivery) {
      return NextResponse.json({ok:false,error:"use_structured_lifecycle_action"},{status:409});
    }
    patch = { stage:nextStage };
  } else if (body.action === "set_stage") {
    // Direct admin stage control (2026-08-25 operator plan): a true admin may
    // move a lead to ANY valid stage from the header dropdown, including the
    // structured targets. Downstream guards (stored_proposal_incomplete,
    // verified_meeting_required, builder_handoff_not_ready) still fail loudly
    // when a server-generated artifact is missing, so out-of-order moves can
    // never corrupt the payment or meeting ledgers — they just surface a
    // readable error instead of being silently blocked here.
    if (!WEBSITE_SALES_STAGES.includes(body.stage as never)) return NextResponse.json({ok:false,error:"invalid_stage"},{status:400});
    if (!session.isAdmin) return NextResponse.json({ok:false,error:"rep_stage_forbidden"},{status:403});
    if (currentStage === body.stage) return NextResponse.json({ok:true,noop:true,data:current});
    patch = { stage:body.stage };
  } else if (body.action === "proposal") {
    if (!session.isTrueAdmin && !repMayRunDeal) return NextResponse.json({ok:false,error:"founder_only"},{status:403});
    if (!maySendWebsiteProposal(currentStage)) return NextResponse.json({ok:false,error:"demo_before_proposal"},{status:409});
    if (!websiteBuildBriefIsReady(current.build_brief)) {
      return NextResponse.json({ok:false,error:"builder_handoff_not_ready"},{status:409});
    }
    const packageId = body.packageId as WebsitePackageId;
    const automationIds = Array.isArray(body.automationIds) ? body.automationIds.filter((value): value is string => typeof value === "string") : [];
    // Retired add-ons stay resolvable for historical deals but can never be
    // attached to a NEW quote — isSellableAutomation is the only gate.
    if (!WEBSITE_PACKAGES[packageId] || !automationIds.every(isSellableAutomation)) return NextResponse.json({ok:false,error:"invalid_offer"},{status:400});
    const setupAmount = Number(body.setupAmount);
    const monthlyAmount = Number(body.monthlyAmount);
    const paymentDueAmount = Number(body.paymentDueAmount);
    if (!Number.isFinite(setupAmount) || !Number.isFinite(monthlyAmount) || setupAmount < 0 || monthlyAmount < 0) return NextResponse.json({ok:false,error:"invalid_offer_amounts"},{status:400});
    if (!isPositiveCentAmount(paymentDueAmount) || paymentDueAmount > setupAmount) {
      return NextResponse.json({ok:false,error:"invalid_payment_schedule"},{status:400});
    }
    const check = validateQuote(packageId,setupAmount,monthlyAmount,session.isTrueAdmin);
    if (!check.ok) return NextResponse.json({ok:false,error:check.error},{status:400});
    patch = {
      stage:"proposal_sent",
      recommended_tier:packageId,
      automation_interests:automationIds,
      proposal_status:"sent",
      quoted_setup_amount:setupAmount,
      quoted_monthly_amount:monthlyAmount,
      payment_due_amount:paymentDueAmount,
      collected_setup_amount:0,
      setup_balance_due:setupAmount,
      payment_plan_id:crypto.randomUUID(),
      payment_plan_status:"awaiting_first_payment",
      payment_installment_number:1,
      proposal_payment_token:crypto.randomUUID(),
      stripe_checkout_session_id:null,
      stripe_checkout_url:null,
      stripe_checkout_created_at:null,
      currency:body.currency === "USD" ? "USD" : "CAD",
    };
  } else if (body.action === "create_payment_link") {
    if (!session.isTrueAdmin && !repMayRunDeal) return NextResponse.json({ok:false,error:"founder_only"},{status:403});
    if (!mayCloseWebsiteDeal(currentStage)) return NextResponse.json({ok:false,error:"proposal_before_payment_link"},{status:409});
    const paymentDueAmount = Number(current.payment_due_amount);
    const paymentToken = typeof current.proposal_payment_token === "string"
      ? current.proposal_payment_token.trim()
      : "";
    const paymentPlanId = typeof current.payment_plan_id === "string"
      ? current.payment_plan_id.trim()
      : "";
    const setupAmount = Number(current.quoted_setup_amount);
    const alreadyCollected = Number(current.collected_setup_amount || 0);
    if (
      !isPositiveCentAmount(paymentDueAmount) ||
      !isPositiveCentAmount(setupAmount) ||
      paymentDueAmount > setupAmount - alreadyCollected ||
      !UUID.test(paymentToken) ||
      !UUID.test(paymentPlanId)
    ) {
      return NextResponse.json({ok:false,error:"stored_proposal_payment_incomplete"},{status:409});
    }
    const existingCheckout = storedCheckout(current);
    let checkout = existingCheckout;
    if (!checkout) {
      const secretKey = await getTenantIntegrationValue(session.tenantId, "stripe", "secret_key");
      if (!secretKey) return NextResponse.json({ok:false,error:"stripe_not_connected"},{status:503});
      const packageId = current.recommended_tier as WebsitePackageId;
      if (!WEBSITE_PACKAGES[packageId]) {
        return NextResponse.json({ok:false,error:"stored_proposal_incomplete"},{status:409});
      }
      try {
        checkout = await createStripeWebsiteCheckout({
          secretKey,
          tenantId:session.tenantId,
          leadId,
          paymentToken,
          paymentPlanId,
          installmentKind:alreadyCollected > 0
            ? "balance"
            : paymentDueAmount === setupAmount
              ? "full"
              : "deposit",
          amountCents:Math.round(paymentDueAmount * 100),
          currency:current.currency === "USD" ? "USD" : "CAD",
          customerEmail:typeof current.email === "string" ? current.email : null,
          description:`${WEBSITE_PACKAGES[packageId].name} website ${alreadyCollected > 0 ? "setup balance" : paymentDueAmount === setupAmount ? "setup payment" : "setup deposit"}`,
          successUrl:`${req.nextUrl.origin}/pipeline/${leadId}?payment=success`,
          cancelUrl:`${req.nextUrl.origin}/pipeline/${leadId}?payment=cancelled`,
        });
      } catch (error) {
        const code = error instanceof Error ? error.message : "stripe_checkout_creation_failed";
        return NextResponse.json({ok:false,error:code},{status:code === "stripe_not_connected" ? 503 : 502});
      }
    }
    patch = {
      stage:currentStage,
      stripe_checkout_session_id:checkout.reference,
      stripe_checkout_url:checkout.url,
      stripe_checkout_created_at:typeof current.stripe_checkout_created_at === "string"
        ? current.stripe_checkout_created_at
        : occurredAt,
    };
  } else if (body.action === "close") {
    // Retire the old trust-the-browser close shape explicitly. A stale client
    // must fail closed instead of bypassing receipt verification.
    return NextResponse.json({ok:false,error:"use_verified_payment_action"},{status:409});
  } else if (body.action === "record_payment") {
    if (!session.isTrueAdmin && !repMayRunDeal) return NextResponse.json({ok:false,error:"founder_only"},{status:403});
    if (!mayCloseWebsiteDeal(currentStage)) return NextResponse.json({ok:false,error:"proposal_before_close"},{status:409});
    // A founder may verify cash after an experienced closer ran the audit.
    // Payment verification is an operator action, not permission to overwrite
    // the frozen opener/closer who actually earned the commission.
    let trustedCloserUserId: string | null = null;
    if (session.isTrueAdmin) {
      const frozenOpener = typeof current.attributed_rep_user_id === "string" && UUID.test(current.attributed_rep_user_id)
        ? current.attributed_rep_user_id
        : null;
      const auditHostUserId = typeof current.audit_host_user_id === "string" && UUID.test(current.audit_host_user_id)
        ? current.audit_host_user_id
        : null;
      const assignedUserId = typeof current.assigned_to === "string" && UUID.test(current.assigned_to)
        ? current.assigned_to
        : null;
      const recordedAuditHostRole = typeof current.audit_host_role === "string"
        ? current.audit_host_role.trim().toLowerCase()
        : "";
      const closerCandidates = [auditHostUserId, assignedUserId]
        .filter((value): value is string => typeof value === "string" && UUID.test(value) && value !== frozenOpener)
        .filter((value, index, list) => list.indexOf(value) === index);
      for (const frozenCloser of closerCandidates) {
        const closerProfile = await db
          .from("user_profiles")
          .select("auth_user_id,team_role,is_owner")
          .eq("tenant_id",session.tenantId)
          .eq("auth_user_id",frozenCloser)
          .maybeSingle();
        if (
          closerProfile.data &&
          mayCreditAdminVerifiedCloser({
            candidateUserId:frozenCloser,
            frozenOpenerUserId:frozenOpener,
            auditHostUserId,
            assignedTo:assignedUserId,
            recordedAuditHostRole,
            liveTeamRole:closerProfile.data.team_role,
            isOwner:closerProfile.data.is_owner,
          })
        ) {
          trustedCloserUserId = frozenCloser;
          break;
        }
      }
    }
    const closeParties = resolveWebsiteSalesCloseParties({
      assignedTo: current.assigned_to,
      attributedRepUserId: current.attributed_rep_user_id,
      actorUserId: session.userId,
      isTrueAdmin: session.isTrueAdmin,
      trustedCloserUserId,
    });
    if (!closeParties || !UUID.test(closeParties.closerUserId) || (closeParties.openerUserId !== null && !UUID.test(closeParties.openerUserId))) {
      return NextResponse.json({ok:false,error:"missing_close_attribution"},{status:409});
    }
    const builderUserId = typeof body.builderUserId === "string" ? body.builderUserId.trim() : "";
    const packageId = current.recommended_tier as WebsitePackageId;
    const automationIds = Array.isArray(current.automation_interests)
      ? current.automation_interests.filter((value): value is string => typeof value === "string")
      : [];
    const setupAmount = Number(current.quoted_setup_amount);
    const paymentDueAmount = Number(current.payment_due_amount);
    const monthlyAmount = Number(current.quoted_monthly_amount);
    const currency = current.currency === "USD" ? "USD" : "CAD";
    const paymentToken = typeof current.proposal_payment_token === "string" ? current.proposal_payment_token.trim() : "";
    const paymentPlanId = typeof current.payment_plan_id === "string" ? current.payment_plan_id.trim() : "";
    const alreadyCollected = Number(current.collected_setup_amount || 0);
    if (
      !WEBSITE_PACKAGES[packageId] ||
      !automationIds.every(isSellableAutomation) ||
      !Number.isFinite(setupAmount) ||
      !Number.isFinite(monthlyAmount) ||
      setupAmount < 0 ||
      monthlyAmount < 0 ||
      !isPositiveCentAmount(paymentDueAmount) ||
      paymentDueAmount > setupAmount - alreadyCollected ||
      !UUID.test(paymentToken) ||
      !UUID.test(paymentPlanId)
    ) {
      return NextResponse.json({ok:false,error:"stored_proposal_incomplete"},{status:409});
    }
    const closeQuote = validateQuote(packageId,setupAmount,monthlyAmount,session.isTrueAdmin);
    if (!closeQuote.ok) return NextResponse.json({ok:false,error:closeQuote.error},{status:400});
    if (!websiteBuildBriefIsReady(current.build_brief)) {
      return NextResponse.json({ok:false,error:"builder_handoff_not_ready"},{status:409});
    }
    const paymentProvider: WebsitePaymentProvider = body.paymentProvider === "manual" ? "manual" : "stripe";
    const suppliedReference = typeof body.paymentReference === "string" ? body.paymentReference.trim() : "";
    const proposalCheckout = storedCheckout(current);
    if (paymentProvider === "stripe" && !proposalCheckout) {
      return NextResponse.json({ok:false,error:"proposal_checkout_required"},{status:409});
    }
    if (paymentProvider === "stripe" && suppliedReference && suppliedReference !== proposalCheckout?.reference) {
      return NextResponse.json({ok:false,error:"payment_reference_not_proposal_checkout"},{status:409});
    }
    if (paymentProvider === "manual" && (!suppliedReference || suppliedReference.length > 240)) {
      return NextResponse.json({ok:false,error:"invalid_payment_reference"},{status:400});
    }
    const paymentReference = paymentProvider === "stripe" ? proposalCheckout!.reference : suppliedReference;
    let verifiedPayment: VerifiedWebsitePayment;
    try {
      if (paymentProvider === "stripe") {
        const secretKey = await getTenantIntegrationValue(session.tenantId, "stripe", "secret_key");
        if (!secretKey) throw new Error("stripe_not_connected");
        verifiedPayment = await verifyStripeWebsitePayment({
          secretKey,
          reference:paymentReference,
          expectedAmountCents:Math.round(paymentDueAmount * 100),
          expectedCurrency:currency,
          expectedTenantId:session.tenantId,
          expectedLeadId:leadId,
          expectedPaymentToken:paymentToken,
          expectedPaymentPlanId:paymentPlanId,
        });
      } else {
        if (!session.isTrueAdmin) throw new Error("manual_payment_founder_only");
        verifiedPayment = verifyManualWebsitePayment({
          reference:paymentReference,
          amountCents:Math.round(Number(body.paymentAmount) * 100),
          currency:body.paymentCurrency === "USD" ? "USD" : "CAD",
          expectedAmountCents:Math.round(paymentDueAmount * 100),
          expectedCurrency:currency,
          confirmed:body.manualPaymentConfirmed === true,
        });
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "payment_verification_failed";
      const status = code === "stripe_not_connected" || code === "stripe_verification_failed" ? 503 : 409;
      return NextResponse.json({ok:false,error:code},{status});
    }

    const existingReceipt = await db
      .from("website_sales_payment_receipts")
      .select("id,lead_id,status,amount_cents,currency,payment_plan_id,payment_token,installment_kind")
      .eq("tenant_id",session.tenantId)
      .eq("provider",verifiedPayment.provider)
      .eq("provider_reference",verifiedPayment.reference)
      .maybeSingle();
    if (existingReceipt.error) {
      return NextResponse.json({ok:false,error:"payment_receipt_lookup_failed",detail:existingReceipt.error.message},{status:500});
    }
    let verifiedPaymentId: string;
    if (existingReceipt.data) {
      const receipt = existingReceipt.data as Record<string,unknown>;
      if (
        receipt.lead_id !== leadId ||
        receipt.status !== "verified" ||
        Number(receipt.amount_cents) !== verifiedPayment.amountCents ||
        receipt.currency !== verifiedPayment.currency ||
        receipt.payment_plan_id !== paymentPlanId ||
        receipt.payment_token !== paymentToken
      ) {
        return NextResponse.json({ok:false,error:"payment_reference_already_used"},{status:409});
      }
      verifiedPaymentId = String(receipt.id);
    } else {
      verifiedPaymentId = crypto.randomUUID();
      const insertedReceipt = await db.from("website_sales_payment_receipts").insert({
        id:verifiedPaymentId,
        tenant_id:session.tenantId,
        lead_id:leadId,
        provider:verifiedPayment.provider,
        provider_reference:verifiedPayment.reference,
        status:"verified",
        amount_cents:verifiedPayment.amountCents,
        currency:verifiedPayment.currency,
        provider_status:verifiedPayment.providerStatus,
        verification_source:verifiedPayment.verificationSource,
        verified_by:session.userId,
        verified_at:occurredAt,
        payment_plan_id:paymentPlanId,
        payment_token:paymentToken,
        installment_kind:alreadyCollected > 0
          ? "balance"
          : verifiedPayment.amountCents === Math.round(setupAmount * 100)
            ? "full"
            : "deposit",
        summary:verifiedPayment.summary,
        created_at:occurredAt,
        updated_at:occurredAt,
      });
      if (insertedReceipt.error) {
        if (isUniqueViolationError(insertedReceipt.error)) {
          const racedReceipt = await db
            .from("website_sales_payment_receipts")
            .select("id,lead_id,status,amount_cents,currency,payment_plan_id,payment_token")
            .eq("tenant_id",session.tenantId)
            .eq("provider",verifiedPayment.provider)
            .eq("provider_reference",verifiedPayment.reference)
            .maybeSingle();
          const raced = racedReceipt.data as Record<string,unknown> | null;
          if (
            !racedReceipt.error &&
            raced &&
            raced.lead_id === leadId &&
            raced.status === "verified" &&
            Number(raced.amount_cents) === verifiedPayment.amountCents &&
            raced.currency === verifiedPayment.currency &&
            raced.payment_plan_id === paymentPlanId &&
            raced.payment_token === paymentToken
          ) {
            verifiedPaymentId = String(raced.id);
          } else {
            return NextResponse.json({ok:false,error:"payment_reference_already_used"},{status:409});
          }
        } else {
        return NextResponse.json(
          {
            ok:false,
            error:"payment_receipt_insert_failed",
            detail:insertedReceipt.error.message,
          },
          {status:500},
        );
        }
      }
    }
    const planReceipts = await db
      .from("website_sales_payment_receipts")
      .select("id,amount_cents,currency,status")
      .eq("tenant_id",session.tenantId)
      .eq("lead_id",leadId)
      .eq("payment_plan_id",paymentPlanId)
      .eq("status","verified");
    if (planReceipts.error) {
      return NextResponse.json({ok:false,error:"payment_plan_lookup_failed",detail:planReceipts.error.message},{status:500});
    }
    const activeReceipts = (planReceipts.data || []) as Array<Record<string,unknown>>;
    if (activeReceipts.some((receipt) => receipt.currency !== currency)) {
      return NextResponse.json({ok:false,error:"payment_plan_currency_mismatch"},{status:409});
    }
    const collectedCents = activeReceipts.reduce(
      (total, receipt) => total + Number(receipt.amount_cents || 0),
      0,
    );
    const setupCents = Math.round(setupAmount * 100);
    if (!Number.isSafeInteger(collectedCents) || collectedCents > setupCents) {
      return NextResponse.json({
        ok:false,
        error:"payment_plan_overpaid_manual_review",
        collectedAmount:collectedCents / 100,
        quotedSetupAmount:setupAmount,
      },{status:409});
    }
    if (collectedCents < setupCents) {
      const balanceCents = setupCents - collectedCents;
      const depositPatch = {
        stage:currentStage,
        payment_plan_status:"deposit_collected",
        collected_setup_amount:collectedCents / 100,
        setup_balance_due:balanceCents / 100,
        payment_due_amount:balanceCents / 100,
        payment_verified_by:session.userId,
        payment_verified_at:occurredAt,
        latest_verified_payment_id:verifiedPaymentId,
        proposal_payment_token:crypto.randomUUID(),
        payment_installment_number:Number(current.payment_installment_number || 1) + 1,
        stripe_checkout_session_id:null,
        stripe_checkout_url:null,
        stripe_checkout_created_at:null,
      };
      const depositContent = [
        `${currency} ${verifiedPayment.amountCents / 100} setup deposit verified.`,
        `${currency} ${balanceCents / 100} remains before the sale can close and fulfillment can open.`,
        transitionNote ? `Note: ${transitionNote}` : "",
      ].filter(Boolean).join(" ");
      const depositTransition = await db.rpc("transition_pipeline_lead", {
        p_tenant_id:session.tenantId,
        p_lead_id:leadId,
        p_expected_stage:currentStage,
        p_expected_owner_id:typeof current.assigned_to === "string" ? current.assigned_to : null,
        p_patch:depositPatch,
        p_request_id:requestId,
        p_occurred_at:occurredAt,
        p_actor_user_id:session.userId,
        p_action:"record_payment",
        p_interaction_type:"payment_received",
        p_subject:"Setup deposit verified",
        p_content:depositContent,
        p_is_call:false,
        p_metadata:{
          payment_plan_id:paymentPlanId,
          verified_payment_id:verifiedPaymentId,
          provider_reference:verifiedPayment.reference,
          installment_kind:"deposit",
          installment_amount_cents:verifiedPayment.amountCents,
          collected_setup_amount_cents:collectedCents,
          setup_balance_due_cents:balanceCents,
        },
      });
      if (depositTransition.error) {
        return NextResponse.json({
          ok:false,
          error:"deposit_state_update_failed",
          detail:depositTransition.error.message,
          receiptRecorded:true,
          correlationId:requestId,
        },{status:500});
      }
      const depositResult = depositTransition.data as Record<string,unknown>|null;
      if (depositResult?.ok === false) {
        return NextResponse.json({
          ok:false,
          error:depositResult.error === "owner_conflict" ? "owner_changed_refresh" : "stage_changed_refresh",
          currentStage:depositResult.current_stage,
          receiptRecorded:true,
          correlationId:requestId,
        },{status:409});
      }
      return NextResponse.json({
        ok:true,
        installmentRecorded:true,
        dealClosed:false,
        fulfillmentOpened:false,
        commissionAccrued:false,
        collectedAmount:collectedCents / 100,
        balanceDue:balanceCents / 100,
        touchAt:occurredAt,
      });
    }
    if (!UUID.test(builderUserId)) return NextResponse.json({ok:false,error:"builder_required_for_full_payment"},{status:400});
    const builder = await db
      .from("user_profiles")
      .select("auth_user_id,team_role")
      .eq("tenant_id",session.tenantId)
      .eq("auth_user_id",builderUserId)
      .eq("team_role","builder")
      .maybeSingle();
    if (!builder.data) return NextResponse.json({ok:false,error:"builder_not_authorized"},{status:400});
    // Comp v3 resolves the closer separately from the frozen opener so a
    // two-person handoff keeps both ledger parties. The RPC re-verifies role,
    // assignment, attribution, and founder authority; this flag grants nothing
    // by itself.
    const { closerUserId, openerUserId, closedByRep } = closeParties;
    // website_deals.founder_user_id: the founder who closed; on a rep-close,
    // the founder from the booked meeting when one exists, else the rep
    // themselves (self-run deal with no founder in the loop).
    const bookedFounder = typeof current.booked_founder === "string" && UUID.test(current.booked_founder) ? current.booked_founder : null;
    const founderUserId = closedByRep ? (bookedFounder ?? session.userId) : session.userId;
    const finalStage = "onboarding";
    const collaborators = [
      openerUserId,
      closerUserId,
      session.userId,
      ...normalizeCollaborators(current),
    ].filter((userId): userId is string => typeof userId === "string" && UUID.test(userId) && userId !== builderUserId)
      .filter((userId, index, list) => list.indexOf(userId) === index)
      .slice(0, 5);
    const closeContent = [
      `Payment verified and fulfillment opened: ${WEBSITE_PACKAGES[packageId].name}.`,
      `${currency} ${setupAmount} collected across ${activeReceipts.length} verified receipt(s) against the quoted setup + ${monthlyAmount}/month.`,
      `Assigned builder: ${builderUserId}.`,
      transitionNote ? `Note: ${transitionNote}` : "",
    ].filter(Boolean).join(" ");
    const closedByUserId = closedByRep ? closerUserId : founderUserId;
    const closeLeadPatch = {
      stage:finalStage,
      stage_entered_at:occurredAt,
      closed_by:closedByUserId,
      closed_by_user_id:closedByUserId,
      payment_verified_by:session.userId,
      payment_verified_at:occurredAt,
      collected_setup_amount:setupAmount,
      setup_balance_due:0,
      payment_due_amount:0,
      payment_plan_id:paymentPlanId,
      payment_plan_status:"paid_in_full",
      quoted_setup_amount:setupAmount,
      quoted_monthly_amount:monthlyAmount,
      payment_provider:verifiedPayment.provider,
      verified_payment_id:verifiedPaymentId,
      assigned_to:builderUserId,
      fulfillment_owner_id:builderUserId,
      build_handoff_status:"assigned_to_builder",
      collaborators,
      ...(transitionNote ? { last_handoff_note:transitionNote, last_handoff_note_at:occurredAt } : {}),
      ...(isOasisSalesTenant && current.sales_program !== OASIS_WEBSITE_SALES_PROGRAM
        ? { sales_program:OASIS_WEBSITE_SALES_PROGRAM }
        : {}),
    };
    const closeMetadata = {
      payment_verifier_user_id:session.userId,
      closed_by_user_id:closedByUserId,
      opener_user_id:openerUserId,
      closer_user_id:closedByRep ? closerUserId : null,
      builder_user_id:builderUserId,
      closed_outcome:"won",
      package_id:packageId,
      quoted_setup_amount:setupAmount,
      collected_setup_amount:setupAmount,
      payment_plan_id:paymentPlanId,
      receipt_count:activeReceipts.length,
      monthly_amount:monthlyAmount,
      currency,
      payment_provider:verifiedPayment.provider,
      verified_payment_id:verifiedPaymentId,
    };
    const result = await db.rpc("close_website_deal", {
      p_tenant_id:session.tenantId,
      p_lead_id:leadId,
      p_rep_user_id:closerUserId,
      p_opener_user_id:openerUserId,
      p_founder_user_id:founderUserId,
      p_package_id:packageId,
      p_automation_ids:automationIds,
      p_currency:currency,
      p_setup_amount:setupAmount,
      p_collected_amount:setupAmount,
      p_monthly_amount:monthlyAmount,
      p_payment_reference:`payment-plan:${paymentPlanId}`,
      p_payment_provider:verifiedPayment.provider,
      p_verified_payment_id:verifiedPaymentId,
      p_payment_plan_id:paymentPlanId,
      p_closed_by_rep:closedByRep,
      p_builder_user_id:builderUserId,
      p_expected_stage:currentStage,
      p_expected_owner_id:typeof current.assigned_to === "string" ? current.assigned_to : null,
      p_request_id:requestId,
      p_occurred_at:occurredAt,
      p_actor_user_id:session.userId,
      p_interaction_subject:"Payment verified and builder assigned",
      p_interaction_content:closeContent,
      p_interaction_metadata:closeMetadata,
      p_lead_patch:closeLeadPatch,
    });
    if (result.error) return NextResponse.json({ok:false,error:result.error.message},{status:500});
    const closeResult = result.data as Record<string,unknown>|null;
    if (closeResult?.ok === false) {
      return NextResponse.json({
        ok:false,
        error:closeResult.error === "owner_conflict" ? "owner_changed_refresh" : "stage_changed_refresh",
        currentStage:closeResult.current_stage,
        dealClosed:false,
      },{status:409});
    }
    await runStageTransitionHooks({
      db,
      tenantId:session.tenantId,
      entity:"lead",
      recordId:leadId,
      data:{...current,...closeLeadPatch,stage:finalStage},
      transitions:[{field:"stage",from:currentStage,to:finalStage}],
    });
    return NextResponse.json({ok:true,result:result.data,touchAt:occurredAt,builderUserId});
  } else return NextResponse.json({ok:false,error:"unknown_action"},{status:400});

  // A lifecycle move is a touch by product definition. Persist the canonical
  // timestamp in the same Turso record patch and normalize legacy OASIS rows
  // onto the program marker once they are actively worked.
  if (trackedAction) patch.last_contacted_at = occurredAt;
  // A CALL note is a per-touch fact and belongs in the interaction ledger — it
  // is appended to contentParts below and shows in "Activity and files".
  // last_handoff_note is the FOUNDER handoff note: single-valued, rendered under
  // the label "Founder handoff note", and used to pre-fill the handoff composer
  // (page.tsx initialHandoffNote). Letting a disposition write it means a rep's
  // "call back after the 15th" silently becomes the note the founder reads
  // before the audit, overwriting whatever was there.
  if (transitionNote && body.action !== "disposition") {
    patch.last_handoff_note = transitionNote;
    patch.last_handoff_note_at = occurredAt;
  }
  if (isOasisSalesTenant && current.sales_program !== OASIS_WEBSITE_SALES_PROGRAM) {
    patch.sales_program = OASIS_WEBSITE_SALES_PROGRAM;
  }
  const nextStage = typeof patch.stage === "string" ? patch.stage : null;
  const priorStage = currentStage;
  if (!trackedAction || !requestId || !nextStage) {
    return NextResponse.json({ok:false,error:"invalid_lifecycle_transition"},{status:400});
  }
  const action = String(body.action);
  const contentParts = [
    nextStage !== priorStage
      ? `Stage changed ${priorStage || "untracked"} -> ${nextStage}.`
      : `Lifecycle action: ${action.replaceAll("_", " ")}.`,
    body.action === "disposition" ? `Call result: ${String(body.disposition || "unknown")}.` : "",
    body.action === "book_founder"
      ? `${priorStage === "qualified" ? "" : "Qualification completed during handoff. "}Google Calendar verified the 15-minute audit, sent the client invitation, and returned a unique Meet link for ${String(body.meetingAt || "")}. Promised demo: ${String(body.promisedDemo || "")}.`
      : "",
    body.action === "complete_audit" ? "Founder/closer audit completed and builder brief captured." : "",
    body.action === "proposal" ? `Proposal frozen with ${String(patch.currency)} ${String(patch.payment_due_amount)} due now.` : "",
    body.action === "create_payment_link" ? "Lead-bound live Stripe Checkout link created or reused." : "",
    body.action === "deal_outcome" ? `Deal outcome: ${String(body.outcome || "unknown")}.` : "",
    transitionNote ? `Note: ${transitionNote}` : "",
  ].filter(Boolean);
  const onboardingStatus =
    priorStage === "onboarding" && nextStage === "in_build" ? "in_build" :
    priorStage === "in_build" && nextStage === "client_review" ? "client_review" :
    priorStage === "client_review" && nextStage === "launched" ? "launched" :
    null;
  const transition = await db.rpc("transition_pipeline_lead", {
    p_tenant_id:session.tenantId,
    p_lead_id:leadId,
    p_expected_stage:priorStage,
    p_expected_owner_id:typeof current.assigned_to === "string" ? current.assigned_to : null,
    p_patch:patch,
    p_request_id:requestId,
    p_occurred_at:occurredAt,
    p_actor_user_id:session.userId,
    p_action:action,
    p_interaction_type:lifecycleInteractionType(action),
    p_subject:action.replaceAll("_", " "),
    p_content:contentParts.join(" "),
    p_is_call:body.action === "disposition",
    p_metadata:{
      next_action_at:patch.next_action_at || null,
      founder_meeting_at:patch.founder_meeting_at || null,
      audit_host_user_id:patch.audit_host_user_id || null,
      audit_host_email:patch.audit_host_email || null,
      build_handoff_status:patch.build_handoff_status || null,
      calendar_event_status:patch.calendar_event_status || null,
      calendar_confirmation_method:patch.calendar_confirmation_method || null,
      calendar_appointment_id:patch.calendar_appointment_id || null,
      google_calendar_event_id:patch.google_calendar_event_id || null,
      google_meet_link:patch.google_meet_link || null,
      qualification_source:patch.qualification_source || null,
      deal_outcome:patch.deal_outcome || null,
      booking_confirmations:body.action === "book_founder" ? body.confirmations || null : null,
      booking_request_id:body.action === "book_founder" ? requestId : null,
      outcome_request_id:body.action === "deal_outcome" ? requestId : null,
      payment_due_amount:patch.payment_due_amount || null,
      checkout_reference:patch.stripe_checkout_session_id || null,
    },
    ...(onboardingStatus ? { p_onboarding_status:onboardingStatus } : {}),
    ...(onboardingStatus && typeof current.assigned_to === "string"
      ? { p_fulfillment_owner_id:current.assigned_to }
      : {}),
  });
  if (transition.error) {
    return NextResponse.json({
      ok:false,
      error:"lifecycle_transition_failed",
      detail:transition.error.message,
      correlationId:requestId,
    },{status:500});
  }
  const transitionResult = transition.data as Record<string,unknown>|null;
  if (transitionResult?.ok === false) {
    return NextResponse.json({
      ok:false,
      error:transitionResult.error === "owner_conflict" ? "owner_changed_refresh" : "stage_changed_refresh",
      currentStage:transitionResult.current_stage,
      correlationId:requestId,
    },{status:409});
  }
  if (verifiedMeeting) {
    try {
      await activateVerifiedFounderMeeting(session.tenantId, verifiedMeeting.appointmentId);
    } catch (error) {
      return NextResponse.json({
        ok:false,
        error:"meeting_activation_failed",
        detail:error instanceof Error ? error.message : "meeting_activation_failed",
        correlationId:requestId,
        stageUpdated:true,
      },{status:503});
    }
  }
  if (smsConsentAfterTransition) {
    try {
      await grantFounderMeetingSmsConsent({
        tenantId:session.tenantId,
        leadId,
        appointmentId:smsConsentAfterTransition.appointmentId,
        consentedPhone:current.phone,
        capturedAt:smsConsentAfterTransition.capturedAt,
      });
    } catch (error) {
      return NextResponse.json({
        ok:false,
        error:"meeting_sms_consent_update_failed",
        detail:error instanceof Error ? error.message : "meeting_sms_consent_update_failed",
        correlationId:requestId,
        stageUpdated:true,
      },{status:503});
    }
  }
  if (cancellationAfterTransition) {
    try {
      const cancellation = await cancelVerifiedFounderMeeting({
        tenantId:session.tenantId,
        leadId,
        appointmentId:cancellationAfterTransition.appointmentId,
        requestId:cancellationAfterTransition.requestId,
      });
      cancellationDisposition = cancellation.disposition;
    } catch (error) {
      return NextResponse.json({
        ok:false,
        error:"calendar_cancel_failed",
        detail:error instanceof Error ? error.message : "calendar_cancel_failed",
        correlationId:requestId,
        stageUpdated:true,
      },{status:503});
    }
  }
  // This route patches the record directly instead of going through
  // updateRecord(), so nothing here fires the portal stage hooks on its own.
  // That silence is why the qualified -> booking-link email never sent from a
  // rep's own Qualify button — the one path that matters most. Run the hooks
  // explicitly for a real stage change. runStageTransitionHooks swallows every
  // hook error internally, so a reaction can still never fail the write.
  if (nextStage && nextStage !== priorStage) {
    await runStageTransitionHooks({
      db,
      tenantId: session.tenantId,
      entity: "lead",
      recordId: leadId,
      data: { ...current, ...patch },
      transitions: [{ field: "stage", from: priorStage, to: nextStage }],
    });
  }
  const checkout = body.action === "create_payment_link"
    ? storedCheckout({ ...current, ...patch })
    : null;
  return NextResponse.json({
    ok:true,
    data:transitionResult?.data ?? { ...current, ...patch },
    touchAt:occurredAt,
    idempotent:transitionResult?.idempotent === true,
    ...(verifiedMeeting ? {
      meeting:{
        appointmentId:verifiedMeeting.appointmentId,
        meetingAt:verifiedMeeting.meetingAt,
        timezone:verifiedMeeting.timezone,
        eventId:verifiedMeeting.receipt.eventId,
        calendarUrl:verifiedMeeting.receipt.htmlLink,
        meetLink:verifiedMeeting.receipt.meetLink,
      },
    } : {}),
    ...(cancellationDisposition ? { cancellationDisposition } : {}),
    ...(cancellationDisposition === "pending" ? {
      warning:"The lead was updated. Calendar cancellation is safely reserved and the background worker is finishing it.",
    } : {}),
    ...(checkout ? { checkoutReference:checkout.reference, checkoutUrl:checkout.url } : {}),
  });
}
