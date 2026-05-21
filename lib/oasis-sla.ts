/**
 * lib/oasis-sla.ts — per-stage SLA windows + helpers for the OASIS
 * lead pipeline view.
 *
 * Mirrors lib/sunbiz-sla.ts in shape so the shared pipeline component
 * (components/manifest/SunBizPipelineView.tsx) can switch between
 * tenants by swapping which config it reads. The constants below are
 * tuned for the AI-agency lead lifecycle (lib/oasis-stage-meta.ts):
 *
 *   new_contact   - 2d  (should outreach quickly)
 *   outreach      - 5d  (waiting for first reply)
 *   discovery     - 3d  (call scheduling window)
 *   qualified     - 5d  (proposal prep)
 *   proposal      - 7d  (review time)
 *   negotiation   - 7d  (term discussion)
 *   onboarding    - 14d (delivery work)
 *   active_client - 999 (no SLA, ongoing retainer — terminal in the
 *                        funnel sense)
 *   churned / lost / archived - 999 (terminal)
 *
 * Tunable later via a manifest entry per tenant; v1 values from CC's
 * Adon-team-equivalent OASIS cadence.
 */

export const OASIS_STAGE_SLA_DAYS: Record<string, number> = {
  new_contact: 2,
  outreach: 5,
  discovery: 3,
  qualified: 5,
  proposal: 7,
  negotiation: 7,
  onboarding: 14,
  active_client: 999,
  churned: 999,
  lost: 999,
  archived: 999,
};

/** Stages an "active" OASIS lead can be in. Excludes terminal stages. */
export const OASIS_ACTIVE_STAGES = new Set<string>([
  "new_contact",
  "outreach",
  "discovery",
  "qualified",
  "proposal",
  "negotiation",
  "onboarding",
]);

/** Stages that should show a "Xd target" badge in the collapsible
 *  section header. Excludes terminal + ongoing stages where a target
 *  number reads as noise. */
export const OASIS_VISIBLE_TARGET_STAGES = new Set<string>([
  "new_contact",
  "outreach",
  "discovery",
  "qualified",
  "proposal",
  "negotiation",
  "onboarding",
]);

/** Stages where the operator should be advancing the deal NOW. Used
 *  for the "X ready to advance" counter in the header. */
export const OASIS_READY_TO_ADVANCE_STAGES = new Set<string>([
  "qualified",       // ready to send proposal
  "proposal",        // proposal sent, ready for negotiation
  "negotiation",     // ready to close
  "onboarding",      // ready to kick off as active client
]);
