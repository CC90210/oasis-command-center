/**
 * lib/oasis-lead-stage-engine.ts — automatic lead.stage transitions for
 * the OASIS tenant.
 *
 * Mirrors lib/lead-stage-engine.ts in shape but encodes the 14-stage
 * Website Sales Engine lifecycle from lib/oasis-stage-meta.ts instead
 * of SunBiz's funding funnel. Same Event union, same Result type, same
 * idempotency + manual-override-wins semantics:
 *
 *   - Each rule has a narrow `from` set. Once an operator manually moves
 *     a lead past that point, automatic events can't yank it backwards.
 *   - Best-effort emission: errors caught + logged; never break the
 *     primary write path that triggered the event.
 *   - The canonical BRAVO_RECORD_STATUS_CHANGED event is emitted by
 *     updateRecord; this engine layers a BRAVO_LEAD_AUTO_BUMPED event
 *     carrying the `reason` + `via` so the timeline can render WHY a
 *     stage moved (not just THAT it did).
 *
 * Rule coverage (Website Sales Engine v2, 14-stage vocabulary):
 *
 *   Event                       From                            → To                     Reason
 *   outbound_email_queued       researched/assigned             → attempting_contact     first_outreach_sent
 *   outbound_email_sent         researched/assigned             → attempting_contact     first_outreach_sent
 *   discovery_call_scheduled    attempting_contact/connected/
 *                               qualified                       → founder_meeting_booked discovery_call_scheduled
 *   lead_qualified              attempting_contact/connected    → qualified              qualified_explicit
 *   proposal_sent               founder_meeting_booked/
 *                               demo_completed                  → proposal_sent          proposal_sent
 *   proposal_viewed             founder_meeting_booked/
 *                               demo_completed                  → proposal_sent          proposal_viewed
 *   contract_signed             demo_completed/proposal_sent    → won                    contract_signed
 *   onboarding_complete         onboarding                      → in_build               onboarding_complete
 *   lead_replied_negative       any pre-won sales stage         → lost                   lead_replied_negative
 *   contract_ended              launched                        → lost                   contract_ended
 *   manual_outreach_started     researched/assigned             → attempting_contact     operator_marked_outreach_started
 *   manual_archive              any non-lost stage              → lost                   operator_archived_lead
 *
 * The 14-stage vocabulary has no `negotiation`, `churned`, or `archived`
 * stage — `lost` is the only dead-branch bucket, so contract_ended and
 * manual_archive both land there (distinguished by their reason codes
 * on the timeline).
 *
 * Wiring status (unchanged since 2026-05-21): rule definitions land
 * here so future surfaces have something to dispatch against. ONE rule
 * is wired upstream today — outbound_email_queued / outbound_email_sent
 * via app/api/leads/[id]/email/route.ts and the tenant-aware dispatcher
 * in lib/lead-stage-dispatcher.ts (plus the operator/chat-triggered
 * events via cloud-tool-runner's advance_lead_stage). The remaining
 * events need their own trigger sites (calendar webhook for
 * discovery_call_scheduled, proposal tracking pixel for proposal_viewed,
 * e-signature webhook for contract_signed, etc.) which are deferred.
 */

import { getRecord, updateRecord } from "./manifest/data";
import { publishAgentEvent } from "./manifest/events";

export type OasisLeadStageEvent =
  | { type: "outbound_email_queued"; tenantId: string; leadId: string }
  | { type: "outbound_email_sent"; tenantId: string; leadId: string }
  | { type: "discovery_call_scheduled"; tenantId: string; leadId: string }
  | { type: "lead_qualified"; tenantId: string; leadId: string }
  | { type: "proposal_sent"; tenantId: string; leadId: string }
  | { type: "proposal_viewed"; tenantId: string; leadId: string }
  | { type: "contract_signed"; tenantId: string; leadId: string }
  | { type: "onboarding_complete"; tenantId: string; leadId: string }
  | { type: "lead_replied_negative"; tenantId: string; leadId: string }
  | { type: "contract_ended"; tenantId: string; leadId: string }
  // 2026-05-22: operator-driven transitions that the automated webhooks
  // don't cover. Without these, operators couldn't mark a manual first
  // touch (phone / Telegram / LinkedIn) without sending email through
  // the dashboard, and couldn't retire a dead lead from the UI — which
  // is exactly why Bennett Agency stayed labelled as an active client
  // for weeks despite being lost.
  | { type: "manual_outreach_started"; tenantId: string; leadId: string }
  | { type: "manual_archive"; tenantId: string; leadId: string };

export type OasisLeadStageRecordResult =
  | { fired: false; reason: "not_found" | "no_rule" | "stage_blocked" | "error" }
  | { fired: true; from: string; to: string; reasonCode: string };

type Rule = {
  from: Set<string>;
  to: string;
  reasonCode: string;
};

// "Active sales stages" — every pre-won stage a rep or founder might
// still be pursuing. Used by the negative-reply rule to short-circuit
// from anywhere in the sales funnel without listing the same 8 stages
// twice. Deliberately excludes won + the delivery stages (onboarding,
// in_build, client_review, launched): a paying client who sends a
// grumpy email is a delivery/refund conversation, not a lost lead.
const ACTIVE_STAGES = new Set<string>([
  "researched",
  "assigned",
  "attempting_contact",
  "connected",
  "qualified",
  "founder_meeting_booked",
  "demo_completed",
  "proposal_sent",
]);

const RULES: Record<OasisLeadStageEvent["type"], Rule> = {
  // First outreach goes out — bump fresh/assigned leads into
  // attempting_contact. Both the "queued" and "sent" events map here so
  // the lead progresses whether the dashboard or the daemon path
  // triggers it.
  outbound_email_queued: {
    from: new Set<string>(["", "researched", "assigned"]),
    to: "attempting_contact",
    reasonCode: "first_outreach_sent",
  },
  outbound_email_sent: {
    from: new Set<string>(["", "researched", "assigned"]),
    to: "attempting_contact",
    reasonCode: "first_outreach_sent",
  },

  // Calendar webhook (Google / Cal.com) fires this when the founder
  // meeting is on the books. Valid from the working stages up through
  // qualified — leads already past founder_meeting_booked (demo done,
  // proposal out) don't regress when a follow-up call is booked.
  discovery_call_scheduled: {
    from: new Set<string>(["attempting_contact", "connected", "qualified"]),
    to: "founder_meeting_booked",
    reasonCode: "discovery_call_scheduled",
  },

  // Manual qualification or AI-scoring threshold crossed. The drawer's
  // "Mark qualified" action and ai-lead-scoring.ts both fire this.
  lead_qualified: {
    from: new Set<string>(["attempting_contact", "connected"]),
    to: "qualified",
    reasonCode: "qualified_explicit",
  },

  // Proposal document sent through the dashboard or a tracked
  // attachment in the chat. Lead moves into proposal_sent so the
  // operator's funnel reflects "waiting on signature."
  proposal_sent: {
    from: new Set<string>(["founder_meeting_booked", "demo_completed"]),
    to: "proposal_sent",
    reasonCode: "proposal_sent",
  },

  // Tracking pixel hit on the proposal preview, OR the proposal link
  // was clicked. The 14-stage vocabulary has no negotiation stage, so
  // this is now lag-repair only: a view proves the proposal went out,
  // so a record still sitting pre-proposal gets bumped to
  // proposal_sent. Already at proposal_sent → no-op.
  proposal_viewed: {
    from: new Set<string>(["founder_meeting_booked", "demo_completed"]),
    to: "proposal_sent",
    reasonCode: "proposal_viewed",
  },

  // E-signature webhook (DocuSign / HelloSign / Stripe agreement)
  // confirms the contract is signed. Deal is won; delivery stages
  // (onboarding onward) take over from here.
  contract_signed: {
    from: new Set<string>(["demo_completed", "proposal_sent"]),
    to: "won",
    reasonCode: "contract_signed",
  },

  // Operator marks onboarding complete (assets + access collected,
  // kickoff call done). The build starts.
  onboarding_complete: {
    from: new Set<string>(["onboarding"]),
    to: "in_build",
    reasonCode: "onboarding_complete",
  },

  // Inbound classifier or operator flags an explicit "not interested /
  // remove me / wrong fit." Overrides every pre-won sales stage; once a
  // lead says no, the funnel respects it. Post-won stages are excluded —
  // see the ACTIVE_STAGES comment above.
  lead_replied_negative: {
    from: ACTIVE_STAGES,
    to: "lost",
    reasonCode: "lead_replied_negative",
  },

  // Contract expiry or cancellation after launch. The 14-stage
  // vocabulary has no "churned" stage — lost is the only dead branch,
  // and the contract_ended reason code keeps the timeline honest about
  // WHY (was a client, then departed — vs never closed). Narrow from
  // set: a deal that never launched but lapsed is lost via the
  // negative-reply rule or a manual move, not mislabelled here.
  contract_ended: {
    from: new Set<string>(["launched"]),
    to: "lost",
    reasonCode: "contract_ended",
  },

  // Operator pressed "Outreach started" — they called / DM'd / met the
  // lead in person and want the funnel to reflect it. Only valid from
  // the pre-contact stages so already-progressed leads don't regress.
  manual_outreach_started: {
    from: new Set<string>(["researched", "assigned"]),
    to: "attempting_contact",
    reasonCode: "operator_marked_outreach_started",
  },

  // Operator retires a stale row so it disappears from active views.
  // The 14-stage vocabulary has no "archived" stage, so this lands on
  // lost with its own reason code (operator_archived_lead) to keep the
  // timeline distinguishable from a genuine lost-in-funnel. Allowed
  // from any stage except lost itself (no-op when already there);
  // legacy rows still carrying retired 11-stage keys (active_client,
  // churned, archived) are included so they can finally be cleaned up
  // from the UI without a DB edit.
  manual_archive: {
    from: new Set<string>([
      "researched",
      "assigned",
      "attempting_contact",
      "connected",
      "qualified",
      "founder_meeting_booked",
      "demo_completed",
      "proposal_sent",
      "won",
      "onboarding",
      "in_build",
      "client_review",
      "launched",
      // Legacy 11-stage keys — rows the data migration hasn't touched yet.
      "new_contact",
      "outreach",
      "discovery",
      "proposal",
      "negotiation",
      "active_client",
      "churned",
    ]),
    to: "lost",
    reasonCode: "operator_archived_lead",
  },
};

/**
 * Apply the matching rule's transition. Returns a result describing
 * whether the engine fired so callers can surface "stage_bumped" in
 * their API responses (the lead drawer renders a notice when truthy).
 *
 * Mirrors lib/lead-stage-engine.ts → recordLeadStageEvent. The
 * tenant-aware dispatcher in lib/lead-stage-dispatcher.ts picks
 * between this OASIS engine and the SunBiz one based on the tenant's
 * slug.
 */
export async function recordOasisLeadStageEvent(
  event: OasisLeadStageEvent,
): Promise<OasisLeadStageRecordResult> {
  const rule = RULES[event.type];
  if (!rule) return { fired: false, reason: "no_rule" };

  try {
    const lead = await getRecord({
      tenant_id: event.tenantId,
      entity: "lead",
      id: event.leadId,
    });
    if (!lead) return { fired: false, reason: "not_found" };

    const data = lead.data as Record<string, unknown>;
    const currentStage = String(data.stage || "");
    // Archived-lead resurrection bypass (2026-05-22, CC). Archived leads
    // have already moved through the funnel; if they come back the
    // operator must be able to drop them at any stage without the
    // linear from-set gates. Only manual_archive is excluded — moving
    // archived -> archived is a no-op anyway.
    const archivedBypass =
      currentStage === "archived" && event.type !== "manual_archive";
    if (!archivedBypass && !rule.from.has(currentStage)) {
      return { fired: false, reason: "stage_blocked" };
    }
    if (currentStage === rule.to) {
      // Already at the target — no-op, but caller doesn't need an error.
      return { fired: false, reason: "stage_blocked" };
    }

    await updateRecord({
      tenant_id: event.tenantId,
      entity: "lead",
      id: event.leadId,
      patch: { stage: rule.to },
    });

    await publishAgentEvent({
      eventType: "BRAVO_LEAD_AUTO_BUMPED",
      tenantId: event.tenantId,
      publisher: "oasis_lead_stage_engine",
      payload: {
        lead_id: event.leadId,
        from: currentStage || null,
        to: rule.to,
        reason: rule.reasonCode,
        via: event.type,
      },
    });

    return { fired: true, from: currentStage, to: rule.to, reasonCode: rule.reasonCode };
  } catch (err) {
    console.error("[oasis-lead-stage-engine] recordOasisLeadStageEvent failed", event.type, err);
    return { fired: false, reason: "error" };
  }
}
