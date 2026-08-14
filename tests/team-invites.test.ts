import assert from "node:assert/strict";
import { INVITE_TTL_DAYS, createInvite, inviteEmailMatchesUser } from "@/lib/team";

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

// ── the invite INSERT must satisfy the table's real column contract ──────────
// 2026-08-14, CC: the Team page returned "invite_create_failed" for every invite.
// Cause: `tenant_invites.expires_at` is NOT NULL, its Postgres default
// (now() + interval '7 days') did not survive the Turso port, and createInvite
// relied on that default. Live error, once it was allowed to surface:
//
//   SQLite error: NOT NULL constraint failed: tenant_invites.expires_at
//
// Nothing here could have caught it: this file tested a pure string matcher, and
// the only code that touches the schema had no seam. So the fake below encodes
// the table's ACTUAL required columns — read from the live DDL — and rejects an
// insert that omits one, exactly as the database does.
const TENANT_INVITES_REQUIRED = ["tenant_id", "team_role", "token_hash", "created_by", "expires_at"];

async function insertContractChecks() {
  const seen: Record<string, unknown>[] = [];
  const fakeDb = {
    from(table: string) {
      assert.equal(table, "tenant_invites");
      const api: Record<string, unknown> = {
        insert(row: Record<string, unknown>) {
          const missing = TENANT_INVITES_REQUIRED.filter(
            (c) => row[c] === undefined || row[c] === null,
          );
          assert.deepEqual(
            missing,
            [],
            `insert into tenant_invites omits NOT NULL column(s): ${missing.join(", ")}. ` +
              `The database has no default for these — the insert fails at runtime, in ` +
              `production, and the user sees "invite_create_failed".`,
          );
          seen.push(row);
          return api;
        },
        select: () => api,
        single: () =>
          Promise.resolve({ data: { id: "invite-1", expires_at: seen[0].expires_at }, error: null }),
      };
      return api;
    },
  } as unknown as Parameters<typeof createInvite>[1];

  const out = await createInvite(
    { tenantId: "t-1", role: "member", createdBy: "u-1", email: "x@example.com" },
    fakeDb,
  );

  assert.equal(seen.length, 1, "exactly one insert");
  assert.ok(out.rawToken.length >= 32, "a usable raw token comes back");
  assert.equal(out.id, "invite-1");

  // The token is HASHED at rest — the raw value must never be what we store.
  assert.notEqual(
    seen[0].token_hash,
    out.rawToken,
    "the raw token must never be written to the database",
  );

  // The POLICY itself, pinned as a literal. Deriving `expected` below from
  // INVITE_TTL_DAYS proves the wiring but can never fail — change the constant and
  // both sides move together. Pinning 7 makes a change to the product rule a
  // deliberate act that also updates this line and the copy on app/team/page.tsx.
  assert.equal(
    INVITE_TTL_DAYS,
    7,
    "invites expire after 7 days — that is a product decision; if it really changed, " +
      "update this assertion on purpose",
  );

  // Expiry is the policy in code, not a database default that a migration can drop.
  const expires = new Date(String(seen[0].expires_at)).getTime();
  const expected = Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;
  assert.ok(
    Math.abs(expires - expected) < 60_000,
    `expires_at should be ~${INVITE_TTL_DAYS} days out, got ${seen[0].expires_at}`,
  );

  // A failed insert must carry WHY. Returning the bare code is what turned a
  // one-line schema bug into an opaque screen.
  const brokenDb = {
    from() {
      const api: Record<string, unknown> = {
        insert: () => api,
        select: () => api,
        single: () =>
          Promise.resolve({
            data: null,
            error: { message: "NOT NULL constraint failed: tenant_invites.expires_at", code: "23502" },
          }),
      };
      return api;
    },
  } as unknown as Parameters<typeof createInvite>[1];

  let caught: unknown = null;
  try {
    await createInvite({ tenantId: "t-1", role: "member", createdBy: "u-1" }, brokenDb);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof Error, "createInvite must throw a real Error, not a bare object");
  assert.match(
    (caught as Error).message,
    /NOT NULL constraint failed/,
    "the thrown error must carry the database's reason — the API route reads .message, " +
      "and a plain PostgREST object would fall through to the generic string",
  );
}

insertContractChecks().then(
  () => console.log("Team invite tests passed"),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

