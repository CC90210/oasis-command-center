import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PIPELINE_MILESTONES,
  coachingNextStep,
  pipelineMilestoneIndex,
} from "../app/pipeline/[id]/workflow-model";

assert.equal(PIPELINE_MILESTONES.length, 6, "the lead file uses one six-milestone progress model");
assert.deepEqual(
  PIPELINE_MILESTONES.map((step) => step.label),
  ["Outreach", "Qualify", "Book audit", "Close", "Deliver", "Launch"],
);
for (const [stage, index] of [
  ["assigned", 0],
  ["attempting_contact", 0],
  ["connected", 1],
  ["qualified", 2],
  ["founder_meeting_booked", 2],
  ["proposal_sent", 3],
  ["in_build", 4],
  ["launched", 5],
] as const) {
  assert.equal(pipelineMilestoneIndex(stage), index, `${stage} maps to the correct milestone`);
}
assert.match(coachingNextStep("connected"), /assigned rep/i);

const lifecycle = readFileSync("app/pipeline/[id]/LeadLifecycleActions.tsx", "utf8");
const page = readFileSync("app/pipeline/[id]/page.tsx", "utf8");

assert.match(lifecycle, /<LifecycleProgress activeIndex=\{activeMilestone\}/);
assert.match(lifecycle, /aria-current=\{index === activeIndex \? "step"/);
assert.match(lifecycle, /1 · Place the call/);
assert.match(lifecycle, /2 · Choose one outcome/);
assert.match(lifecycle, /callOutcome === "attempted" \|\| callOutcome === "voicemail"/);
assert.match(lifecycle, /callOutcome === "lost" \? \(/);
assert.doesNotMatch(lifecycle, /role="checkbox"/, "qualification and confirmation use native controls");

for (const step of ["Contact", "Host & time", "Agenda", "Confirm", "Review"]) {
  assert(lifecycle.includes(step), `booking keeps ${step} as a discrete screen`);
}
assert.match(lifecycle, /contactConfirmed &&[\s\S]*clientAgreedToTime &&[\s\S]*handoffComplete/);
for (const inferred of [
  "effectiveContactConfirmed",
  "effectiveClientAgreedToTime",
  "effectiveHandoffComplete",
]) {
  assert(!lifecycle.includes(inferred), `${inferred} cannot silently check a confirmation`);
}

const coachingStart = lifecycle.indexOf('if (viewerMode === "coaching") {');
const coachingEnd = lifecycle.indexOf("\n  }\n\n  return (", coachingStart);
assert(coachingStart >= 0 && coachingEnd > coachingStart, "coaching mode exits before operating controls mount");
const coachingBranch = lifecycle.slice(coachingStart, coachingEnd);
for (const control of ["<button", "<input", "<select", "<textarea"]) {
  assert(!coachingBranch.includes(control), `coaching mode must not mount ${control}`);
}
assert.match(coachingBranch, /Manager coaching view · read only/);

assert.match(page, /canReadOasisSalesTeamPipeline/);
assert.match(page, /getOasisSalesRepRoster/);
assert.match(page, /readableRepUserIds/);
assert.match(page, /viewerMode=\{managerCoachingView \? "coaching" : "operate"\}/);
assert.doesNotMatch(page, /<LeadActionToolbar/, "the call control appears only inside the single next-step panel");
assert.match(page, /title="Activity and files"[\s\S]*defaultCollapsed/);

assert.match(lifecycle, /Call already happened/);
assert.match(lifecycle, /inbound call or a call completed outside the dashboard/);
assert.match(lifecycle, /inbound call or a call completed outside the dashboard[\s\S]{0,900}setCallAccepted\(true\)[\s\S]{0,500}Call already happened/);

const bookedException = lifecycle.match(
  /currentStage === "founder_meeting_booked" && bookedAction === "exception"[\s\S]*?Record outcome/,
)?.[0] || "";
assert.match(
  bookedException,
  /Outcome note[\s\S]*value=\{transitionNote\}[\s\S]*setTransitionNote/,
  "booked follow-up/no-show/reschedule outcomes must expose the note required by the save gate",
);
assert.match(
  lifecycle,
  /instructionFor\(currentStage, canManage \|\| canRunDeal \|\| canRunDelivery\)/,
  "a closer running the booked audit must receive operator copy, not founder-handoff copy",
);
assert.match(
  lifecycle,
  /bookingPanelRef[\s\S]*bookingHasNavigatedRef[\s\S]*bookingPanelRef\.current\?\.focus\(\)/,
  "booking step changes must move keyboard focus to the newly rendered panel",
);
assert.match(
  lifecycle,
  /founderRosterState === "unavailable"[\s\S]*host list could not be loaded/,
  "a failed host lookup must explain why the booking wizard cannot continue",
);
assert.match(
  lifecycle,
  /valid client phone number with 10 to 15 digits/,
  "invalid phone data must have an inline recovery instruction",
);
assert.equal(
  pipelineMilestoneIndex("lost"),
  -1,
  "closed-lost leads must not misleadingly highlight Outreach",
);

console.log("pipeline-lead-workspace: OK");
