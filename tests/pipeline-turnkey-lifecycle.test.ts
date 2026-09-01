import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const lifecycle = readFileSync("app/pipeline/[id]/LeadLifecycleActions.tsx", "utf8");
const detail = readFileSync("app/pipeline/[id]/page.tsx", "utf8");
const workflowRoute = readFileSync("app/api/website-sales/[leadId]/route.ts", "utf8");
const setStageRoute = readFileSync("app/api/leads/[id]/set-stage/route.ts", "utf8");
const notesRoute = readFileSync("app/api/leads/[id]/notes/route.ts", "utf8");
const pipeline = readFileSync("components/manifest/LeadPipelineView.tsx", "utf8");
const pipelinePage = readFileSync("app/pipeline/page.tsx", "utf8");
const pipelineQuery = readFileSync("lib/oasis-pipeline-query.ts", "utf8");
const claimOps = readFileSync("lib/web-leads/claim-ops.ts", "utf8");
const assignRoute = readFileSync("app/api/leads/[id]/assign/route.ts", "utf8");
const assignmentCore = readFileSync("lib/lifecycle-assignment.ts", "utf8");
const kixieWebhook = readFileSync("app/api/webhooks/kixie/route.ts", "utf8");
const webLeadOutcome = readFileSync("lib/web-leads/outcome.ts", "utf8");
const emailRoute = readFileSync("app/api/leads/[id]/email/route.ts", "utf8");
const textRoute = readFileSync("app/api/leads/[id]/texttorrent/route.ts", "utf8");
const textInbound = readFileSync("app/api/webhooks/texttorrent/sms-inbound/route.ts", "utf8");
const twilioInbound = readFileSync("app/api/webhooks/twilio/sms-inbound/route.ts", "utf8");
const bulkRoute = readFileSync("app/api/leads/bulk/route.ts", "utf8");
const policy = readFileSync("lib/oasis-sales-pipeline-policy.ts", "utf8");
const rpcShim = readFileSync("lib/turso-rpc-shim.ts", "utf8");
const callRoute = readFileSync("app/api/leads/[id]/call/route.ts", "utf8");
const conversationReply = readFileSync("app/api/conversations/reply/route.ts", "utf8");
const kixieAutomations = readFileSync("lib/integrations/kixie-automations.ts", "utf8");
const canonicalTouch = readFileSync("lib/leads/canonical-touch.ts", "utf8");
const manifestRecords = readFileSync("app/api/manifest/[slug]/records/[entity]/route.ts", "utf8");
const actionToolbar = readFileSync("components/leads/LeadActionToolbar.tsx", "utf8");
const buildBriefForm = readFileSync("components/leads/LeadBuildBriefForm.tsx", "utf8");
const paymentCore = readFileSync("lib/website-sales-payment.ts", "utf8");
const stageHooks = readFileSync("lib/portals/stage-hooks.ts", "utf8");
const paymentMigration = readFileSync("database/turso/160_website_sales_payment_receipts.turso.sql", "utf8");
const installmentMigration = readFileSync("database/turso/164_website_sales_installment_ledger.turso.sql", "utf8");
const teamMembersRoute = readFileSync("app/api/team/members/route.ts", "utf8");
const stageEventRoute = readFileSync("app/api/leads/[id]/stage-event/route.ts", "utf8");
const setFieldRoute = readFileSync("app/api/leads/[id]/set-field/route.ts", "utf8");
const cloudToolRunner = readFileSync("lib/cloud-tool-runner.ts", "utf8");
const agentActions = readFileSync("lib/agent-actions.ts", "utf8");
const playbookDeals = readFileSync("app/playbook/deals/page.tsx", "utf8");
const formSubmit = readFileSync("app/api/forms/submit/route.ts", "utf8");

// Every operator who can open a writable lead gets a visible forward path.
// The production bug hid the entire workflow whenever canManage=true, leaving
// founders/admins with an instruction sentence and no controls at all.
assert.equal(
  lifecycle.includes("{!canManage &&"),
  false,
  "admin capability must add controls, never hide the lifecycle workflow",
);
assert(
  lifecycle.includes("Start outreach") && lifecycle.includes("attempting_contact"),
  "Assigned must expose a one-click move into Attempting Contact",
);
assert(
  lifecycle.includes("transitionNote") && lifecycle.includes("lossReason"),
  "stage handoffs preserve operator context and losses require a real reason",
);

// The detail page is an operating file, not a scorecard. Website, scheduled
// actions, notes, and handoff context replace the two obsolete score/value
// cards, and the generic 22-field stack is replaced by a lead-specific editor.
assert.equal(detail.includes("ScoreLeadButton"), false, "AI score controls are removed from the lead file");
assert.equal(detail.includes('label="AI score"'), false, "AI score card is removed");
assert.equal(detail.includes('label="Value + source"'), false, "value/source scorecard is removed");
assert(detail.includes("LeadContextEditor"), "lead detail uses the structured context editor");
assert(detail.includes("touchCount"), "lead detail exposes the durable touch count");
assert(
  detail.includes("safeExternalUrl") && lifecycle.includes("canRunDeal"),
  "lead websites are protocol-allowlisted and assigned closers get the full guided workflow",
);
assert(
  lifecycle.includes("Host & time") &&
    lifecycle.includes("Create Google Meet & send invite") &&
    actionToolbar.includes("Call now") &&
    actionToolbar.includes("/api/leads/${leadId}/call") &&
    !actionToolbar.includes("Send check-in") &&
    !actionToolbar.includes("Pause auto follow-ups") &&
    !actionToolbar.includes("AI tools"),
  "the single next-step surface keeps calling and guided booking without retired AI/email/drip controls",
);
assert(
  detail.includes('href="#lead-lifecycle-control"') && lifecycle.includes('id="lead-lifecycle-control"'),
  "clicking the Stage bubble opens the guarded lifecycle control instead of bypassing it",
);

// Website is a first-class pipeline column, not tiny tertiary text under the
// business name. Score is deliberately retired from the OASIS row model.
assert(pipeline.includes("<HeaderCell>Website</HeaderCell>"), "pipeline includes a Website column");
assert.equal(
  pipeline.includes("<HeaderCell>Score</HeaderCell>"),
  false,
  "OASIS pipeline no longer spends a column on the retired score",
);
assert(
  pipelinePage.includes("listOasisPipelineWindow({") &&
    pipelinePage.includes("stageKeys: assigneeScope.allowed ? stages.map") &&
    pipelinePage.includes("assignedToAny: assigneeScope.allowed ? teamAssigneeUnion") &&
    pipelineQuery.includes('whereIn: { assigned_to: teamAssignees }') &&
    pipelineQuery.includes("limit: 2_000") &&
    pipelineQuery.includes("oasis_pipeline_team_scope_exceeds_safe_window"),
  "team access is pushed into one bounded database query and fails closed before an incomplete roster book can render",
);
assert(
  pipeline.includes("created_at: null") && detail.includes("created_at: null"),
  "Created date may drive first-touch urgency but is never labeled as an actual Last Touch",
);

// A lifecycle transition is itself a touch. Both the structured OASIS route
// and the generic inline-stage route must persist the canonical timestamp and
// a ledger row with the acting user. No best-effort swallow is permitted.
for (const [name, source] of [
  ["website-sales lifecycle", workflowRoute],
  ["generic set-stage", setStageRoute],
] as const) {
  assert(source.includes("last_contacted_at"), `${name} persists the canonical last-touch timestamp`);
  assert(source.includes("actor_user_id"), `${name} attributes the touch to the operator`);
  assert(source.includes('from("lead_interactions")'), `${name} writes the unified interaction ledger`);
}
assert.equal(
  setStageRoute.includes("best-effort audit"),
  false,
  "stage tracking is required, not an optional best-effort side effect",
);
assert(
  workflowRoute.includes("OASIS_WEBSITE_SALES_PROGRAM") &&
    workflowRoute.includes("current.sales_motion !== OASIS_COLD_OUTBOUND_MOTION") &&
    workflowRoute.includes("not_cold_outbound_lead"),
  "the workflow is restricted to the canonical OASIS cold-outbound motion and cannot absorb warm form submissions",
);
assert(
  claimOps.includes("claimPatch") &&
    pipelinePage.includes("OASIS_COLD_OUTBOUND_MOTION") &&
    pipelinePage.includes("salesMotion") &&
    formSubmit.includes("OASIS_INBOUND_WARM_MOTION"),
  "cold claimed prospects and warm form submissions are separate sales motions on Turso",
);
assert(
  workflowRoute.includes("maySendWebsiteProposal") && workflowRoute.includes("mayCloseWebsiteDeal"),
  "proposal and close stages are enforced by the API, not only hidden in the UI",
);
assert(
  lifecycle.includes("expectedStage: currentStage") &&
    workflowRoute.includes('error:"expected_stage_required"') &&
    workflowRoute.includes('error:"stage_changed_refresh"'),
  "every lifecycle mutation is anchored to the rendered stage so a stale click cannot skip an edge",
);
assert(
  workflowRoute.includes("mayWorkWebsiteSalesLifecycle") &&
    workflowRoute.includes("forbidden_sales_role") &&
    workflowRoute.includes("builderOnOwnSalesLead") &&
    workflowRoute.includes("!builderOnOwnSalesLead && (!builderMayRunDelivery || !builderOwnsDelivery)") &&
    detail.includes("mayQuoteAndClose(session.teamRole)"),
  "only authorized sales roles can mutate lifecycle state; a builder on his OWN sales lead takes the rep path instead of the delivery lane, and the page's deal controls read the one DEAL_CLOSING_ROLES list",
);
assert(
  workflowRoute.includes("p_opener_user_id") &&
    workflowRoute.includes("resolveWebsiteSalesCloseParties") &&
    rpcShim.includes("opener_does_not_match_frozen_attribution"),
  "two-person closes preserve opener attribution while paying the assigned closer",
);
assert(
  lifecycle.includes("Create Google Meet & send invite") &&
    lifecycle.includes("founderMeetingIso") &&
    lifecycle.includes("founderBookingRequestId") &&
    lifecycle.includes("contactConfirmed") &&
    lifecycle.includes("clientAgreedToTime") &&
    lifecycle.includes("handoffComplete") &&
    !lifecycle.includes("calendarConfirmed") &&
    !lifecycle.includes("googleCalendarAuditUrl") &&
    lifecycle.includes('mayScheduleFounderAudit = currentStage === "qualified"') &&
    lifecycle.includes("bookingStep") &&
    lifecycle.includes("qualification: {") &&
    !lifecycle.includes("BOOKING_URL") &&
    workflowRoute.includes("mayAgentBookFounder(currentStage, qualificationIncluded)") &&
    workflowRoute.includes("createVerifiedFounderMeeting") &&
    workflowRoute.includes('error:"booking_confirmations_required"') &&
    workflowRoute.includes("expectedOrganizerEmail:auditHostEmail") &&
    workflowRoute.includes('error:"handoff_note_required"') &&
    workflowRoute.includes("audit_duration_minutes:15") &&
    workflowRoute.includes("calendar_event_status:\"verified\"") &&
    workflowRoute.includes('calendar_confirmation_method:"server_google_calendar_api"') &&
    workflowRoute.includes("google_calendar_event_id") &&
    workflowRoute.includes("google_meet_link") &&
    workflowRoute.includes("next_action_at:meetingAt") &&
    workflowRoute.includes("assigned_to:founderUserId"),
  "the pre-Founder handoff requires explicit qualification/context and transfers ownership only after a retry-safe provider-verified event and Meet receipt",
);
assert(
  workflowRoute.includes('.eq("agent_source","website_sales_pipeline")') &&
    workflowRoute.includes('.eq("metadata->>request_id",requestId)'),
  "lifecycle retries use the durable tenant-wide request marker instead of a lossy recent-row scan",
);
assert(
  teamMembersRoute.includes("email: m.email") &&
    teamMembersRoute.includes("calendar_connected") &&
    teamMembersRoute.includes("calendar_identity_mismatch") &&
    lifecycle.includes("selectedFounderCalendarReady"),
  "the host picker exposes Google Calendar readiness while keeping the host's email tenant-scoped",
);
assert(
  buildBriefForm.includes("Closing-call build brief") &&
    workflowRoute.includes('body.action === "complete_audit"') &&
    workflowRoute.includes("normalizeWebsiteBuildBrief") &&
    rpcShim.includes("buildBriefForOnboarding"),
  "the closing call produces a required structured brief that is copied into builder onboarding",
);
assert(
  workflowRoute.includes('body.action === "record_payment"') &&
    workflowRoute.includes('body.action === "create_payment_link"') &&
    workflowRoute.includes("createStripeWebsiteCheckout") &&
    workflowRoute.includes("verifyStripeWebsitePayment") &&
    workflowRoute.includes("expectedPaymentToken") &&
    workflowRoute.includes("payment_due_amount") &&
    workflowRoute.includes("payment_plan_id") &&
    workflowRoute.includes("payment_plan_status:\"deposit_collected\"") &&
    workflowRoute.includes("setup_balance_due") &&
    workflowRoute.includes("p_payment_plan_id:paymentPlanId") &&
    workflowRoute.includes("manual_payment_founder_only") &&
    paymentCore.includes("payment_does_not_match_proposal") &&
    paymentCore.includes("stripe_test_payment_not_accepted") &&
    paymentCore.includes("payment_not_bound_to_lead") &&
    paymentCore.includes("payment_refunded") &&
    paymentMigration.includes('CREATE TABLE IF NOT EXISTS "website_sales_payment_receipts"') &&
    installmentMigration.includes('ALTER TABLE "website_sales_payment_receipts" ADD COLUMN "payment_plan_id"') &&
    rpcShim.includes("verified_payment_required") &&
    rpcShim.includes("collected_amount_must_equal_quoted_setup") &&
    rpcShim.includes("SUM(amount_cents)"),
  "deposits and balances share one Turso payment plan; only the fully collected, live plan can open fulfillment and commission",
);
assert(
  lifecycle.includes("builderUserId") &&
    workflowRoute.includes("p_builder_user_id") &&
    rpcShim.includes("fulfillment_owner_id"),
  "payment cannot open fulfillment without assigning the builder who receives the complete handoff",
);
assert(
  workflowRoute.includes('body.action === "deal_outcome"') &&
    workflowRoute.includes('"no_show", "reschedule", "follow_up"') &&
    workflowRoute.includes('error:"loss_reason_required"') &&
    workflowRoute.includes('error:"next_action_must_be_in_future"'),
  "closers can record lost, no-show, reschedule, and follow-up outcomes without bypassing the lifecycle ledger",
);
assert(
  workflowRoute.includes("payment_verified_by:session.userId") &&
    workflowRoute.includes("closed_by_user_id:closedByUserId") &&
    workflowRoute.includes("trustedCloserUserId") &&
    workflowRoute.includes("current.audit_host_user_id") &&
    workflowRoute.includes("current.audit_host_role") &&
    workflowRoute.includes("mayCreditAdminVerifiedCloser"),
  "the operator verifying payment is recorded separately and cannot erase the frozen closer's commission credit",
);
assert(
  rpcShim.includes("transition_pipeline_lead") &&
    workflowRoute.includes('rpc("transition_pipeline_lead"') &&
    workflowRoute.includes('rpc("close_website_deal"') &&
    workflowRoute.includes("p_expected_stage:currentStage") &&
    workflowRoute.includes("p_expected_owner_id:typeof current.assigned_to") &&
    rpcShim.includes('const tx = await beginTursoWriteTransaction(client)') &&
    rpcShim.includes("'deal_closed'"),
  "stage, Last Touch, close timeline, deal, commission, and onboarding move through guarded Turso transactions",
);
assert.equal(
  stageHooks.includes('name: "qualified-booking-link"'),
  false,
  "qualification no longer sends a conflicting generic self-book email before the opener chooses an exact time",
);
assert(
  policy.includes("CLOSER_PIPELINE_STAGE_KEYS") && policy.includes("OPENER_PIPELINE_STAGE_KEYS"),
  "pipeline visibility follows opener and closer responsibilities instead of hiding post-demo deals",
);
assert(
  setStageRoute.includes("isWebsiteSalesTenantSlug") &&
    setStageRoute.includes("use_website_sales_workflow"),
  "the generic stage API cannot bypass the structured workflow for legacy OASIS rows",
);

// Sales-role accounts (opener / closer / manager / agent) can add the notes
// the founder needs; the generic canWriteCrm list does not cover all of them.
assert(
  notesRoute.includes("assertMayWorkLead"),
  "note writes use the same owned-lead access rule as the rest of the lead file",
);
assert(
  claimOps.includes('from("lead_interactions")') && claimOps.includes("actor_user_id"),
  "claiming a lead creates an attributed lifecycle touch",
);
assert(
  assignmentCore.includes("last_contacted_at") && assignRoute.includes("actor_user_id"),
  "assigning or transferring a lead updates Last Touch and attributes the event",
);
assert.equal(
  assignRoute.includes("best-effort audit"),
  false,
  "assignment tracking cannot be silently swallowed",
);
assert(
  kixieWebhook.includes("last_contacted_at") && kixieWebhook.includes("last_call_at"),
  "real Kixie contact updates the same canonical Last Touch fields on Turso",
);
assert(
  webLeadOutcome.includes("persistCanonicalLeadTouch") && webLeadOutcome.includes('from("lead_interactions")'),
  "the Leads-page call outcome updates Pipeline Last Touch and the unified touch ledger",
);
for (const [name, source] of [
  ["dashboard email", emailRoute],
  ["dashboard TextTorrent", textRoute],
  ["inbound TextTorrent", textInbound],
  ["inbound Twilio", twilioInbound],
] as const) {
  assert(source.includes("persistCanonicalLeadTouch"), `${name} updates canonical Last Touch on Turso`);
}
for (const [name, source] of [
  ["dashboard call", callRoute],
  ["conversation reply", conversationReply],
  ["auto-created Kixie caller", kixieAutomations],
] as const) {
  assert(source.includes("persistCanonicalLeadTouch"), `${name} updates canonical Last Touch on Turso`);
}
assert(
  callRoute.indexOf("if (dryRun)") < callRoute.indexOf('.from("lead_interactions")'),
  "a dry-run call returns before the interaction ledger and cannot inflate touch metrics",
);
assert(
  bulkRoute.includes("use_individual_sales_workflow"),
  "bulk stage changes cannot bypass per-lead OASIS qualification, handoff, proposal, or close facts",
);
assert(
  pipeline.includes('variant === "oasis"') && pipeline.includes("? undefined"),
  "the OASIS board does not offer a bulk stage control that its closed-loop API must reject",
);
assert(
  canonicalTouch.includes('rpc("record_lead_touch"') &&
    !canonicalTouch.includes('.from("tenant_records")'),
  "provider touch timestamps use the atomic database max instead of a racy read-then-patch",
);
assert(
  manifestRecords.includes("rejectedOasisGenericPatchKeys") &&
    manifestRecords.includes("use_website_sales_workflow"),
  "the generic manifest editor cannot bypass the audited OASIS lifecycle, even for admins",
);
assert(
  setFieldRoute.includes("rejectedOasisGenericPatchKeys") && setFieldRoute.includes("ownsOasisSalesRecord"),
  "the generic scalar-field endpoint cannot rewrite price, attribution, payment, or another rep's OASIS lead",
);
assert.equal(
  stageEventRoute.includes("dispatchOasisOnlyEvent"),
  false,
  "the legacy stage-event endpoint cannot bypass the guided OASIS workflow",
);
assert.equal(
  cloudToolRunner.includes('name: "advance_lead_stage"'),
  false,
  "the cloud agent cannot bypass qualification, booking, payment, or builder gates",
);
assert(
  agentActions.includes("use_website_sales_workflow") && agentActions.includes("rejectedOasisGenericPatchKeys"),
  "generic chat record mutations fail closed on OASIS lifecycle fields",
);
assert(
  assignRoute.includes("assertMayWorkLead") && bulkRoute.includes("use_individual_sales_workflow"),
  "one rep cannot take another rep's OASIS lead or bulk-reassign post-handoff work",
);
assert.equal(playbookDeals.includes("emails the lead the booking link automatically"), false);
assert(
  playbookDeals.includes("amount due now") && playbookDeals.includes("assigned builder"),
  "the rep playbook matches the Calendar, collected-payment, and builder handoff implemented in code",
);

console.log("pipeline-turnkey-lifecycle: OK");
