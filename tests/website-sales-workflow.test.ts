import assert from "node:assert/strict";
import {
  OASIS_WEBSITE_TENANT_SLUG,
  dispositionPatch,
  mayAgentQualify,
  mayAgentBookFounder,
  mayCloseWebsiteDeal,
  mayCreditAdminVerifiedCloser,
  mayRecordDisposition,
  maySendWebsiteProposal,
  mayUseDirectAdvance,
  mayWorkWebsiteSalesLifecycle,
  nextOasisLifecycleStage,
  resolveWebsiteSalesHandoffRep,
  resolveWebsiteSalesCloseParties,
} from "../lib/website-sales-workflow";

assert.equal(OASIS_WEBSITE_TENANT_SLUG, "oasis-webdev");
assert.equal(mayAgentQualify("connected"), true);
assert.equal(mayAgentQualify("assigned"), false);
assert.equal(mayAgentBookFounder("qualified"), true);
assert.equal(mayAgentBookFounder("connected"), false);
for (const stage of ["assigned", "attempting_contact", "connected"]) {
  assert.equal(
    mayAgentBookFounder(stage, true),
    true,
    `${stage} may book only when the same request carries complete qualification facts`,
  );
}
assert.equal(mayAgentBookFounder("researched", true), false);
assert.equal(mayAgentBookFounder("founder_meeting_booked", true), false);

assert.equal(nextOasisLifecycleStage("assigned"), "attempting_contact");
assert.equal(nextOasisLifecycleStage("attempting_contact"), "connected");
assert.equal(nextOasisLifecycleStage("connected"), "qualified");
assert.equal(nextOasisLifecycleStage("qualified"), "founder_meeting_booked");
assert.equal(nextOasisLifecycleStage("founder_meeting_booked"), "demo_completed");
assert.equal(nextOasisLifecycleStage("demo_completed"), "proposal_sent");
assert.equal(nextOasisLifecycleStage("proposal_sent"), "won");
assert.equal(nextOasisLifecycleStage("won"), "onboarding");
assert.equal(nextOasisLifecycleStage("onboarding"), "in_build");
assert.equal(nextOasisLifecycleStage("in_build"), "client_review");
assert.equal(nextOasisLifecycleStage("client_review"), "launched");
assert.equal(nextOasisLifecycleStage("lost"), null);
assert.equal(nextOasisLifecycleStage("launched"), null);
assert.equal(nextOasisLifecycleStage("garbage"), null);

assert.equal(mayUseDirectAdvance("assigned", false), true, "rep may start outreach");
assert.equal(
  mayUseDirectAdvance("founder_meeting_booked", false, true),
  false,
  "the audit cannot finish without a structured builder brief",
);
assert.equal(
  mayUseDirectAdvance("won", false, true),
  false,
  "deal authority does not grant delivery-stage administration",
);
assert.equal(mayUseDirectAdvance("attempting_contact", false), false, "rep must record the call result");
assert.equal(mayUseDirectAdvance("connected", true), false, "qualification gates cannot be skipped");
assert.equal(mayUseDirectAdvance("demo_completed", true), false, "proposal terms cannot be skipped");
assert.equal(mayUseDirectAdvance("proposal_sent", true), false, "deal close RPC cannot be skipped");
for (const stage of ["assigned", "won", "onboarding", "in_build", "client_review"]) {
  assert.equal(mayUseDirectAdvance(stage, true), true, `${stage} is a safe direct lifecycle edge for an admin`);
}

assert.equal(maySendWebsiteProposal("demo_completed"), true);
assert.equal(maySendWebsiteProposal("founder_meeting_booked"), false);
assert.equal(mayCloseWebsiteDeal("proposal_sent"), true);
assert.equal(mayCloseWebsiteDeal("demo_completed"), false);

assert.equal(mayWorkWebsiteSalesLifecycle("agent"), true);
assert.equal(mayWorkWebsiteSalesLifecycle("opener"), true);
assert.equal(mayWorkWebsiteSalesLifecycle("closer"), true);
assert.equal(mayWorkWebsiteSalesLifecycle("manager"), true);
assert.equal(mayWorkWebsiteSalesLifecycle("marketing"), false);
assert.equal(mayWorkWebsiteSalesLifecycle("read_only"), false);
assert.equal(mayWorkWebsiteSalesLifecycle("marketing", true), true, "an explicit admin grant can operate the lifecycle");

assert.deepEqual(
  resolveWebsiteSalesCloseParties({
    assignedTo: "22222222-2222-4222-8222-222222222222",
    attributedRepUserId: "11111111-1111-4111-8111-111111111111",
    actorUserId: "22222222-2222-4222-8222-222222222222",
    isTrueAdmin: false,
  }),
  {
    closerUserId: "22222222-2222-4222-8222-222222222222",
    openerUserId: "11111111-1111-4111-8111-111111111111",
    closedByRep: true,
  },
  "a closer must close as the paid closer while the frozen attributed rep remains the opener",
);
assert.deepEqual(
  resolveWebsiteSalesCloseParties({
    assignedTo: "22222222-2222-4222-8222-222222222222",
    attributedRepUserId: "11111111-1111-4111-8111-111111111111",
    actorUserId: "99999999-9999-4999-8999-999999999999",
    isTrueAdmin: true,
  }),
  {
    closerUserId: "11111111-1111-4111-8111-111111111111",
    openerUserId: null,
    closedByRep: false,
  },
  "a founder close pays the frozen opener instead of overpaying an assigned rep as a closer",
);
assert.deepEqual(
  resolveWebsiteSalesCloseParties({
    assignedTo: "22222222-2222-4222-8222-222222222222",
    attributedRepUserId: "11111111-1111-4111-8111-111111111111",
    actorUserId: "99999999-9999-4999-8999-999999999999",
    isTrueAdmin: true,
    trustedCloserUserId: "22222222-2222-4222-8222-222222222222",
  }),
  {
    closerUserId: "22222222-2222-4222-8222-222222222222",
    openerUserId: "11111111-1111-4111-8111-111111111111",
    closedByRep: true,
  },
  "a founder verifying payment must preserve both the frozen opener and a separately validated closer",
);
assert.deepEqual(
  resolveWebsiteSalesCloseParties({
    assignedTo: "11111111-1111-4111-8111-111111111111",
    attributedRepUserId: "11111111-1111-4111-8111-111111111111",
    actorUserId: "99999999-9999-4999-8999-999999999999",
    isTrueAdmin: true,
    trustedCloserUserId: "11111111-1111-4111-8111-111111111111",
  }),
  {
    closerUserId: "11111111-1111-4111-8111-111111111111",
    openerUserId: null,
    closedByRep: false,
  },
  "an admin cannot relabel the frozen opener as a distinct closer without independent closer evidence",
);
assert.equal(
  mayCreditAdminVerifiedCloser({
    candidateUserId: "22222222-2222-4222-8222-222222222222",
    frozenOpenerUserId: "11111111-1111-4111-8111-111111111111",
    auditHostUserId: "22222222-2222-4222-8222-222222222222",
    assignedTo: "99999999-9999-4999-8999-999999999999",
    recordedAuditHostRole: "closer",
    liveTeamRole: "closer",
    isOwner: false,
  }),
  true,
  "a distinct booked audit host with a live closer profile earns closer credit when a founder verifies payment",
);
assert.equal(
  mayCreditAdminVerifiedCloser({
    candidateUserId: "22222222-2222-4222-8222-222222222222",
    frozenOpenerUserId: "11111111-1111-4111-8111-111111111111",
    auditHostUserId: null,
    assignedTo: "22222222-2222-4222-8222-222222222222",
    recordedAuditHostRole: null,
    liveTeamRole: "agent",
    isOwner: false,
  }),
  true,
  "current assignment plus a tenant-scoped legacy agent profile is equivalent trusted closer evidence",
);
for (const untrusted of [
  { liveTeamRole: "opener", isOwner: false },
  { liveTeamRole: "closer", isOwner: true },
] as const) {
  assert.equal(
    mayCreditAdminVerifiedCloser({
      candidateUserId: "22222222-2222-4222-8222-222222222222",
      frozenOpenerUserId: "11111111-1111-4111-8111-111111111111",
      auditHostUserId: "22222222-2222-4222-8222-222222222222",
      assignedTo: "22222222-2222-4222-8222-222222222222",
      recordedAuditHostRole: "closer",
      ...untrusted,
    }),
    false,
    "an opener-only profile or tenant owner cannot be silently relabelled as the paid closer",
  );
}
assert.equal(
  resolveWebsiteSalesCloseParties({
    assignedTo: "22222222-2222-4222-8222-222222222222",
    attributedRepUserId: null,
    actorUserId: "33333333-3333-4333-8333-333333333333",
    isTrueAdmin: false,
  }),
  null,
  "an unrelated rep can never manufacture close attribution",
);
assert.equal(
  resolveWebsiteSalesHandoffRep(
    null,
    "22222222-2222-4222-8222-222222222222",
    "99999999-9999-4999-8999-999999999999",
  ),
  "22222222-2222-4222-8222-222222222222",
  "an admin booking on behalf of an assigned rep must not freeze attribution to the admin",
);
assert.equal(
  resolveWebsiteSalesHandoffRep(
    "not-a-user-id",
    "22222222-2222-4222-8222-222222222222",
    "99999999-9999-4999-8999-999999999999",
  ),
  "22222222-2222-4222-8222-222222222222",
  "malformed legacy attribution falls through to the valid assigned rep",
);

assert.equal(mayRecordDisposition("assigned", "attempted"), true);
assert.equal(mayRecordDisposition("attempting_contact", "voicemail"), true);
assert.equal(mayRecordDisposition("attempting_contact", "connected"), true);
assert.equal(mayRecordDisposition("qualified", "attempted"), false, "a stale call action cannot regress a qualified lead");
assert.equal(mayRecordDisposition("connected", "lost"), true);
assert.equal(mayRecordDisposition("qualified", "lost"), true);
assert.equal(mayRecordDisposition("founder_meeting_booked", "lost"), false);

const voicemail = dispositionPatch("voicemail", "2026-09-01T15:00:00.000Z", "2026-08-19T15:00:00.000Z");
assert.deepEqual(voicemail, {
  stage: "attempting_contact",
  last_disposition: "voicemail",
  last_contact_at: "2026-08-19T15:00:00.000Z",
  last_contacted_at: "2026-08-19T15:00:00.000Z",
  last_call_at: "2026-08-19T15:00:00.000Z",
  next_action_at: "2026-09-01T15:00:00.000Z",
});
assert.throws(() => dispositionPatch("voicemail", null, "2026-08-19T15:00:00.000Z"), /next_action_required/);
assert.throws(() => dispositionPatch("voicemail", "2026-08-18T15:00:00.000Z", "2026-08-19T15:00:00.000Z"), /next_action_must_be_in_future/);
assert.equal(dispositionPatch("connected", null, "2026-08-19T15:00:00.000Z").stage, "connected");
assert.throws(() => dispositionPatch("lost", null, "2026-08-19T15:00:00.000Z", ""), /loss_reason_required/);
assert.equal(dispositionPatch("lost", null, "2026-08-19T15:00:00.000Z", "No budget").loss_reason, "No budget");
assert.equal(dispositionPatch("lost", null, "2026-08-19T15:00:00.000Z", "  No budget  ").loss_reason, "No budget");
assert.throws(
  () => dispositionPatch("lost", null, "2026-08-19T15:00:00.000Z", "x".repeat(501)),
  /loss_reason_too_long/,
);

console.log("website sales workflow: ok");
