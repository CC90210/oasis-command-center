/**
 * Stage metadata for the OASIS tenant — colors + display labels for the
 * Lead Pipeline rail. Mirrors lib/sunbiz-stage-meta.ts in shape (same
 * StageMeta type) but covers the AI-agency client lifecycle rather than
 * the funding/lender funnel.
 *
 * Eleven stages, in canonical order:
 *   new_contact   → outreach   → discovery   → qualified  → proposal →
 *   negotiation   → onboarding → active_client → churned  → lost     →
 *   archived
 *
 * Palette principles (consistent with lib/sunbiz-stage-meta.ts):
 *   - Lower saturation than Salesforce Lightning; readable on bg-bg-deep.
 *   - Cool blues for upper-funnel (no commitment yet).
 *   - Warmer / purple-leaning hues for active deal motion.
 *   - Amber for onboarding (the "in transition" period).
 *   - Green only for active_client (the goal state).
 *   - Wine / rose for the dead branches (churned / lost).
 *   - Slate for archived (permanently inactive).
 *
 * Imported by lib/manifest/seeds.ts → OASIS_SEED.data_model.lead.stages
 * (which lists the keys only) and by components/manifest/StageRail.tsx
 * (which reads the StageMeta list to render the chevron-bar).
 */

import type { StageMeta } from "./sunbiz-stage-meta";

export type { StageMeta };

// Palette is tuned so every stage chip clears WCAG AA contrast (>=4.5:1
// for normal text against white). Three stages were darkened from the
// initial palette during the V6.9 ribbon-pass contrast audit:
//   discovery  #2E8392 → #2B7C8A  (was 4.40:1, now 4.82:1)
//   qualified  #2F8A78 → #2C8372  (was 4.18:1, now 4.57:1)
//   onboarding #C0842F → #996925  (was 3.19:1, now 4.77:1)
// Lowest contrast in the set is now ~4.5:1 (outreach), highest is ~10:1
// (lost). Recompute with scripts/audit_contrast.py before adjusting.
export const OASIS_LEAD_STAGES: StageMeta[] = [
  { key: "new_contact",   label: "New Contact",   bg: "#5E6B82", fg: "#FFFFFF" },
  { key: "outreach",      label: "Outreach",      bg: "#3978BE", fg: "#FFFFFF" },
  { key: "discovery",     label: "Discovery",     bg: "#2B7C8A", fg: "#FFFFFF" },
  { key: "qualified",     label: "Qualified",     bg: "#2C8372", fg: "#FFFFFF" },
  { key: "proposal",      label: "Proposal",      bg: "#5167B0", fg: "#FFFFFF" },
  { key: "negotiation",   label: "Negotiation",   bg: "#7057A7", fg: "#FFFFFF" },
  { key: "onboarding",    label: "Onboarding",    bg: "#996925", fg: "#FFFFFF" },
  { key: "active_client", label: "Active Client", bg: "#357A55", fg: "#FFFFFF" },
  { key: "churned",       label: "Churned",       bg: "#9B5566", fg: "#FFFFFF" },
  { key: "lost",          label: "Lost",          bg: "#6F2D34", fg: "#FFFFFF" },
  { key: "archived",      label: "Archived",      bg: "#414957", fg: "#E5E7EB" },
];

export const OASIS_LEAD_STAGE_KEYS = OASIS_LEAD_STAGES.map((s) => s.key);

/**
 * LeadsTableClient stage-tab descriptor for OASIS. Same component
 * Sun Biz's /leads uses; this is the shape it expects for the
 * `stages` prop. Tone classes map per-stage semantics to the
 * dashboard's status palette (engaged / info / warm / fg-dim) so
 * the active-tab text colour reads consistently with the rest of
 * the UI. Imported by app/pipeline/page.tsx + app/leads/page.tsx —
 * single source of truth so the two surfaces can't drift apart.
 */
export type OasisStageTab = { value: string; label: string; tone: string };

const OASIS_STAGE_TONES: Record<string, string> = {
  new_contact:   "text-fg-dim",
  outreach:      "text-status-info",
  discovery:     "text-status-info",
  qualified:     "text-status-engaged",
  proposal:      "text-accent",
  negotiation:   "text-accent",
  onboarding:    "text-status-warm",
  active_client: "text-status-engaged",
  churned:       "text-status-warm",
  lost:          "text-status-warm",
  archived:      "text-fg-dim",
};

export const OASIS_LEAD_STAGE_TABS: OasisStageTab[] = OASIS_LEAD_STAGES.map((s) => ({
  value: s.key,
  label: s.label,
  tone: OASIS_STAGE_TONES[s.key] || "text-fg-muted",
}));

export function getOasisStageMeta(entityName: string): StageMeta[] {
  if (entityName === "lead") return OASIS_LEAD_STAGES;
  // Proposals/clients share the lead stages today (proposal entity is
  // surfaced separately on the Proposals page but uses the same lifecycle
  // metadata until it earns its own dedicated funnel). Anything else
  // returns [] so callers can fall back to a neutral rendering.
  if (entityName === "proposal") return OASIS_LEAD_STAGES;
  return [];
}

export function findOasisStage(entityName: string, key: string): StageMeta | undefined {
  return getOasisStageMeta(entityName).find((s) => s.key === key);
}
