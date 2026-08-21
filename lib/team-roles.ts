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
  | "owner"
  | "admin"
  | "agent"
  | "loan_officer"
  | "processor"
  | "read_only"
  | "member";

/** A role an admin may hand out through the invite UI. `owner` is never invitable. */
export type InvitableRole = Exclude<TeamRole, "owner">;

/**
 * The invite menu, in display order. Value AND label together — a label kept
 * apart from its value is a label that drifts away from it.
 */
export const INVITABLE_ROLE_OPTIONS: ReadonlyArray<{
  value: InvitableRole;
  label: string;
}> = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
  { value: "agent", label: "Agent (sales rep)" },
];

/** Just the values — what the API validates an inbound role against. */
export const INVITABLE_ROLES: InvitableRole[] = INVITABLE_ROLE_OPTIONS.map((o) => o.value);

/**
 * Type guard for an UNTRUSTED inbound role string (request body, query param).
 * Allowlist by construction: an unrecognised value is not a role.
 */
export function isInvitableRole(value: unknown): value is InvitableRole {
  return typeof value === "string" && (INVITABLE_ROLES as string[]).includes(value);
}
