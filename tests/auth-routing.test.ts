import assert from "node:assert/strict";
import {
  homePathForTenant,
  normalizePostLoginRedirect,
} from "@/lib/auth-routing";

assert.equal(
  normalizePostLoginRedirect("/t/sun/leads", {
    tenantSlug: "oasis-ai-cc",
    commandCenterProfileSlug: "oasis-ai-cc",
  }),
  "/",
  "OASIS users must not be dropped into SunBiz after login",
);

assert.equal(
  normalizePostLoginRedirect("/t/sun/leads", {
    tenantSlug: "submissions",
    commandCenterProfileSlug: "sun",
  }),
  "/t/sun/leads",
  "SunBiz users can keep their own tenant deep link",
);

assert.equal(
  normalizePostLoginRedirect("/pipeline", {
    tenantSlug: "oasis-ai-cc",
    commandCenterProfileSlug: "oasis-ai-cc",
  }),
  "/pipeline",
  "Non-tenant app links should survive login",
);

assert.equal(
  normalizePostLoginRedirect("https://evil.example/t/sun", {
    tenantSlug: "oasis-ai-cc",
    commandCenterProfileSlug: "oasis-ai-cc",
  }),
  "/",
  "External redirects are rejected",
);

assert.equal(
  normalizePostLoginRedirect("/login?next=/t/sun", {
    tenantSlug: "oasis-ai-cc",
    commandCenterProfileSlug: "oasis-ai-cc",
  }),
  "/",
  "Login loops are rejected",
);

assert.equal(
  normalizePostLoginRedirect("/demo/sun", {
    tenantSlug: "oasis-ai-cc",
    commandCenterProfileSlug: "oasis-ai-cc",
  }),
  "/",
  "Authenticated login should not land on the public demo shell",
);

assert.equal(homePathForTenant({ commandCenterProfileSlug: "sun" }), "/t/sun");
assert.equal(homePathForTenant({ commandCenterProfileSlug: "oasis-ai-cc" }), "/");

// Fresh-session landing (CC 2026-06-17): a SunBiz member who logs in with no
// explicit ?next= (so next="/") must land DETERMINISTICALLY on their tenant
// dashboard, not on "/" (which double-hops through app/page.tsx and was
// surfacing the chat-first /reasoning view). Operators + other tenants still
// resolve to "/".
assert.equal(
  normalizePostLoginRedirect("/", {
    tenantSlug: "submissions",
    commandCenterProfileSlug: "sun",
    isEmpireOperator: false,
  }),
  "/t/sun",
  "Fresh SunBiz member login (no ?next=) lands on the dashboard",
);
assert.equal(
  normalizePostLoginRedirect("/", {
    tenantSlug: "suga-tenant",
    commandCenterProfileSlug: "suga",
    isEmpireOperator: false,
  }),
  "/t/suga",
  "Fresh suga member login (no ?next=) lands on the suga dashboard",
);
assert.equal(
  normalizePostLoginRedirect("/", {
    tenantSlug: "oasis-ai-cc",
    commandCenterProfileSlug: "oasis-ai-cc",
    isEmpireOperator: false,
  }),
  "/",
  "OASIS member with no ?next= stays on / (their home dashboard)",
);

// Empire-operator chrome-bleed regression (2026-05-24): CC signed in with
// his personal OASIS account and got dropped on /t/sun because his profile
// resolves to the SunBiz tenant (he's the listed operator on that row).
// Empire operators MUST always land on the master dashboard by default —
// they can preview /t/sun manually, but auto-routing them there on every
// login is the bug.
assert.equal(
  homePathForTenant({ commandCenterProfileSlug: "sun", isEmpireOperator: true }),
  "/",
  "Empire operators never auto-route to a tenant shell, even when profile resolves to sun",
);

assert.equal(
  homePathForTenant({ commandCenterProfileSlug: "suga", isEmpireOperator: true }),
  "/",
  "Empire operators never auto-route to suga either",
);

assert.equal(
  normalizePostLoginRedirect("/", {
    tenantSlug: "submissions",
    commandCenterProfileSlug: "sun",
    isEmpireOperator: true,
  }),
  "/",
  "Empire operator with no ?next= lands on / even when profile resolves to sun",
);

assert.equal(
  normalizePostLoginRedirect("/t/sun/playbook", {
    tenantSlug: "oasis-ai-cc",
    commandCenterProfileSlug: "oasis-ai-cc",
    isEmpireOperator: true,
  }),
  "/t/sun/playbook",
  "Empire operator can deep-link into any tenant they explicitly request (preview)",
);

assert.equal(
  normalizePostLoginRedirect("/t/sun/leads", {
    tenantSlug: "submissions",
    commandCenterProfileSlug: "sun",
    isEmpireOperator: false,
  }),
  "/t/sun/leads",
  "Real SunBiz tenant user keeps deep link (non-operator path still works)",
);

// Cross-tenant leak regression (CC 2026-06-30): a SunBiz member deep-linked to
// a BARE global app page — the exact case /welcome's old ?next=/agents produced
// — must be pinned to their tenant home, NOT dropped on the OASIS /agents
// operator surface (which showed "bridge not connected"). Operators keep the
// global surface; OASIS members keep bare paths.
assert.equal(
  normalizePostLoginRedirect("/agents", {
    tenantSlug: "submissions",
    commandCenterProfileSlug: "sun",
    isEmpireOperator: false,
  }),
  "/t/sun",
  "SunBiz member deep-linked to a bare global page (e.g. /agents) lands on their tenant home, not the OASIS surface",
);
assert.equal(
  normalizePostLoginRedirect("/agents", {
    tenantSlug: "oasis-ai-cc",
    commandCenterProfileSlug: "oasis-ai-cc",
    isEmpireOperator: false,
  }),
  "/agents",
  "OASIS member keeps the bare global app page (they own the global surface)",
);
assert.equal(
  normalizePostLoginRedirect("/agents", {
    tenantSlug: "submissions",
    commandCenterProfileSlug: "sun",
    isEmpireOperator: true,
  }),
  "/agents",
  "Empire operator can deep-link into any global surface, even when profile resolves to sun",
);

// ===========================================================================
// Orphan-recovery regression (2026-05-29)
//
// SunBiz incident: alex@/jordan@sunbizfunding.com both completed signup
// but their invite-redemption silently failed in finalize-invite-signup.
// Symptom: every API call returned 401 "unauthorized" because their
// user_profiles row had NULL tenant_id, and getSessionContext() returns
// null in that state. The fix is in resolvePostLoginRedirect — when a
// signed-in user is detected as orphaned and has an active invite
// pinned to their email, auto-redeem and re-fetch the profile.
//
// The test exercises resolvePostLoginRedirect against a mock client so
// the contract is regression-locked: orphan + active invite → redeem
// fires → profile attaches → tenant-routing path is returned. Without
// the recovery the path would fall through to "/onboarding/welcome",
// which is the OLD broken behavior we want to surface if the fix
// ever silently regresses.
// ===========================================================================
import { resolvePostLoginRedirect } from "@/lib/auth-routing";
import type { SupabaseClient } from "@supabase/supabase-js";

type Stub = {
  profilesByAttempt: Array<Array<Record<string, unknown>>>;
  inviteRows: Array<Record<string, unknown>>;
  redeemResult: { ok: boolean; tenant_id?: string; team_role?: string };
  tenantRow: Record<string, unknown> | null;
  redeemCalls: Array<Record<string, unknown>>;
};

function makeMockSupabaseClient(stub: Stub): SupabaseClient {
  let profileFetchCount = 0;
  return {
    from(table: string) {
      const resolveQuery = (): { data: Array<Record<string, unknown>> } => {
        if (table === "user_profiles") {
          const data = stub.profilesByAttempt[profileFetchCount] || [];
          profileFetchCount += 1;
          return { data };
        }
        if (table === "tenant_invites") {
          return { data: stub.inviteRows };
        }
        return { data: [] };
      };
      // The query builder must be both chainable AND awaitable. We hand
      // back a Proxy that forwards every method call back to itself, then
      // resolves to the canned data when the caller awaits it (via
      // `then`) or calls `maybeSingle()`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === "then") {
              return (
                onfulfilled: (v: { data: Array<Record<string, unknown>> }) => unknown,
              ) => Promise.resolve(resolveQuery()).then(onfulfilled);
            }
            if (prop === "maybeSingle") {
              return () => {
                if (table === "tenants") {
                  return Promise.resolve({ data: stub.tenantRow });
                }
                const result = resolveQuery();
                return Promise.resolve({ data: result.data[0] ?? null });
              };
            }
            return (..._args: unknown[]) => chain;
          },
        },
      );
      return chain;
    },
    rpc(_fn: string, params: Record<string, unknown>) {
      stub.redeemCalls.push(params);
      return Promise.resolve({ data: stub.redeemResult, error: null });
    },
  } as unknown as SupabaseClient;
}

// Case A: orphan + pinned invite → recovery runs, tenant path returned.
// fetchProfileRows queries user_profiles by auth_user_id first; if 0 rows
// AND email is provided, it falls back to a by-email query. So each
// fetchProfileRows invocation consumes up-to-two mock calls. The initial
// fetch + 250ms retry both miss → 4 empty calls. After recovery, the
// re-fetch finds the row by auth_user_id → 5th call returns the profile.
async function testOrphanRecoveryHappyPath() {
  const stub: Stub = {
    profilesByAttempt: [
      [], [], // 1st fetchProfileRows: auth+email both miss
      [], [], // 250ms retry: still both miss
      [       // post-recovery refetch by auth_user_id: row present
        {
          id: "p1",
          email: "alex@sunbizfunding.com",
          tenant_id: "sunbiz-uuid",
          brand: "SunBiz Funding",
          primary_agent: "solara",
          is_owner: false,
          onboarding_completed_at: null,
          created_at: null,
          updated_at: null,
        },
      ],
    ],
    inviteRows: [{ token_hash: "abc123hash", created_at: "2026-05-27T00:00:00Z" }],
    redeemResult: { ok: true, tenant_id: "sunbiz-uuid", team_role: "member" },
    tenantRow: { slug: "submissions", custom_fields: { command_center_profile_slug: "sun" } },
    redeemCalls: [],
  };

  const path = await resolvePostLoginRedirect({
    db: makeMockSupabaseClient(stub),
    authUserId: "auth-orphan-uuid",
    email: "alex@sunbizfunding.com",
    requestedNext: "/",
  });

  assert.equal(stub.redeemCalls.length, 1, "redeem RPC must fire once for orphan with invite");
  assert.equal(
    stub.redeemCalls[0]?.p_token_hash,
    "abc123hash",
    "redeem RPC must receive the invite's token_hash",
  );
  // The exact post-recovery path is governed by normalizePostLoginRedirect
  // (already covered by the tests above). The orphan-recovery contract
  // is just: do not dump the user at /onboarding/welcome — they have a
  // real tenant attachment now and should be routed by the normal rules.
  assert.notEqual(
    path,
    "/onboarding/welcome",
    "Recovered orphan must not land on the wizard — they have a tenant now",
  );
}

// Case B: orphan with NO active invite → no recovery, falls through to wizard.
async function testOrphanNoInviteFallthrough() {
  const stub: Stub = {
    // 4 empty calls (initial + retry, each doing auth+email lookups)
    profilesByAttempt: [[], [], [], []],
    inviteRows: [],
    redeemResult: { ok: false },
    tenantRow: null,
    redeemCalls: [],
  };

  const path = await resolvePostLoginRedirect({
    db: makeMockSupabaseClient(stub),
    authUserId: "lonely-auth-uuid",
    email: "stranger@example.com",
    requestedNext: "/",
  });

  assert.equal(stub.redeemCalls.length, 0, "redeem RPC must NOT fire when no invite exists");
  assert.equal(
    path,
    "/onboarding/welcome",
    "Orphan with no invite still gets the welcome wizard (unchanged legacy behavior)",
  );
}

(async () => {
  await testOrphanRecoveryHappyPath();
  await testOrphanNoInviteFallthrough();
  console.log("Auth routing tests passed");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
