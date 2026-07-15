/**
 * lib/lead-stage-engine.ts — single source of truth for automatic
 * SunBiz lead.stage transitions.
 *
 * Every event-firing surface in the dashboard (doc upload, email
 * queue, email open tracker, sequence completion, inbound reply
 * classifier) records its event through `recordLeadStageEvent`. The
 * engine looks up the canonical transition rule, checks the current
 * lead's stage against the rule's `from` set, optionally runs a
 * predicate (e.g. "all required docs received?"), and updates the
 * lead via `updateRecord` when the rule fires.
 *
 * Manual operator overrides are respected: each rule's `from` set
 * narrowly defines the stages from which automatic progression can
 * fire. Once an operator manually moves a lead past that point (say,
 * to "signed_application"), no inbound automated event can yank it
 * backwards.
 *
 * updateRecord auto-publishes the canonical
 * BRAVO_RECORD_STATUS_CHANGED that the drip engine (Phase 4) and the
 * timeline merge already subscribe to. The engine layers an extra
 * BRAVO_LEAD_AUTO_BUMPED event with the `reason` and `via` fields so
 * the operator timeline can render WHY a stage changed (vs. just
 * THAT it changed).
 *
 * Best-effort emission semantics: errors are caught and logged. A
 * stage transition failure must never break the primary write path
 * (the doc upload, the email queue, etc.) that triggered it. The
 * canonical update path also already publishes the event, so the
 * audit trail stays intact even if the engine itself errors.
 */

import { getRecord, updateRecord } from "./manifest/data";
import { publishAgentEvent } from "./manifest/events";
import { getServiceSupabase } from "./supabase-server";
import { REQUIRED_LEAD_DOC_TYPES } from "./lead-doc-display";

/**
 * Event types the engine accepts. Adding a new trigger is a matter
 * of adding an entry here and a corresponding RULES entry below.
 */
export type LeadStageEvent =
  | { type: "doc_uploaded"; tenantId: string; leadId: string; docType: string }
  | { type: "outbound_email_queued"; tenantId: string; leadId: string }
  | { type: "outbound_email_sent"; tenantId: string; leadId: string }
  | { type: "email_opened"; tenantId: string; leadId: string }
  | { type: "email_clicked"; tenantId: string; leadId: string }
  | { type: "form_signed"; tenantId: string; leadId: string }
  | { type: "lead_replied_negative"; tenantId: string; leadId: string }
  | { type: "sequence_exhausted"; tenantId: string; leadId: string };

export type LeadStageRecordResult =
  | { fired: false; reason: "not_found" | "no_rule" | "stage_blocked" | "predicate_failed" | "error" }
  | { fired: true; from: string; to: string; reasonCode: string };

type Rule = {
  /** Stages from which this transition is allowed to fire. Empty
   *  string in the set lets the engine bump a lead with no stage
   *  value yet (fresh imports). */
  from: Set<string>;
  to: string;
  /** Machine-readable reason code stored on the BRAVO_LEAD_AUTO_BUMPED
   *  event payload. The timeline merges this for the operator. */
  reasonCode: string;
  /** Optional asynchronous gate. Engine only fires when this returns
   *  true. Used by the doc-uploaded rule to require all three
   *  canonical SunBiz docs before bumping to hot_lead. */
  predicate?: (input: { tenantId: string; leadId: string; leadData: Record<string, unknown> }) => Promise<boolean>;
};

const RULES: Record<LeadStageEvent["type"], Rule> = {
  // All three required SunBiz docs (bank statements + driver's
  // license + void cheque) present → signed_application (ready for
  // underwriting). Partial set keeps the lead in missing_info so the
  // operator can chase the rest.
  // 2026-07-15 (Adon): retargeted from the removed hot_lead stage.
  doc_uploaded: {
    from: new Set<string>(["", "missing_info", "follow_up"]),
    to: "signed_application",
    reasonCode: "all_required_docs_received",
    predicate: async ({ tenantId, leadId }) => {
      const db = getServiceSupabase();
      const r = await db
        .from("lead_documents")
        .select("doc_type")
        .eq("tenant_id", tenantId)
        .eq("lead_id", leadId)
        .is("metadata->>deleted_at", null); // Batch 5: soft-deleted docs don't count toward required-docs
      if (r.error || !r.data) return false;
      const present = new Set(r.data.map((row) => (row as { doc_type: string }).doc_type));
      return REQUIRED_LEAD_DOC_TYPES.every((t) => present.has(t));
    },
  },

  // Operator queues an outbound email to the lead. Bumps the
  // sales motion forward — "we've made contact" maps to sent_application.
  // 2026-07-15 (Adon): from-set uses "imported" (new intake) in place of hot_lead.
  outbound_email_queued: {
    from: new Set<string>(["imported", "follow_up", "missing_info"]),
    to: "sent_application",
    reasonCode: "application_emailed",
  },

  // send_gateway.py confirms the actual SMTP send and POSTs to
  // /api/outbound/log. Same target stage as the queue event —
  // included so a daemon-only send (no dashboard queue intermediate)
  // still moves the lead forward.
  // 2026-07-15 (Adon): from-set uses "imported" (new intake) in place of hot_lead.
  outbound_email_sent: {
    from: new Set<string>(["imported", "follow_up", "missing_info"]),
    to: "sent_application",
    reasonCode: "application_emailed",
  },

  // Tracking-pixel hit. Only valid if the lead is currently in
  // sent_application — opens against earlier stages indicate a
  // confused prospect, not a meaningful funnel step.
  email_opened: {
    from: new Set<string>(["sent_application"]),
    to: "viewed_application",
    reasonCode: "email_opened",
  },

  // A tracked LINK click in a drip email. Unlike an open (a pixel fetch that
  // Apple Mail Privacy Protection prefetches, so it's gated narrowly to
  // sent_application), a click is a deliberate human action and a strong intent
  // signal — Adon's rule: "once they click the email they should automatically
  // be put into viewed". So it advances from any PRE-viewed funnel stage. The
  // from-set stops before viewed_application, so it's forward-only: a click from
  // a lead already at viewed / signed / submitted is a no-op (never a regression).
  email_clicked: {
    from: new Set<string>([
      "",
      "imported",
      "follow_up",
      "missing_info",
      "sent_application",
    ]),
    to: "viewed_application",
    reasonCode: "email_clicked",
  },

  // Public form's signature step completes. The form already
  // applies step_outcomes via updateRecord; this rule is a
  // safety-net for surfaces that bypass step_outcomes.
  form_signed: {
    from: new Set<string>(["sent_application", "viewed_application"]),
    to: "signed_application",
    reasonCode: "form_signed",
  },

  // Inbound classifier flagged the reply as negative ("not interested,
  // remove me, etc."). Always overrides forward progression.
  // 2026-07-15 (Adon): ghost removed → soft "not interested right now" replies
  // route to follow_up (re-engageable general nurture). A genuine STOP/unsubscribe
  // sets the data.opted_out compliance flag separately.
  lead_replied_negative: {
    from: new Set<string>([
      "imported",
      "missing_info",
      "follow_up",
      "sent_application",
      "viewed_application",
    ]),
    to: "follow_up",
    reasonCode: "lead_replied_negative",
  },

  // sequence_runner.py hits the last step of a follow-up sequence
  // without a reply. 2026-07-15 (Adon): ghost removed → routes to follow_up
  // (general nurture; a no-op for leads already there).
  sequence_exhausted: {
    from: new Set<string>(["follow_up", "sent_application", "missing_info"]),
    to: "follow_up",
    reasonCode: "sequence_exhausted_no_response",
  },
};

/**
 * Apply the matching rule's transition. Returns a result describing
 * whether the engine fired so callers can surface "stage_bumped" in
 * their API responses (the drawer renders a notice when this is
 * truthy).
 */
export async function recordLeadStageEvent(
  event: LeadStageEvent,
): Promise<LeadStageRecordResult> {
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
    if (!rule.from.has(currentStage)) {
      return { fired: false, reason: "stage_blocked" };
    }
    if (currentStage === rule.to) {
      // Already at the target — no-op, but still report success so
      // callers don't treat "already there" as an error.
      return { fired: false, reason: "stage_blocked" };
    }

    if (rule.predicate) {
      const ok = await rule.predicate({
        tenantId: event.tenantId,
        leadId: event.leadId,
        leadData: data,
      });
      if (!ok) return { fired: false, reason: "predicate_failed" };
    }

    await updateRecord({
      tenant_id: event.tenantId,
      entity: "lead",
      id: event.leadId,
      patch: { stage: rule.to },
    });

    // Layered observability event — updateRecord already emitted the
    // canonical BRAVO_RECORD_STATUS_CHANGED that drips subscribe to.
    // This one carries the WHY so the timeline can render
    // "Auto-advanced to hot_lead because all required docs received".
    await publishAgentEvent({
      eventType: "BRAVO_LEAD_AUTO_BUMPED",
      tenantId: event.tenantId,
      publisher: "lead_stage_engine",
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
    console.error("[lead-stage-engine] recordLeadStageEvent failed", event.type, err);
    return { fired: false, reason: "error" };
  }
}
