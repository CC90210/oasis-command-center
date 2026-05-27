import assert from "node:assert/strict";
import { inviteEmailMatchesUser } from "@/lib/team";

assert.equal(
  inviteEmailMatchesUser("emliy@sunbizfunding.com", "emliy@sunbizfunding.com"),
  true,
  "exact pinned invite email should match",
);

assert.equal(
  inviteEmailMatchesUser("EMLIY@sunbizfunding.com", "emliy@sunbizfunding.com"),
  true,
  "pinned invite email match should be case-insensitive",
);

assert.equal(
  inviteEmailMatchesUser(null, "jordan@sunbizfunding.com"),
  true,
  "open invites without a pinned email remain redeemable",
);

assert.equal(
  inviteEmailMatchesUser("alex@sunbizfunding.com", "jordan@sunbizfunding.com"),
  false,
  "pinned invite must not be redeemable by a different signed-in email",
);

console.log("Team invite tests passed");
