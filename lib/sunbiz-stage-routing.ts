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

const LEAD_STAGE_ALIASES = new Map<string, string>([
  ["inbound", "imported"],
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
  ["decline", "declined"],
]);

const APPLICATION_STAGE_ALIASES = new Map<string, string>([
  ["application in", "application_in"],
  ["app in", "application_in"],
  ["application", "application_in"],
  ["shopping", "shopping"],
  ["shop", "shopping"],
  ["shop out", "shopping"],
  ["shopout", "shopping"],
  ["submitted", "shopping"],
  ["submitted to underwriting", "submitted_to_underwriting"],
  ["underwriting", "submitted_to_underwriting"],
  ["missing", "missing_info"],
  ["missing info", "missing_info"],
  ["approved", "approved"],
  ["approved open offers", "approved_open_offers"],
  ["open offers", "approved_open_offers"],
  ["selling", "selling"],
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
  ["contracts ordered", "contracts_ordered"],
  ["contract ordered", "contracts_ordered"],
  ["contract out", "contracts_ordered"],
  ["approved never funded", "approved_never_funded"],
  ["never funded", "approved_never_funded"],
  ["no offers available", "no_offers_available"],
  ["no offer", "no_offers_available"],
  ["no offers", "no_offers_available"],
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
    return { stage: "imported", entityType: "lead" };
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
  if (LEAD_STAGE_KEYS.has(value)) return value;
  return LEAD_STAGE_LABELS.get(value) || LEAD_STAGE_ALIASES.get(value) || null;
}

function resolveOpportunityStage(value: string): string | null {
  if (OPP_STAGE_KEYS.has(value)) return value;
  return OPP_STAGE_LABELS.get(value) || APPLICATION_STAGE_ALIASES.get(value) || null;
}

function normalizeStageText(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}
