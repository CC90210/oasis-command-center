import assert from "node:assert/strict";
import {
  INVITE_TTL_DAYS,
  buildInviteInsert,
  inviteEmailMatchesUser,
  inviteExpiryFrom,
} from "@/lib/team";

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

/* ------------------------------------------------------------------------- *
 * expires_at regression — "Add team member" was dead from 2026-08-09.
 *
 * Postgres carried DEFAULT now() + interval '7 days' on tenant_invites.expires_at.
 * The Turso port emitted `"expires_at" TEXT NOT NULL` with NO default, and
 * createInvite omitted the column because the database had always supplied it.
 * Every insert then died on `NOT NULL constraint failed:
 * tenant_invites.expires_at`, the route turned that into a 500, and the UI said
 * "Failed to create invite" for four days.
 *
 * These assertions fail if anyone drops expires_at from the payload again. They
 * need no database, which is the point: the old code could only be proven wrong
 * by talking to Turso, so nothing in CI ever did.
 * ------------------------------------------------------------------------- */

const NOW = new Date("2026-08-13T14:00:00.000Z");
const payload = buildInviteInsert({
  tenantId: "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110",
  role: "admin",
  createdBy: "871a3e7e-a49a-4ac4-b44d-b1ad2eb6b7d6",
  email: "shane@sunbizfunding.com",
  tokenHash: "0".repeat(64),
  now: NOW,
});

// Every NOT NULL column on tenant_invites that has no DB default must appear.
for (const column of [
  "tenant_id",
  "team_role",
  "token_hash",
  "created_by",
  "expires_at",
]) {
  assert.ok(
    Object.prototype.hasOwnProperty.call(payload, column),
    `invite insert must supply NOT NULL column "${column}" — the database has no default for it`,
  );
  assert.notEqual(
    payload[column as keyof typeof payload],
    null,
    `invite insert must not send null for NOT NULL column "${column}"`,
  );
}

assert.equal(
  payload.expires_at,
  "2026-08-20T14:00:00.000Z",
  "invite must expire exactly INVITE_TTL_DAYS after creation",
);

assert.ok(
  !Number.isNaN(Date.parse(payload.expires_at)),
  "expires_at must be a parseable timestamp",
);

assert.equal(
  Math.round((Date.parse(inviteExpiryFrom(NOW)) - NOW.getTime()) / 86_400_000),
  INVITE_TTL_DAYS,
  "inviteExpiryFrom must honour INVITE_TTL_DAYS",
);

// listActiveInvites filters with `.gt("expires_at", new Date().toISOString())`,
// a STRING comparison in SQLite. A fresh invite must sort after "now" in plain
// lexicographic order or it is invisible the moment it is created.
assert.ok(
  payload.expires_at > NOW.toISOString(),
  "expires_at must sort lexicographically after now, or the active-invite filter hides it",
);

// An open (unpinned) invite is still legal — email is the one nullable column here.
assert.equal(
  buildInviteInsert({
    tenantId: "t",
    role: "member",
    createdBy: "u",
    tokenHash: "0".repeat(64),
    now: NOW,
  }).email,
  null,
  "an invite with no pinned address stores email as null",
);

console.log("Team invite tests passed");
