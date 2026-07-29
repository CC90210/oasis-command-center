/**
 * active-profile — which user_profiles row wins when an auth account has several.
 *
 * This is an AUTHORIZATION tie-breaker: it decides which tenant a request acts
 * on and which team_role gates it. It is now shared by the page-render path
 * (getActiveProfile) and the API path (resolveSessionContext / resolveTenantId),
 * which previously disagreed — the latter used .maybeSingle(), which errors on
 * more than one row, so a multi-profile user rendered pages fine and was
 * refused by all ~95 routes behind that helper.
 */
import assert from "node:assert/strict";
import { chooseActiveProfile } from "../lib/active-profile";

const P = (o: Partial<{ id: string; email: string | null; is_owner: boolean | null; onboarding_completed_at: string | null; tenant_id: string }>) => ({
  id: "x", email: null, is_owner: null, onboarding_completed_at: null, tenant_id: "t", ...o,
});

// ── the common case ──────────────────────────────────────────────────────────
{
  const only = P({ id: "solo" });
  assert.equal(chooseActiveProfile([only], "a@b.com").id, "solo", "one row wins regardless of email");
  assert.equal(chooseActiveProfile([only], null).id, "solo", "…even with no session email");
}

// ── email narrowing comes FIRST ──────────────────────────────────────────────
{
  // The owner+onboarded row would win on precedence, but it belongs to a
  // different address. The row matching the session's own email is the identity
  // the user is actually acting as.
  const rows = [
    P({ id: "other-owner", email: "other@x.com", is_owner: true, onboarding_completed_at: "2026-01-01" }),
    P({ id: "mine", email: "me@x.com" }),
  ];
  assert.equal(chooseActiveProfile(rows, "me@x.com").id, "mine", "exact email narrows before precedence applies");
  assert.equal(chooseActiveProfile(rows, "ME@X.COM  ").id, "mine", "case- and whitespace-insensitive");
}
{
  // No email match → fall back to the whole set rather than returning nothing.
  const rows = [
    P({ id: "a", email: "a@x.com" }),
    P({ id: "b", email: "b@x.com", is_owner: true, onboarding_completed_at: "2026-01-01" }),
  ];
  assert.equal(chooseActiveProfile(rows, "nobody@x.com").id, "b", "no match → precedence over all rows");
  assert.equal(chooseActiveProfile(rows, null).id, "b", "no session email → same");
}

// ── precedence within the candidate set ──────────────────────────────────────
{
  const owner_done = P({ id: "owner_done", is_owner: true, onboarding_completed_at: "2026-01-01" });
  const done = P({ id: "done", onboarding_completed_at: "2026-01-01" });
  const owner = P({ id: "owner", is_owner: true });
  const plain = P({ id: "plain" });

  assert.equal(chooseActiveProfile([plain, owner, done, owner_done], null).id, "owner_done", "1st: owner + onboarded");
  assert.equal(chooseActiveProfile([plain, owner, done], null).id, "done", "2nd: onboarded");
  assert.equal(chooseActiveProfile([plain, owner], null).id, "owner", "3rd: owner");
  assert.equal(chooseActiveProfile([plain, P({ id: "plain2" })], null).id, "plain", "4th: first row");
}

// ── brand must NOT influence the choice ──────────────────────────────────────
{
  // An earlier version tie-broke on brand.includes("oasis"), pinning any
  // multi-tenant user to OASIS even when their session was a different tenant.
  const rows = [
    { ...P({ id: "sunbiz", onboarding_completed_at: "2026-01-01" }), brand: "sunbiz" },
    { ...P({ id: "oasis" }), brand: "oasis" },
  ];
  assert.equal(chooseActiveProfile(rows, null).id, "sunbiz", "onboarding beats brand — brand is not consulted at all");
}

// ── never returns undefined for a non-empty set ──────────────────────────────
{
  // Callers treat a falsy result as "no profile" and answer 401, so an
  // unexpected undefined here would lock a real user out.
  const shapes = [
    [P({})],
    [P({}), P({})],
    [P({ email: undefined as unknown as null })],
    [P({ is_owner: false, onboarding_completed_at: null })],
  ];
  for (const rows of shapes) {
    assert.ok(chooseActiveProfile(rows, null), "must always return a row for a non-empty set");
  }
}

console.log("active-profile tests passed");
