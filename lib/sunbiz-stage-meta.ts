/**
 * Stage metadata for the SunBiz tenant — colors + display labels for
 * the Lead Pipeline and Opportunity Pipeline rail.
 *
 * Palette (2026-05-18 v2): refined from the original Salesforce-Lightning
 * hex set, which read as bright + saturated against the dashboard's
 * dark theme. The new palette is desaturated, deeper, and tonally
 * consistent — readable on `bg-bg-deep` (#0f1115) without screaming.
 *
 * Design principles:
 *   - Lower saturation than Salesforce Lightning (no #FFB81C / #E91A86).
 *   - Stage semantics preserved: warm progression for active stages,
 *     muted neutrals for paused, deep wine for declined / dead.
 *   - White foreground on every chip so contrast stays predictable.
 *   - Each chip stands distinct in a vertical rail without competing
 *     for attention; the active stage's underline does the highlighting.
 *
 * When Adon's team needs the legacy bright palette back (compatibility
 * with their Salesforce reports), branch on tenant_id rather than
 * editing in place.
 */

export type StageMeta = {
  key: string;
  label: string;
  bg: string; // arrow fill
  fg: string; // arrow text color
};

// Lead Pipeline order — slimmed 2026-05-23 (Jordan/Oasis meeting, migration
// 064). Active funnel left-to-right (hot_lead → submitted), then terminal
// states (declined, default) on the right.
//
// 2026-06-08 — Phase 1 expansion (Adon MCA brief): added post-funding lifecycle
// stages the original 9 didn't model. They sit AFTER `submitted` and BEFORE the
// terminal states:
//   - funded:            money hit the merchant's account (handoff from
//                         opportunity-side `funded` into the lead's lifecycle
//                         so we can run the Onboarding/Mid-Term sequences off
//                         the lead row).
//   - ghost:             applied but stopped responding (highest-ROI
//                         re-engagement segment per brief §2).
//   - opted_out:         STOP received OR /unsubscribe POST landed.
//                         Distinct from `data.opted_out=true` because
//                         the stage is visible in the kanban; the flag
//                         is what send_gateway reads to block sends.
//
// 2026-06-16 — renewal_eligible + renewed_elsewhere REMOVED from the lead
// pipeline (CC). The renewal lifecycle is owned entirely by the dedicated
// Renewals page (/renewals), which derives renewal urgency from funded_deals
// (funded_at + term) and the funded_deal.status enum [funded, renewal_due,
// renewed, lost, default] — NOT from a lead stage. Keeping renewal columns in
// the lead kanban was redundant org clutter (nothing ever wrote those stages —
// they were absent from the lead.stage enum). Funded leads still show under
// `funded`; their renewal tracking lives on the Renewals page.
export const LEAD_PIPELINE_STAGES: StageMeta[] = [
  // Change #1 (Adon, lead status defs 2026-06-19): "Intent Inquiry" = the
  // merchant OPENED the first application (initial-lead-capture) but did NOT
  // complete it. Set on form OPEN in /api/forms/view. "Viewed" = COMPLETED
  // the first app (set on form submit). The two are mutually exclusive.
  { key: "intent_inquiry_submitted", label: "Intent Inquiry", bg: "#0E9AA7", fg: "#FFFFFF" },
  { key: "hot_lead",           label: "Hot Lead",           bg: "#C0842F", fg: "#FFFFFF" },
  { key: "missing_info",       label: "Missing Info",       bg: "#3978BE", fg: "#FFFFFF" },
  // UW Sheet (CC, 2026-06-30): entry stage for deals the "Sift" MCA Lead
  // Scrubber pulls off Breeze/SunBiz Google-Drive sheets, scores, and — after
  // Ezra's approval — injects here. Sits ABOVE follow_up: a lead landing here
  // kicks off the autonomous follow-up lifecycle (drip + stale-lead nudges).
  // See ~/SunBiz-Agent/scripts/mca_lead_scrubber.py.
  { key: "uw_sheet",           label: "UW Sheet",           bg: "#5A4A8A", fg: "#FFFFFF" },
  { key: "follow_up",          label: "Follow Up",          bg: "#8A6A3B", fg: "#FFFFFF" },
  { key: "sent_application",   label: "Sent Application",   bg: "#7057A7", fg: "#FFFFFF" },
  { key: "viewed_application", label: "Viewed", bg: "#2E8392", fg: "#FFFFFF" },
  { key: "signed_application", label: "Signed Application", bg: "#32876B", fg: "#FFFFFF" },
  // Submitted Application (Adon, 2026-06-22) — re-added directly after
  // signed_application: the lead's application has been submitted to
  // underwriting / funders. Leads that land here are entered into the
  // "signed application" email drip (the drip sequence is wired separately).
  { key: "submitted_application", label: "Submitted Application", bg: "#356B8A", fg: "#FFFFFF" },
  // Ezra 2026-06-24: manual terminal stages on the leads board (mirror the
  // opportunity Declined/Dead so the labels/colors match "in application").
  // Operators can move a lead straight to declined/dead from the leads page.
  // Import routing still aliases a bare "Declined"/"Dead" lead to ghost
  // (re-engageable) — preserved via resolveLeadStage's alias-first order.
  { key: "declined",           label: "Declined",           bg: "#9B3D45", fg: "#FFFFFF" },
  { key: "dead_file",          label: "Dead",               bg: "#6F2D34", fg: "#FFFFFF" },
  { key: "ghost",              label: "Ghost",              bg: "#6F6F75", fg: "#FFFFFF" },
  { key: "default",            label: "Default",            bg: "#62666F", fg: "#FFFFFF" },
  // 2026-06-18 (CC): removed `submitted`, `funded`, `declined`, `opted_out`
  // from the LEAD pipeline. Funding lives on the Renewals/funded_deal side;
  // negative-reply / no-response leads now route to `ghost` (re-engageable);
  // opt-out COMPLIANCE is the `data.opted_out` flag + suppression list, NOT a
  // pipeline stage. The opportunity pipeline below keeps `funded`/`declined`.
];

// Opportunity Pipeline order — slimmed to 10 stages 2026-05-23
// (Jordan/Oasis meeting, migration 064). Active funnel left-to-right
// (application_in → funded), then long-tail (follow_ups) + terminal
// (declined, dead_file). Removed approved* / selling /
// submitted_to_underwriting / contracts_ordered / no_offers_available;
// existing rows remapped in migration 064.
export const OPPORTUNITY_PIPELINE_STAGES: StageMeta[] = [
  { key: "application_in",  label: "Application In",  bg: "#4C6580", fg: "#FFFFFF" },
  { key: "shopping",        label: "Shopping",        bg: "#416F9C", fg: "#FFFFFF" },
  // Approved (Adon, 2026-06-22) — re-added after `shopping`: a funder came
  // back with an approval and the deal is now being actively worked (chasing
  // stipulations -> docs out -> login -> funded). This is the explicit tab an
  // operator moves a shopped deal into post-approval; it anchors the
  // dashboard "Active Deals" section. Blue matches ADON_DEAL_STAGES "Approved".
  { key: "approved",        label: "Approved",        bg: "#3B82F6", fg: "#FFFFFF" },
  { key: "missing_info",    label: "Missing Info",    bg: "#3978BE", fg: "#FFFFFF" },
  { key: "requested_docs",  label: "Requested Docs",  bg: "#9B7635", fg: "#FFFFFF" },
  { key: "docs_out",        label: "Docs Out",        bg: "#2E8392", fg: "#FFFFFF" },
  { key: "login",           label: "Login",           bg: "#566173", fg: "#FFFFFF" },
  { key: "funded",          label: "Funded",          bg: "#32876B", fg: "#FFFFFF" },
  { key: "follow_ups",      label: "Follow Ups",      bg: "#C0842F", fg: "#FFFFFF" },
  { key: "declined",        label: "Declined",        bg: "#9B3D45", fg: "#FFFFFF" },
  { key: "dead_file",       label: "Dead",            bg: "#6F2D34", fg: "#FFFFFF" },
  // Default (Ezra, 2026-06-24): a FUNDED deal where the merchant stopped
  // paying / defaulted on the advance. A distinct terminal-negative column
  // from Declined (funder said no) and Dead (dead file) — operators move a
  // soured funded deal here. Slate grey matches the lead pipeline's `default`
  // stage so the same lifecycle state reads identically across both boards.
  { key: "default",         label: "Default",         bg: "#62666F", fg: "#FFFFFF" },
];

// Adon's canonical 7-stage deal model — 2026-05-28 (Adon handoff,
// cc-pipeline-handoff.md §"Stage groups, color-banded headers"). Used by
// Phase 5's pixel-port PipelineView, which reads merchant_summary.deal_stage
// rather than data.stage. Colors are DESIGN-LOCKED — do not desaturate
// or remap; they drive both the chevron headers and the merchant-row
// stage-edge accent.
//
// Why two lists coexist: the existing manifest-driven SunBiz dispatcher
// at /t/sun/leads reads data.stage (legacy 10-stage), and LeadPipelineView
// renders against OPPORTUNITY_PIPELINE_STAGES. Phase 5 ships a separate
// PipelineView that reads merchant_summary.deal_stage and uses
// ADON_DEAL_STAGES. After Phase 5 retires LeadPipelineView, we delete
// OPPORTUNITY_PIPELINE_STAGES in one cleanup migration.
//
// Sub-state preservation: the original 10 keys are kept at
// data.legacy_stage (per migration 065) so an operator escape hatch can
// surface the fine-grained substate if Adon later asks for it back.
export const ADON_DEAL_STAGES: StageMeta[] = [
  { key: "Application In",  label: "Application In",  bg: "#ef4444", fg: "#FFFFFF" }, // red
  { key: "Missing Info",    label: "Missing Info",    bg: "#f97316", fg: "#FFFFFF" }, // orange
  { key: "Shopping",        label: "Shopping",        bg: "#f59e0b", fg: "#FFFFFF" }, // amber
  { key: "Approved",        label: "Approved",        bg: "#3b82f6", fg: "#FFFFFF" }, // blue
  { key: "Declined",        label: "Declined",        bg: "#64748b", fg: "#FFFFFF" }, // slate
  { key: "Funded",          label: "Funded",          bg: "#10b981", fg: "#FFFFFF" }, // green
  { key: "Dead",            label: "Dead",            bg: "#71717a", fg: "#FFFFFF" }, // zinc
];

export function getStageMeta(entityName: string): StageMeta[] {
  if (entityName === "lead") return LEAD_PIPELINE_STAGES;
  // application is the operator-facing Opportunity Pipeline (per
  // Salesforce vocabulary); offer is a per-lender term-sheet sub-detail
  // that happens to share the same stage labels. Both resolve to the
  // same StageMeta list.
  if (entityName === "application") return OPPORTUNITY_PIPELINE_STAGES;
  if (entityName === "offer") return OPPORTUNITY_PIPELINE_STAGES;
  return [];
}

export function findStage(entityName: string, key: string): StageMeta | undefined {
  return getStageMeta(entityName).find((s) => s.key === key);
}
