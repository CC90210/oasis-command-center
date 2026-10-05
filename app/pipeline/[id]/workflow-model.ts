export type PipelineViewerMode = "operate" | "coaching";

export const PIPELINE_MILESTONES = [
  { key: "outreach", label: "Outreach" },
  { key: "qualify", label: "Qualify" },
  { key: "book", label: "Book audit" },
  { key: "close", label: "Close" },
  { key: "deliver", label: "Deliver" },
  { key: "launch", label: "Launch" },
] as const;

const MILESTONE_BY_STAGE: Readonly<Record<string, number>> = {
  researched: 0,
  assigned: 0,
  attempting_contact: 0,
  connected: 1,
  qualified: 2,
  founder_meeting_booked: 2,
  demo_completed: 3,
  proposal_sent: 3,
  won: 4,
  onboarding: 4,
  in_build: 4,
  client_review: 4,
  launched: 5,
  // Closed-lost is terminal, not a return to Outreach. -1 leaves every active
  // milestone dim while the dedicated closed-state message explains the record.
  lost: -1,
};

export function pipelineMilestoneIndex(stage: string): number {
  return MILESTONE_BY_STAGE[stage] ?? 0;
}

export function coachingNextStep(stage: string): string {
  const copy: Readonly<Record<string, string>> = {
    researched: "Assign this lead to a rep before outreach begins.",
    assigned: "The assigned rep needs to place the first call and record one outcome.",
    attempting_contact: "The assigned rep needs to make the scheduled follow-up and record one outcome.",
    connected: "The assigned rep is confirming authority, need, timing, and investment fit.",
    qualified: "The assigned rep needs to complete the founder-audit booking handoff.",
    founder_meeting_booked: "The closer or founder needs to complete the audit or record an exception.",
    demo_completed: "The closer needs to record the approved proposal terms.",
    proposal_sent: "The closer or founder needs to verify collected payment before fulfillment opens.",
    won: "The delivery owner needs to begin onboarding.",
    onboarding: "The delivery owner needs to confirm intake and move the client into build.",
    in_build: "The delivery owner needs to send the finished work to client review.",
    client_review: "The delivery owner needs to confirm the live launch.",
    launched: "The lifecycle is complete. Review the activity log for the final record.",
    lost: "This lead is closed. Review the loss reason and activity before deciding whether to reopen it.",
  };
  return copy[stage] || "Review the current stage and coach the assigned owner on the next recorded action.";
}
