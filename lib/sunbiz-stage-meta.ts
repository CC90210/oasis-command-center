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

export const LEAD_PIPELINE_STAGES: StageMeta[] = [
  { key: "imported",           label: "Imported",           bg: "#5E6B82", fg: "#FFFFFF" },
  { key: "not_interested",     label: "Not Interested",     bg: "#414957", fg: "#E5E7EB" },
  { key: "hot_lead",           label: "Hot Lead",           bg: "#C0842F", fg: "#FFFFFF" },
  { key: "missing_info",       label: "Missing Info",       bg: "#3978BE", fg: "#FFFFFF" },
  { key: "declined",           label: "Declined",           bg: "#9B3D45", fg: "#FFFFFF" },
  { key: "follow_up",          label: "Follow Up",          bg: "#8A6A3B", fg: "#FFFFFF" },
  { key: "sent_application",   label: "Sent Application",   bg: "#7057A7", fg: "#FFFFFF" },
  { key: "viewed_application", label: "Viewed Application", bg: "#2E8392", fg: "#FFFFFF" },
  { key: "signed_application", label: "Signed Application", bg: "#32876B", fg: "#FFFFFF" },
  { key: "default",            label: "Default",            bg: "#62666F", fg: "#FFFFFF" },
  { key: "submitted",          label: "Submitted",          bg: "#4C6580", fg: "#FFFFFF" },
  { key: "approved",           label: "Approved",           bg: "#357A55", fg: "#FFFFFF" },
];

export const OPPORTUNITY_PIPELINE_STAGES: StageMeta[] = [
  { key: "application_in",            label: "Application In",            bg: "#4C6580", fg: "#FFFFFF" },
  { key: "shopping",                  label: "Shopping",                  bg: "#416F9C", fg: "#FFFFFF" },
  { key: "missing_info",              label: "Missing Info",              bg: "#3978BE", fg: "#FFFFFF" },
  { key: "approved",                  label: "Approved",                  bg: "#357A55", fg: "#FFFFFF" },
  { key: "selling",                   label: "Selling",                   bg: "#7057A7", fg: "#FFFFFF" },
  { key: "requested_docs",            label: "Requested Docs",            bg: "#9B7635", fg: "#FFFFFF" },
  { key: "docs_out",                  label: "Docs Out",                  bg: "#2E8392", fg: "#FFFFFF" },
  { key: "login",                     label: "Login",                     bg: "#566173", fg: "#FFFFFF" },
  { key: "funded",                    label: "Funded",                    bg: "#32876B", fg: "#FFFFFF" },
  { key: "follow_ups",                label: "Follow Ups",                bg: "#C0842F", fg: "#FFFFFF" },
  { key: "declined",                  label: "Declined",                  bg: "#9B3D45", fg: "#FFFFFF" },
  { key: "dead_file",                 label: "Dead",                      bg: "#6F2D34", fg: "#FFFFFF" },
  { key: "submitted_to_underwriting", label: "Submitted To Underwriting", bg: "#556B86", fg: "#FFFFFF" },
  { key: "approved_open_offers",      label: "Approved Open Offers",      bg: "#2E8C67", fg: "#FFFFFF" },
  { key: "contracts_ordered",         label: "Contracts Ordered",         bg: "#A1762C", fg: "#FFFFFF" },
  { key: "approved_never_funded",     label: "Approved Never Funded",     bg: "#A35F2B", fg: "#FFFFFF" },
  { key: "no_offers_available",       label: "No Offers Available",       bg: "#5D6470", fg: "#FFFFFF" },
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
