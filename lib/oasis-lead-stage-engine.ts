/**
 * lib/oasis-lead-stage-engine.ts — automatic lead.stage transitions for
 * the OASIS tenant.
 *
 * Mirrors lib/lead-stage-engine.ts in shape but encodes the 11-stage
 * AI-agency lifecycle from lib/oasis-stage-meta.ts instead of SunBiz's
 * funding funnel. Same Event union, same Result type, same idempotency
 * + manual-override-wins semantics:
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
 * Rule coverage (per the V6.9 ribbon-pass brief's table):
 *
 *   Event                       From               → To             Reason
 *   outbound_email_queued       new_contact        → outreach        first_outreach_sent
 *   outbound_email_sent         new_contact        → outreach        first_outreach_sent
 *   discovery_call_scheduled    outreach           → discovery       discovery_call_scheduled
 *   lead_qualified              discovery          → qualified       qualified_explicit
 *   proposal_sent               qualified          → proposal        proposal_sent
 *   proposal_viewed             proposal           → negotiation     proposal_viewed
 *   contract_signed             negotiation        → onboarding      contract_signed
 *   onboarding_complete         onboarding         → active_client   onboarding_complete
 *   lead_replied_negative       any active stage   → lost            lead_replied_negative
 *   contract_ended              active_client      → churned         contract_ended
 *
 * Wiring status (2026-05-21): rule definitions land here so future
 * surfaces have something to dispatch against. ONE rule is wired
 * upstream today — outbound_email_queued / outbound_email_sent via
 * app/api/leads/[id]/email/route.ts and the tenant-aware dispatcher
 * in lib/lead-stage-dispatcher.ts. The remaining events need their
 * own trigger sites (calendar webhook for discovery_call_scheduled,
 * proposal tracking pixel for proposal_viewed, e-signature webhook
 * for contract_signed, etc.) which are deferred.
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
  // don't cover. Without these, operators couldn't move a lead from
  // new_contact -> outreach without sending email through the dashboard
  // (manual outreach via phone / Telegram / LinkedIn left the lead
  // stuck at new_contact). And they couldn't archive a churned/lost
  // lead from the UI — which is exactly why Bennett Agency stayed
  // labelled active_client for weeks despite being lost.
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

// "Active stages" — every stage an operator might still be pursuing.
// Used by negative-reply + contract-end rules to short-circuit
// from anywhere in the funnel without listing the same 8 stages twice.
const ACTIVE_STAGES = new Set<string>([
  "new_contact",
  "outreach",
  "discovery",
  "qualified",
  "proposal",
  "negotiation",
  "onboarding",
  "active_client",
]);

const RULES: Record<OasisLeadStageEvent["type"], Rule> = {
  // First outreach goes out — bump fresh leads into the outreach stage.
  // Both the "queued" and "sent" events map here so the lead progresses
  // whether the dashboard or the daemon path triggers it.
  outbound_email_queued: {
    from: new Set<string>(["", "new_contact"]),
    to: "outreach",
    reasonCode: "first_outreach_sent",
  },
  outbound_email_sent: {
    from: new Set<string>(["", "new_contact"]),
    to: "outreach",
    reasonCode: "first_outreach_sent",
  },

  // Calendar webhook (Google / Cal.com) fires this when a discovery
  // call is on the books. Only valid from `outreach` — already-qualified
  // leads with a follow-up call don't regress.
  discovery_call_scheduled: {
    from: new Set<string>(["outreach"]),
    to: "discovery",
    reasonCode: "discovery_call_scheduled",
  },

  // Manual qualification or AI-scoring threshold crossed. The drawer's
  // "Mark qualified" action and ai-lead-scoring.ts both fire this.
  lead_qualified: {
    from: new Set<string>(["discovery", "outreach"]),
    to: "qualified",
    reasonCode: "qualified_explicit",
  },

  // Proposal document sent through the dashboard or a tracked
  // attachment in the chat. Lead moves into the proposal stage so the
  // operator's funnel reflects "waiting on signature."
  proposal_sent: {
    from: new Set<string>(["qualified", "discovery"]),
    to: "proposal",
    reasonCode: "proposal_sent",
  },

  // Tracking pixel hit on the proposal preview, OR the proposal link
  // was clicked. Bumps to negotiation since the prospect is actively
  // reading + about to push back on terms.
  proposal_viewed: {
    from: new Set<string>(["proposal"]),
    to: "negotiation",
    reasonCode: "proposal_viewed",
  },

  // E-signature webhook (DocuSign / HelloSign / Stripe agreement)
  // confirms the contract is signed. Lead moves into onboarding —
  // the deliverable side of the funnel.
  contract_signed: {
    from: new Set<string>(["negotiation", "proposal"]),
    to: "onboarding",
    reasonCode: "contract_signed",
  },

  // Operator marks onboarding complete (first deliverable shipped,
  // kickoff call done). Lead becomes an active_client; MRR meter ticks.
  onboarding_complete: {
    from: new Set<string>(["onboarding"]),
    to: "active_client",
    reasonCode: "onboarding_complete",
  },

  // Inbound classifier or operator flags an explicit "not interested /
  // remove me / wrong fit." Overrides every active stage; once a lead
  // says no, the funnel respects it.
  lead_replied_negative: {
    from: ACTIVE_STAGES,
    to: "lost",
    reasonCode: "lead_replied_negative",
  },

  // Contract expiry or cancellation. Only valid from active_client so
  // a deal that never closed but lapsed doesn't get mislabelled as
  // "churned" (it's "lost" via the prior rule instead).
  contract_ended: {
    from: new Set<string>(["active_client"]),
    to: "churned",
    reasonCode: "contract_ended",
  },

  // Operator pressed "Outreach started" — they called / DM'd / met the
  // lead in person and want the funnel to reflect it. Only valid from
  // new_contact so already-progressed leads don't regress to outreach.
  manual_outreach_started: {
    from: new Set<string>(["new_contact"]),
    to: "outreach",
    reasonCode: "operator_marked_outreach_started",
  },

  // Operator pressed "Move to archived" — final cleanup for stale rows
  // that should disappear from active views. Allowed from any terminal
  // OR active stage so things like Bennett (active_client, but lost
  // months ago) can finally be cleaned up from the UI without a DB
  // edit. Engine-side guard: target stage is "archived"; from filters
  // out only "archived" itself (no-op when already there).
  manual_archive: {
    from: new Set<string>([
      "new_contact",
      "outreach",
      "discovery",
      "qualified",
      "proposal",
      "negotiation",
      "onboarding",
      "active_client",
      "churned",
      "lost",
    ]),
    to: "archived",
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
