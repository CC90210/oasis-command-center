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
 */
export const OASIS_SALES_ROLE_OPTIONS: ReadonlyArray<RoleOption> = [
  { value: "manager", label: "Sales manager" },
  { value: "closer", label: "Closer" },
  { value: "opener", label: "Opener" },
  { value: "builder", label: "Builder" },
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
