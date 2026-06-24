import {
  LEAD_PIPELINE_STAGES,
  OPPORTUNITY_PIPELINE_STAGES,
} from "./sunbiz-stage-meta";

export type SunBizRecordEntity = "lead" | "application";

type RouteStageOptions = {
  explicitRecordType?: string | null;
  hasApplicationEvidence?: boolean;
};

const LEAD_STAGE_KEYS = new Set(LEAD_PIPELINE_STAGES.map((s) => s.key));
const LEAD_STAGE_LABELS = new Map(
  LEAD_PIPELINE_STAGES.map((s) => [normalizeStageText(s.label), s.key]),
);

const OPP_STAGE_KEYS = new Set(OPPORTUNITY_PIPELINE_STAGES.map((s) => s.key));
const OPP_STAGE_LABELS = new Map(
  OPPORTUNITY_PIPELINE_STAGES.map((s) => [normalizeStageText(s.label), s.key]),
);

// 2026-05-23: "inbound" alias now routes to hot_lead (imported stage
// retired in migration 064). "not interested" / "not_interested" added
// as aliases for declined so legacy inbound payloads still resolve.
const LEAD_STAGE_ALIASES = new Map<string, string>([
  ["inbound", "hot_lead"],
  ["imported", "hot_lead"],
  ["not interested", "ghost"],
  ["not_interested", "ghost"],
  ["application sent", "sent_application"],
  ["sent app", "sent_application"],
  ["app sent", "sent_application"],
  ["viewed app", "viewed_application"],
  ["app viewed", "viewed_application"],
  ["signed app", "signed_application"],
  ["app signed", "signed_application"],
  ["followup", "follow_up"],
  ["follow up", "follow_up"],
  ["hot", "hot_lead"],
  ["missing", "missing_info"],
  // 2026-06-18 (CC): lead `declined`/`submitted` stages removed — route legacy
  // inbound aliases to their replacements (declined→ghost, approved→signed).
  ["decline", "ghost"],
  ["declined", "ghost"],
  ["approved", "signed_application"],
]);

// Migration 064 (2026-05-23): legacy aliases that previously mapped to
// retired stages now route to their consolidation targets so historical
// imports / inbound payloads still resolve cleanly:
//   submitted_to_underwriting → shopping
//   approved / approved_open_offers / selling → shopping
//   contracts_ordered → docs_out
//   approved_never_funded → dead_file
//   no_offers_available → declined
const APPLICATION_STAGE_ALIASES = new Map<string, string>([
  ["application in", "application_in"],
  ["app in", "application_in"],
  ["application", "application_in"],
  ["shopping", "shopping"],
  ["shop", "shopping"],
  ["shop out", "shopping"],
  ["shopout", "shopping"],
  ["submitted", "shopping"],
  ["submitted to underwriting", "shopping"],
  ["underwriting", "shopping"],
  ["missing", "missing_info"],
  ["missing info", "missing_info"],
  ["approved", "shopping"],
  ["approved open offers", "shopping"],
  ["open offers", "shopping"],
  ["selling", "shopping"],
  ["requested docs", "requested_docs"],
  ["docs requested", "requested_docs"],
  ["docs out", "docs_out"],
  ["documents out", "docs_out"],
  ["login", "login"],
  ["logins", "login"],
  ["funded", "funded"],
  ["fund", "funded"],
  ["follow ups", "follow_ups"],
  ["followups", "follow_ups"],
  ["follow up", "follow_ups"],
  ["declined", "declined"],
  ["decline", "declined"],
  ["dead", "dead_file"],
  ["dead file", "dead_file"],
  ["contracts ordered", "docs_out"],
  ["contract ordered", "docs_out"],
  ["contract out", "docs_out"],
  ["approved never funded", "dead_file"],
  ["never funded", "dead_file"],
  ["no offers available", "declined"],
  ["no offer", "declined"],
  ["no offers", "declined"],
]);

const APPLICATION_RECORD_TYPES = new Set(["application", "opportunity", "deal"]);
const LEAD_RECORD_TYPES = new Set(["lead", "merchant", "prospect"]);

export function routeSunBizImportStage(
  rawStage: string | null | undefined,
  options: RouteStageOptions = {},
): { stage: string; entityType: SunBizRecordEntity } {
  const explicit = normalizeStageText(options.explicitRecordType || "");
  const stageText = normalizeStageText(rawStage || "");
  const hasApplicationEvidence = Boolean(options.hasApplicationEvidence);

  const explicitApplication = APPLICATION_RECORD_TYPES.has(explicit);
  const explicitLead = LEAD_RECORD_TYPES.has(explicit);

  if (!stageText) {
    if (explicitApplication || hasApplicationEvidence) {
      return { stage: "application_in", entityType: "application" };
    }
    return { stage: "hot_lead", entityType: "lead" };
  }

  const directOpportunity = resolveOpportunityStage(stageText);
  const directLead = resolveLeadStage(stageText);

  if (explicitApplication) {
    return {
      stage: directOpportunity || "application_in",
      entityType: "application",
    };
  }

  if (explicitLead && directLead) {
    return { stage: directLead, entityType: "lead" };
  }

  if (directOpportunity && (hasApplicationEvidence || !directLead)) {
    return { stage: directOpportunity, entityType: "application" };
  }

  if (directLead) {
    return { stage: directLead, entityType: "lead" };
  }

  if (hasApplicationEvidence) {
    return { stage: "application_in", entityType: "application" };
  }

  return { stage: "imported", entityType: "lead" };
}

function resolveLeadStage(value: string): string | null {
  // Import aliases win over direct keys/labels (mirrors resolveOpportunityStage,
  // fixed for the same trap). A historical "Declined"/"Dead" lead in a CSV is
  // re-engageable (ghost), NOT the new manual terminal stages — those are
  // operator-set-only (the dropdown + set-stage validate against LEAD keys).
  return (
    LEAD_STAGE_ALIASES.get(value) ||
    LEAD_STAGE_LABELS.get(value) ||
    (LEAD_STAGE_KEYS.has(value) ? value : null)
  );
}

function resolveOpportunityStage(value: string): string | null {
  // Import aliases win over direct keys/labels. "Approved" in historical CSVs
  // is not the live operator "approved" stage; it means the old offer-comparison
  // loop, which Migration 064 consolidated into shopping.
  return (
    APPLICATION_STAGE_ALIASES.get(value) ||
    OPP_STAGE_LABELS.get(value) ||
    (OPP_STAGE_KEYS.has(value) ? value : null)
  );
}

function normalizeStageText(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}
