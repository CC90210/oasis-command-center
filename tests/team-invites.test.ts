import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  INVITE_TTL_DAYS,
  createInvite,
  inviteEmailMatchesUser,
  normalizeInviteEmail,
} from "@/lib/team";
import {
  INVITABLE_ROLES,
  INVITABLE_ROLE_OPTIONS,
  isInvitableRole,
} from "@/lib/team-roles";

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
  false,
  "legacy open invites must fail closed",
);

assert.equal(
  inviteEmailMatchesUser("alex@sunbizfunding.com", "jordan@sunbizfunding.com"),
  false,
  "pinned invite must not be redeemable by a different signed-in email",
);

assert.equal(normalizeInviteEmail("  David@OasisAI.Work "), "david@oasisai.work");
for (const invalidEmail of [null, undefined, "", "david@", "@oasisai.work", "david oasisai.work"]) {
  assert.equal(
    normalizeInviteEmail(invalidEmail),
    null,
    `${String(invalidEmail)} cannot pin a teammate invite`,
  );
}

// ── the role allowlist is the ONLY thing enforcing the enum ─────────────────
// 2026-08-21: the live Turso user_profiles DDL is `"team_role" TEXT NOT NULL
// DEFAULT 'member'` — no CHECK constraint, and a sqlite_master search finds no
// table constraining team_role anywhere. The user_profiles_team_role_check in
// the legacy Postgres files was never applied to Turso.
//
// So there is no database backstop. If isInvitableRole lets a bad value pass,
// it is written, and nothing downstream objects. These assertions are the
// backstop, which is why they test the REJECT cases as hard as the accepts.
for (const role of INVITABLE_ROLES) {
  assert.equal(isInvitableRole(role), true, `${role} is on the allowlist and must be invitable`);
}

assert.equal(
  isInvitableRole("owner"),
  false,
  "owner must NEVER be invitable — an invite that mints an owner is a privilege-escalation path, " +
    "and with no DB constraint this guard is the only thing standing in the way",
);

for (const notARole of ["", "Admin", "ADMIN", "superuser", "agent ", "read_only "]) {
  assert.equal(
    isInvitableRole(notARole),
    false,
    `"${notARole}" is not an exact allowlist entry and must be rejected — ` +
      "role comparison is exact, never case-folded or trimmed",
  );
}

for (const notAString of [null, undefined, 42, {}, [], true, { value: "admin" }]) {
  assert.equal(
    isInvitableRole(notAString),
    false,
    `${JSON.stringify(notAString) ?? "undefined"} came from untrusted JSON and must be rejected`,
  );
}

// The drift this module exists to prevent: the values the API validates against
// and the options the dropdown renders must be the same set, in the same order.
assert.deepEqual(
  INVITABLE_ROLE_OPTIONS.map((o) => o.value),
  INVITABLE_ROLES,
  "INVITABLE_ROLE_OPTIONS and INVITABLE_ROLES must not drift — they were two " +
    "hand-typed lists before, which is how a role could be offered but not accepted",
);

for (const option of INVITABLE_ROLE_OPTIONS) {
  assert.ok(
    option.label.trim().length > 0,
    `${option.value} needs a human label — the dropdown renders this, and an empty ` +
      "string is an invisible menu row",
  );
}

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
const TENANT_INVITES_REQUIRED = [
  "tenant_id",
  "email",
  "team_role",
  "token_hash",
  "created_by",
  "expires_at",
];

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

  // This guard is below the role/permission layer and therefore protects every
  // caller (owner/admin/member-with-admin-access) even if a request bypasses
  // the browser form. No role can mint an unpinned bearer invite.
  for (const role of ["admin", "opener", "member"] as const) {
    let missingEmail: unknown = null;
    try {
      await createInvite(
        { tenantId: "t-1", role, createdBy: `u-${role}`, email: "" },
        fakeDb,
      );
    } catch (error) {
      missingEmail = error;
    }
    assert.match(
      missingEmail instanceof Error ? missingEmail.message : "",
      /invite_email_required/,
      `${role} cannot create an invite without an email pin`,
    );
  }

  const inviteRoute = readFileSync("app/api/team/invites/route.ts", "utf8");
  assert(
    inviteRoute.includes('return bad(400, "valid teammate email required")'),
    "the HTTP boundary rejects an unpinned invite as a client error",
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
    await createInvite(
      { tenantId: "t-1", role: "member", createdBy: "u-1", email: "x@example.com" },
      brokenDb,
    );
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

