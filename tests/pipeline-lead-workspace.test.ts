import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PIPELINE_MILESTONES,
  coachingNextStep,
  pipelineMilestoneIndex,
} from "../app/pipeline/[id]/workflow-model";
import { leadFirstTouch } from "../lib/offer-pages/utm";

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

// Line endings are normalised on read. A Windows checkout (core.autocrlf=true)
// has CRLF, so the coaching-branch search below for "\n  }\n\n  return (" found
// nothing and this file failed on every Windows machine while CI passed.
const lifecycle = readFileSync("app/pipeline/[id]/LeadLifecycleActions.tsx", "utf8").replace(/\r\n/g, "\n");
const page = readFileSync("app/pipeline/[id]/page.tsx", "utf8").replace(/\r\n/g, "\n");

assert.match(lifecycle, /<LifecycleProgress activeIndex=\{activeMilestone\}/);
assert.match(lifecycle, /aria-current=\{index === activeIndex \? "step"/);
assert.match(lifecycle, /1 - Place the call/);
assert.match(lifecycle, /2 - Choose one outcome/);
assert.match(lifecycle, /callOutcome === "attempted" \|\| callOutcome === "voicemail"/);
assert.match(lifecycle, /callOutcome === "lost" \? \(/);
assert.doesNotMatch(lifecycle, /role="checkbox"/, "qualification and confirmation use native controls");

for (const step of ["Contact", "Host & time", "Agenda", "Confirm", "Review"]) {
  assert(lifecycle.includes(step), `booking keeps ${step} as a discrete screen`);
}
assert.match(lifecycle, /Create video call invite/);
assert.match(lifecycle, /Create video call & send invite/);
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
assert.match(coachingBranch, /Manager coaching view - read only/);

assert.match(page, /canReadOasisSalesTeamPipeline/);
assert.match(page, /getOasisSalesRepRoster/);
assert.match(page, /readableRepUserIds/);
assert.match(page, /viewerMode=\{managerCoachingView \? "coaching" : "operate"\}/);

// A MANAGER OPERATES THEIR TEAM'S BOOK (2026-09-01).
//
// canMutateOasisSalesRecord answers ownership, and a manager owns nothing --
// they are measured on their reps' deals. So gating the lifecycle purely on
// ownership gave every manager the read-only coaching view on every lead and no
// way to book an audit for the rep they were coaching. On the live tenant both
// managers owned zero leads, so that was their entire pipeline.
assert.match(
  page,
  // The ACTIVE roster (2026-09-24): a deactivated rep's kept deal stays
  // readable (readableRepUserIds) but opens in the coaching view.
  /const managerWorksTeamBook[\s\S]*?activeRepUserIds\.length > 0/,
  "a manager's operate rights must key on the server-resolved active roster, not personal ownership",
);
assert.match(
  page,
  /const canWorkLifecycle =[\s\S]*?managerWorksTeamBook/,
  "managerWorksTeamBook must actually widen canWorkLifecycle, not sit unused",
);
assert.match(
  page,
  /const managerCoachingView =[\s\S]*?!managerWorksTeamBook/,
  "inside their roster a manager operates; coaching is the fallback for leads outside it",
);
// The roster boundary survives the widening: an off-roster assignment must
// still fall through to coaching rather than becoming operable -- and it must
// be decided by the SHARED predicate, not a second inline copy. Two answers to
// "is this seat on my roster" is what put the Leads list and Leads detail out
// of sync; this assertion is what stops that being re-introduced here.
assert.match(
  page,
  /managerWorksTeamBook =[\s\S]*?managerRosterCoversAssignment\(/,
  "roster membership must come from lib/role-surfaces, never be re-derived in the page",
);
assert.doesNotMatch(
  page,
  /readableRepUserIds\.some\(/,
  "a hand-rolled roster comparison here is the drift the shared predicate exists to prevent",
);
assert.doesNotMatch(page, /<LeadActionToolbar/, "the call control appears only inside the single next-step panel");
assert.match(page, /title="Activity and files"[\s\S]*defaultCollapsed/);
for (const label of ["Revenue band", "Team size", "Primary bottleneck", "Current tools"]) {
  assert.match(page, new RegExp(`label="${label}"`), `lead details exposes ${label}`);
}

// A NEW LEAD'S OWN FACTS READ WITHOUT A CLICK (CC 2026-10-16).
//
// They sat in "Lead details", collapsed by default, whose preview was only
// name, company and website. Now: the funnel stage is a chip under the name,
// first touch is a Source block outside the disclosure, and the disclosure
// opens by default under a NEW storage key (an old stored "collapsed" must not
// keep hiding them).
{
  const leadDetails = page.match(/<CollapsibleSection\s+title="Lead details"[\s\S]*?>/)?.[0] || "";
  assert.match(leadDetails, /defaultCollapsed=\{false\}/, "Lead details opens by default");
  assert.match(leadDetails, /storageKey="oasis\.pipeline\.leadDetails\.collapsed"/);
  assert.doesNotMatch(page, /oasis\.pipeline\.contactBand\.collapsed/, "the old key's stored 'collapsed' would still hide the facts");
  const sourceAt = page.indexOf("<LeadSourceBlock data={activeRecord.data} />");
  const detailsAt = page.indexOf('title="Lead details"');
  assert.ok(sourceAt > 0 && sourceAt < detailsAt, "the Source block renders above, not inside, the disclosure");
  assert.match(page, /const facts = leadFirstTouch\(data\);\s*if \(facts\.length === 0\) return null;/, "no first touch, no block");
  assert.match(page, /const funnelStage = funnelStageLabel\(activeRecord\.data\.funnel_stage, leadFunnelForm\(activeRecord\.data\)\);/);
  assert.match(page, /subtitle=\{\s*funnelStage \? \(/, "the chip sits in the header, under the lead's name");
  // Not repeated inside the disclosure once they are shown above it.
  for (const moved of ["Funnel stage", "Campaign", "Keyword", "Offer"]) {
    assert.doesNotMatch(page, new RegExp(`<ContactCell label="${moved}"`), `${moved} is shown above, not again in Lead details`);
  }
  assert.match(page, /<ContactCell label="Website"/, "the website stays in Lead details, now open");
}

{
  // The Source block's facts: only what the lead has, campaign joined, offer named.
  assert.deepEqual(leadFirstTouch({}), [], "a lead with no first touch gets no labels at all");
  assert.deepEqual(leadFirstTouch({ utm_source: " ", kw: "", cat: "" }), [], "blank values are missing values");
  assert.deepEqual(
    leadFirstTouch({ utm_source: "facebook", utm_medium: "paid", utm_campaign: "fall-audit", kw: "ai receptionist", cat: "p2" }),
    [
      { label: "Campaign", value: "facebook / paid / fall-audit" },
      { label: "Keyword", value: "ai receptionist" },
      { label: "Offer", value: "Command" },
    ],
  );
  assert.deepEqual(leadFirstTouch({ utm_campaign: "fall-audit" }), [{ label: "Campaign", value: "fall-audit" }], "whichever exist");
  assert.deepEqual(leadFirstTouch({ kw: "crm", cat: "p9" }), [
    { label: "Keyword", value: "crm" },
    { label: "Offer", value: "p9" },
  ], "an offer outside p1..p4 still shows as stored");
}
assert.match(
  page,
  /\["founder_meeting_booked",[\s\S]*?<HandoffSummary/,
  "a booked lead must expose its verified video call and Calendar receipt before the demo",
);

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
