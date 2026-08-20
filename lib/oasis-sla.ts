/**
 * lib/oasis-sla.ts — per-stage SLA windows + helpers for the OASIS
 * lead pipeline view.
 *
 * Mirrors lib/sunbiz-sla.ts in shape so the shared pipeline component
 * (components/manifest/LeadPipelineView.tsx) can switch between
 * tenants by swapping which config it reads. The constants below are
 * tuned for the 14-stage Website Sales Engine lifecycle
 * (lib/oasis-stage-meta.ts):
 *
 *   researched             - 2d  (assign it or drop it)
 *   assigned               - 1d  (rep should start dialing same/next day)
 *   attempting_contact     - 3d  (dial cycle before the lead goes cold)
 *   connected              - 2d  (qualify while the conversation is warm)
 *   qualified              - 2d  (book the founder meeting NOW)
 *   founder_meeting_booked - 5d  (meeting should happen within the week)
 *   demo_completed         - 2d  (proposal goes out fast after the demo)
 *   proposal_sent          - 3d  (follow up before it goes stale)
 *   won                    - 999 (no SLA — payment collected, kickoff owns it)
 *   lost                   - 999 (terminal)
 *   onboarding             - 7d  (assets + access collected)
 *   in_build               - 21d (build window)
 *   client_review          - 5d  (chase approval)
 *   launched               - 999 (terminal — live site, no clock)
 *
 * "No SLA" is expressed as 999, NOT null/omission: consumers type this
 * as Record<string, number>, LeadPipelineView.slaDaysForVariant falls
 * back to `?? 7` on a missing key (which would put a phantom 7d clock
 * on won/lost/launched), and both render sites treat `>= 999` as the
 * terminal sentinel. Keep the sentinel.
 *
 * Tunable later via a manifest entry per tenant; v2 values from the
 * Website Sales Engine v2 operating contract.
 */

export const OASIS_STAGE_SLA_DAYS: Record<string, number> = {
  researched: 2,
  assigned: 1,
  attempting_contact: 3,
  connected: 2,
  qualified: 2,
  founder_meeting_booked: 5,
  demo_completed: 2,
  proposal_sent: 3,
  won: 999,
  lost: 999,
  onboarding: 7,
  in_build: 21,
  client_review: 5,
  launched: 999,
};

/** Stages an "active" OASIS lead can be in. Excludes terminal stages
 *  (lost, launched). `won` counts as active — the deal is live business
 *  in transition to delivery — but carries no SLA clock. */
export const OASIS_ACTIVE_STAGES = new Set<string>([
  "researched",
  "assigned",
  "attempting_contact",
  "connected",
  "qualified",
  "founder_meeting_booked",
  "demo_completed",
  "proposal_sent",
  "won",
  "onboarding",
  "in_build",
  "client_review",
]);

/** Stages that should show a "Xd target" badge in the collapsible
 *  section header. Excludes terminal + no-clock stages where a target
 *  number reads as noise. */
export const OASIS_VISIBLE_TARGET_STAGES = new Set<string>([
  "researched",
  "assigned",
  "attempting_contact",
  "connected",
  "qualified",
  "founder_meeting_booked",
  "demo_completed",
  "proposal_sent",
  "onboarding",
  "in_build",
  "client_review",
]);

/** Stages where the operator should be advancing the deal NOW. Used
 *  for the "X ready to advance" counter in the header. */
export const OASIS_READY_TO_ADVANCE_STAGES = new Set<string>([
  "qualified",      // ready to book the founder meeting
  "demo_completed", // ready to send the proposal
  "proposal_sent",  // ready to close / collect the deposit
  "won",            // ready to kick off onboarding
  "client_review",  // ready to launch
]);
