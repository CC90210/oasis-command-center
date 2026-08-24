/**
 * team-roles — the role enum and the invite menu, in one dependency-free module.
 *
 * WHY THIS IS SEPARATE FROM lib/team.ts
 * lib/team.ts imports node:crypto and the Supabase server client. A "use client"
 * component importing the role list from there would drag that whole server
 * chain into the browser bundle. So the two things a client legitimately needs —
 * the role names and their labels — live here, with no imports at all.
 *
 * Same discipline as lib/role-surfaces.ts: pure by design, unit-testable without
 * a database, and safe to import from either side of the server/client boundary.
 *
 * WHAT THIS FIXES
 * The invite menu was hand-typed a SECOND time in app/team/TeamInviteActions.tsx.
 * Two lists with no link between them: a role added to the API allowlist could
 * not be offered by the dropdown, and a role dropped from the dropdown was still
 * accepted by the API. Neither half fails loudly — they just quietly disagree.
 * This is now the one list both sides read.
 */

export type TeamRole =
  // Platform roles. Meaningful in every workspace.
  | "owner"
  | "admin"
  | "read_only"
  // OASIS sales org (2026-08-21). Job titles, not permission tiers: the role IS
  // the job, so the nav a person gets and the rate they are paid both derive
  // from this one field rather than a second lookup that can disagree with it.
  | "manager"
  | "closer"
  | "opener"
  | "builder"
  // Marketing staff (2026-08-21). Content, campaigns and the founders
  // marketing studio — never revenue, never the sales pipeline.
  | "marketing"
  // Legacy. Still resolvable because live rows carry them (43 `member`, and
  // `member` is the column DEFAULT), but no longer offered on the invite menu —
  // "member" and "agent" are the ambiguous pair the job titles above replace.
  | "agent"
  | "member"
  // SunBiz's own roles. A different portal; not ours to change.
  | "loan_officer"
  | "processor";

/** A role an admin may hand out through the invite UI. `owner` is never invitable. */
export type InvitableRole = Exclude<TeamRole, "owner">;

export type RoleOption = { value: InvitableRole; label: string };

/**
 * Roles offered in EVERY workspace. Infrastructure, not product.
 */
export const PLATFORM_ROLE_OPTIONS: ReadonlyArray<RoleOption> = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
];

/**
 * Roles offered ONLY in an OASIS-owned workspace.
 *
 * These are a PRODUCT concern, not infrastructure, and CONTEXT.md's rule is that
 * product features do not extrapolate across tenants. A SunBiz admin has no use
 * for "Closer", and someone invited as a closer onto a SunBiz tenant would get a
 * persona built for a workspace they are not standing in.
 *
 * NAME NOTE: this now carries `marketing` as well, which is not a sales role.
 * The list is "roles that exist only inside OASIS", and the SALES_ in the name
 * is a leftover from when that was the same thing. Left as-is on purpose — the
 * identifier is load-bearing across team-roles, role-surfaces and the invite
 * API, and renaming it to correct a comment is a wide change for zero
 * behavioural gain. `isOasisSalesRole` gates tenant eligibility, and marketing
 * belongs in that gate for exactly the same reason a closer does.
 */
export const OASIS_SALES_ROLE_OPTIONS: ReadonlyArray<RoleOption> = [
  { value: "manager", label: "Sales manager" },
  { value: "closer", label: "Closer" },
  { value: "opener", label: "Opener" },
  { value: "builder", label: "Builder" },
  { value: "marketing", label: "Marketing" },
];

/** The OASIS sales job titles, as a set — used to decide tenant eligibility. */
export const OASIS_SALES_ROLES: ReadonlySet<string> = new Set(
  OASIS_SALES_ROLE_OPTIONS.map((o) => o.value),
);

/** True when `role` is one of the OASIS sales job titles. */
export function isOasisSalesRole(role: unknown): boolean {
  return typeof role === "string" && OASIS_SALES_ROLES.has(role);
}

/**
 * ============================================================================
 * WHO IS A REP, AND WHICH REPS MAY TOUCH MONEY
 * ============================================================================
 *
 * Added 2026-08-24, and it closes a gap the 2026-08-21 job-title change opened.
 *
 * THE BACKGROUND. `agent` is the LEGACY commission-only contractor role. It was
 * replaced by the job titles above -- `opener` and `closer` -- but two pieces of
 * code that gate real behaviour were never moved across, and both still ask
 * `teamRole === "agent"` and nothing else:
 *
 *   1. lead scoping (lib/web-leads/data.ts, the manifest records route)
 *   2. who may quote and close (the website-sales rep-action route)
 *
 * The consequences were opposite and both wrong. A rep invited as `opener` or
 * `closer` -- which is what the invite menu actually offers -- was NOT scoped to
 * their own book, so they could read every lead in the tenant, reopening exactly
 * the leak PR #237 closed for `agent`. And the same rep could not quote or close
 * ANYTHING, so the role literally named "Closer" could not close.
 *
 * THE OPERATOR REQUIREMENT (Adon, 2026-08-24): "it shouldn't change what reps
 * can do, but you should be able to establish openers and closers, because
 * although it's starting off with some people doing both, we're going to grow to
 * the point that there are positions specifically for certain people and the
 * software should be able to accommodate that."
 *
 * So: `agent` keeps everything it has today (nobody's access changes), `closer`
 * gains what its name promises, and `opener` becomes a real setter-only seat
 * that can work a book and hand it off but cannot put a price in front of a
 * prospect. No migration is needed -- these roles already exist and the invite
 * menu already offers them.
 */

/**
 * Roles that are scoped to their OWN records and must never see the tenant's
 * whole book.
 *
 * A tenant check alone does not stop these people: they sit fully INSIDE the
 * tenant. This is the predicate that keeps a contractor from pulling all ~31K
 * web-sales leads, and every door onto tenant_records must apply it identically
 * or the leak simply moves to whichever door forgot.
 *
 * `builder` is included deliberately. They are not a sales role at all, and
 * being MORE scoped than necessary is the safe direction to be wrong in.
 */
export const SELF_SCOPED_ROLES: ReadonlySet<string> = new Set([
  "agent",   // legacy contractor, still live on real rows
  "opener",
  "closer",
  "builder",
]);

/** True when this role may only ever see its own records. Admins are exempt and
 *  the caller checks that separately, so this stays a pure role question. */
export function isSelfScopedRole(role: unknown): boolean {
  return typeof role === "string" && SELF_SCOPED_ROLES.has(role.trim().toLowerCase());
}

/**
 * Roles that may put a PRICE in front of a prospect: build a proposal and close
 * a deal on their own book.
 *
 * `opener` is deliberately absent, and that absence is the whole feature. A
 * setter qualifies and hands off; letting one quote means a new rep discounts
 * on their first week, promises a delivery date nobody agreed to, or confirms a
 * custom build is feasible when it is not. Those are the exact things the offer
 * doctrine forbids a setter from doing.
 *
 * `agent` IS present. That is not an oversight and not laziness: it is the
 * legacy role every current rep actually carries, it can quote and close today,
 * and the operator's instruction was explicitly that this change must not take
 * anything away from the people already working. New seats get the precise
 * title; existing seats keep working. Migrate a person by changing their role,
 * which is a deliberate act with a visible audit trail, not a silent revocation
 * they discover mid-call.
 */
export const DEAL_CLOSING_ROLES: ReadonlySet<string> = new Set([
  "closer",
  "agent",   // legacy, and grandfathered ON PURPOSE -- see above
]);

/**
 * May this role quote and close on a lead it owns?
 *
 * This answers the ROLE question only. Every caller must still confirm the lead
 * actually belongs to this person -- ownership is not a role property, and a
 * closer may no more close someone else's deal than an opener may close their
 * own. Fails closed on anything unrecognised.
 */
export function mayQuoteAndClose(role: unknown): boolean {
  return typeof role === "string" && DEAL_CLOSING_ROLES.has(role.trim().toLowerCase());
}

/**
 * Every role the invite UI can offer ANYWHERE. This is the "is it a role at
 * all" set — it deliberately does NOT answer "may it be used here", which is
 * tenant-dependent and lives in lib/role-surfaces.ts.
 */
export const INVITABLE_ROLE_OPTIONS: ReadonlyArray<RoleOption> = [
  ...PLATFORM_ROLE_OPTIONS,
  ...OASIS_SALES_ROLE_OPTIONS,
];

/** Just the values — the first gate an inbound role passes. */
export const INVITABLE_ROLES: InvitableRole[] = INVITABLE_ROLE_OPTIONS.map((o) => o.value);

/**
 * Type guard for an UNTRUSTED inbound role string (request body, query param).
 * Allowlist by construction: an unrecognised value is not a role.
 */
export function isInvitableRole(value: unknown): value is InvitableRole {
  return typeof value === "string" && (INVITABLE_ROLES as string[]).includes(value);
}
