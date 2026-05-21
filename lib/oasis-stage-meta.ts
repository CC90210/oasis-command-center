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

export const OASIS_LEAD_STAGES: StageMeta[] = [
  { key: "new_contact",   label: "New Contact",   bg: "#5E6B82", fg: "#FFFFFF" },
  { key: "outreach",      label: "Outreach",      bg: "#3978BE", fg: "#FFFFFF" },
  { key: "discovery",     label: "Discovery",     bg: "#2E8392", fg: "#FFFFFF" },
  { key: "qualified",     label: "Qualified",     bg: "#2F8A78", fg: "#FFFFFF" },
  { key: "proposal",      label: "Proposal",      bg: "#5167B0", fg: "#FFFFFF" },
  { key: "negotiation",   label: "Negotiation",   bg: "#7057A7", fg: "#FFFFFF" },
  { key: "onboarding",    label: "Onboarding",    bg: "#C0842F", fg: "#FFFFFF" },
  { key: "active_client", label: "Active Client", bg: "#357A55", fg: "#FFFFFF" },
  { key: "churned",       label: "Churned",       bg: "#9B5566", fg: "#FFFFFF" },
  { key: "lost",          label: "Lost",          bg: "#6F2D34", fg: "#FFFFFF" },
  { key: "archived",      label: "Archived",      bg: "#414957", fg: "#E5E7EB" },
];

export const OASIS_LEAD_STAGE_KEYS = OASIS_LEAD_STAGES.map((s) => s.key);

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
