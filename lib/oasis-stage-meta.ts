/**
 * Stage metadata for the OASIS tenant — colors + display labels for the
 * Lead Pipeline rail. Mirrors lib/sunbiz-stage-meta.ts in shape (same
 * StageMeta type) but covers the AI-agency client lifecycle rather than
 * the funding/lender funnel.
 *
 * Fourteen stages (Website Sales Engine v2), in canonical order:
 *   researched → assigned → attempting_contact → connected → qualified →
 *   founder_meeting_booked → demo_completed → proposal_sent → won | lost →
 *   onboarding → in_build → client_review → launched
 *
 * Palette principles (consistent with lib/sunbiz-stage-meta.ts):
 *   - Lower saturation than Salesforce Lightning; readable on bg-bg-deep.
 *   - Cool blues for upper-funnel (no commitment yet).
 *   - Warmer / purple-leaning hues for active deal motion.
 *   - Amber for the delivery build-out (onboarding / in_build).
 *   - Green for the goal states (won / launched).
 *   - Wine / rose for the dead branch (lost).
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
  { key: "researched", label: "Researched", bg: "#5E6B82", fg: "#FFFFFF" },
  { key: "assigned", label: "Assigned", bg: "#466A99", fg: "#FFFFFF" },
  { key: "attempting_contact", label: "Attempting Contact", bg: "#3978BE", fg: "#FFFFFF" },
  { key: "connected", label: "Connected", bg: "#2B7C8A", fg: "#FFFFFF" },
  { key: "qualified", label: "Qualified", bg: "#2C8372", fg: "#FFFFFF" },
  { key: "founder_meeting_booked", label: "Founder Meeting", bg: "#5167B0", fg: "#FFFFFF" },
  { key: "demo_completed", label: "Demo Complete", bg: "#6559A8", fg: "#FFFFFF" },
  { key: "proposal_sent", label: "Proposal Sent", bg: "#7057A7", fg: "#FFFFFF" },
  { key: "won", label: "Won", bg: "#357A55", fg: "#FFFFFF" },
  { key: "lost", label: "Lost", bg: "#6F2D34", fg: "#FFFFFF" },
  { key: "onboarding", label: "Onboarding", bg: "#996925", fg: "#FFFFFF" },
  { key: "in_build", label: "In Build", bg: "#8A6A25", fg: "#FFFFFF" },
  { key: "client_review", label: "Client Review", bg: "#44756B", fg: "#FFFFFF" },
  { key: "launched", label: "Launched", bg: "#286B48", fg: "#FFFFFF" },
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
  researched: "text-fg-dim",
  assigned: "text-status-info",
  attempting_contact: "text-status-info",
  connected: "text-status-info",
  qualified:     "text-status-engaged",
  founder_meeting_booked: "text-accent",
  demo_completed: "text-accent",
  proposal_sent: "text-accent",
  won: "text-status-engaged",
  lost: "text-status-warm",
  onboarding:    "text-status-warm",
  in_build: "text-status-warm",
  client_review: "text-status-engaged",
  launched: "text-status-engaged",
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
