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
  bg: string;   // arrow fill
  fg: string;   // arrow text color
};

export const LEAD_PIPELINE_STAGES: StageMeta[] = [
  { key: "imported",            label: "Imported",            bg: "#4A5568", fg: "#FFFFFF" },
  { key: "not_interested",      label: "Not Interested",      bg: "#2D3142", fg: "#E5E7EB" },
  { key: "hot_lead",            label: "Hot Lead",            bg: "#A87534", fg: "#FFFFFF" },
  { key: "missing_info",        label: "Missing Info",        bg: "#4A6FA5", fg: "#FFFFFF" },
  { key: "declined",            label: "Declined",            bg: "#7C3036", fg: "#FFFFFF" },
  { key: "follow_up",           label: "Follow Up",           bg: "#5B5550", fg: "#FFFFFF" },
  { key: "sent_application",    label: "Sent Application",    bg: "#6B4E8C", fg: "#FFFFFF" },
  { key: "viewed_application",  label: "Viewed Application",  bg: "#3D7A87", fg: "#FFFFFF" },
  { key: "signed_application",  label: "Signed Application",  bg: "#3C7E68", fg: "#FFFFFF" },
  { key: "default",             label: "Default",             bg: "#735F3F", fg: "#FFFFFF" },
  { key: "submitted",           label: "Submitted",           bg: "#4D5C6E", fg: "#FFFFFF" },
  { key: "approved",            label: "Approved",            bg: "#3F6F55", fg: "#FFFFFF" },
];

export const OPPORTUNITY_PIPELINE_STAGES: StageMeta[] = [
  { key: "submitted_to_underwriting", label: "Submitted To Underwriting", bg: "#4D5C6E", fg: "#FFFFFF" },
  { key: "approved_open_offers",      label: "Approved Open Offers",      bg: "#3C7E68", fg: "#FFFFFF" },
  { key: "contracts_ordered",         label: "Contracts Ordered",         bg: "#856537", fg: "#FFFFFF" },
  { key: "funded",                    label: "Funded",                    bg: "#3F6F55", fg: "#FFFFFF" },
  { key: "approved_never_funded",     label: "Approved Never Funded",     bg: "#A87534", fg: "#FFFFFF" },
  { key: "no_offers_available",       label: "No Offers Available",       bg: "#5B5550", fg: "#FFFFFF" },
  { key: "dead_file",                 label: "Dead File",                 bg: "#7C3036", fg: "#FFFFFF" },
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
