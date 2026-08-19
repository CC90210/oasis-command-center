import assert from "node:assert/strict";
import {
  OASIS_WEBSITE_TENANT_SLUG,
  dispositionPatch,
  mayAgentQualify,
  mayAgentBookFounder,
} from "../lib/website-sales-workflow";

assert.equal(OASIS_WEBSITE_TENANT_SLUG, "oasis-webdev");
assert.equal(mayAgentQualify("connected"), true);
assert.equal(mayAgentQualify("assigned"), false);
assert.equal(mayAgentBookFounder("qualified"), true);
assert.equal(mayAgentBookFounder("connected"), false);

const voicemail = dispositionPatch("voicemail", "2026-09-01T15:00:00.000Z", "2026-08-19T15:00:00.000Z");
assert.deepEqual(voicemail, {
  stage: "attempting_contact",
  last_disposition: "voicemail",
  last_contact_at: "2026-08-19T15:00:00.000Z",
  next_action_at: "2026-09-01T15:00:00.000Z",
});
assert.throws(() => dispositionPatch("voicemail", null, "2026-08-19T15:00:00.000Z"), /next_action_required/);
assert.throws(() => dispositionPatch("voicemail", "2026-08-18T15:00:00.000Z", "2026-08-19T15:00:00.000Z"), /next_action_must_be_in_future/);
assert.equal(dispositionPatch("connected", null, "2026-08-19T15:00:00.000Z").stage, "connected");
assert.throws(() => dispositionPatch("lost", null, "2026-08-19T15:00:00.000Z", ""), /loss_reason_required/);
assert.equal(dispositionPatch("lost", null, "2026-08-19T15:00:00.000Z", "No budget").loss_reason, "No budget");

console.log("website sales workflow: ok");
