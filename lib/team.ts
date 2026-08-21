import { createHash, randomBytes } from "node:crypto";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { adminGetUser } from "@/lib/turso-auth-admin";
import { dbError } from "@/lib/db-error";

import {
  INVITABLE_ROLES,
  isInvitableRole,
  type InvitableRole,
  type TeamRole,
} from "@/lib/team-roles";

/**
 * Re-exported so every existing `from "@/lib/team"` import keeps working. The
 * declarations themselves live in lib/team-roles.ts, which has no dependencies
 * and is therefore safe for a client component to import — this module is not.
 */
export { INVITABLE_ROLES, isInvitableRole };
export type { InvitableRole, TeamRole };

/**
 * The workspace slug for a tenant id, lowercased. Null when the row is missing
 * or the read fails.
 *
 * Null is FAIL-CLOSED by construction at every current call site: both feed
 * `invitableRoleOptionsFor` / `roleAllowedForTenant`, which treat an unknown
 * workspace as "not OASIS" and therefore withhold the sales roles. A caller that
 * needs to tell "not ours" apart from "could not tell" must not use this — see
 * resolveViewerSurface's `degraded` flag, which exists for exactly that reason.
 *
 * NOTE: this lookup is inlined in roughly ten other modules. This helper is used
 * by the two surfaces added for the sales roles; consolidating the rest is a
 * separate change and not one to make while shipping a feature.
 */
export async function tenantSlugFor(tenantId: string): Promise<string | null> {
  try {
    const supa = getServiceSupabase();
    const { data, error } = await supa
      .from("tenants")
      .select("slug")
      .eq("id", tenantId)
      .maybeSingle();
    if (error || !data) return null;
    const slug = (data as { slug?: string | null }).slug;
    return slug ? slug.trim().toLowerCase() : null;
  } catch (err) {
    console.error("[team.tenantSlugFor]", err);
    return null;
  }
}

/**
 * How long a fresh invite stays redeemable.
 *
 * THIS LIVED IN THE DATABASE AND THE DATABASE LOST IT. In Postgres the column
 * was `expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'`, so
 * createInvite() never had to supply it. The Turso port could not express that
 * expression default, dropped it, and kept the NOT NULL — leaving:
 *
 *   "expires_at" TEXT NOT NULL          <- no default, and nobody supplies it
 *
 * Every invite insert has therefore failed since the cutover with a NOT NULL
 * constraint violation, surfacing to CC as the opaque string
 * "invite_create_failed". A policy that only exists as a database default is one
 * migration away from not existing at all, and its absence is invisible until a
 * user clicks the button.
 *
 * So the policy lives here now: explicit, greppable, identical on both backends,
 * and unit-testable without a database. `inviteExpiryFrom()` is the only place
 * that computes it, and app/team/page.tsx renders THIS constant rather than a
 * hardcoded "7" that could drift away from it.
 */
export const INVITE_TTL_DAYS = 7;

/** The expiry timestamp for an invite minted at `from` (default: now). */
export function inviteExpiryFrom(from: Date = new Date()): string {
  return new Date(from.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export type MemberRow = {
  id: string;
  auth_user_id: string | null;
  email: string;
  full_name: string;
  display_name: string | null;
  team_role: TeamRole;
  is_owner: boolean;
  /** Full-admin toggle grant — an admin elevated this member to admin_access. */
  admin_access: boolean;
  invited_by: string | null;
  joined_at: string;
};

export type InviteRow = {
  id: string;
  tenant_id: string;
  email: string | null;
  team_role: Exclude<TeamRole, "owner">;
  created_by: string;
  expires_at: string;
  redeemed_at: string | null;
  redeemed_by: string | null;
  revoked_at: string | null;
  created_at: string;
};

export type InvitePreview = {
  tenant_id: string;
  tenant_name: string;
  team_role: Exclude<TeamRole, "owner">;
  expires_at: string;
  email_pinned: string | null;
};

export type SessionContext = {
  authUserId: string;
  profileId: string;
  tenantId: string;
  teamRole: TeamRole;
  isOwner: boolean;
  /** admin_access toggle grant — an admin flipped this agent to full admin.
   *  Additive on top of the base team_role. */
  adminAccess: boolean;
};

/**
 * Can this member manage the team / tenant (invites, branding, integration keys,
 * cron jobs, automations, sequences, ...)? A base owner/admin, OR an agent an
 * admin has toggled `admin_access` ON.
 *
 * `adminAccess` is a SEPARATE arg (not baked into `role`) so the base role stays
 * intact for the escalation guard: setMemberRole / admin-role invites / the
 * admin_access toggle itself gate on isTrueAdminRole (below), which ignores the
 * grant, so a toggled agent can never mint a permanent admin. Admin-toggle
 * design, 2026-07-07.
 */
export function canManageTeam(role: TeamRole, adminAccess = false): boolean {
  return role === "owner" || role === "admin" || adminAccess === true;
}

/**
 * PERMANENT admin by base role (owner via is_owner, or admin/owner team_role).
 * EXCLUDES the admin_access grant. The escalation-guard predicate: only a true
 * admin may alter another member's role or grant admin. Mirrors
 * lead-scope.ts isTrueAdmin for the SessionContext shape.
 */
export function isTrueAdminRole(role: TeamRole, isOwner: boolean): boolean {
  return isOwner || role === "owner" || role === "admin";
}

export function hashInviteToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export function generateInviteToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashInviteToken(raw) };
}

function normalizeEmail(email: string | null | undefined): string {
  return (email || "").trim().toLowerCase();
}

export function inviteEmailMatchesUser(
  inviteEmail: string | null | undefined,
  userEmail: string | null | undefined,
): boolean {
  const pinned = normalizeEmail(inviteEmail);
  if (!pinned) return true;
  return pinned === normalizeEmail(userEmail);
}

export async function getSessionContext(): Promise<SessionContext | null> {
  const user = await getSessionUser();
  if (!user) return null;
  const supa = getServiceSupabase();
  const { data, error } = await supa
    .from("user_profiles")
    .select("id, tenant_id, team_role, is_owner, admin_access")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (error || !data || !data.tenant_id) return null;
  return {
    authUserId: user.id,
    profileId: data.id,
    tenantId: data.tenant_id,
    teamRole: (data.team_role as TeamRole) ?? "member",
    isOwner: !!data.is_owner,
    adminAccess: data.admin_access === true,
  };
}

export async function getTenantMembers(tenantId: string): Promise<MemberRow[]> {
  const supa = getServiceSupabase();
  const { data, error } = await supa
    .from("user_profiles")
    .select(
      "id, auth_user_id, email, full_name, display_name, team_role, is_owner, admin_access, invited_by, joined_at"
    )
    .eq("tenant_id", tenantId)
    .order("is_owner", { ascending: false })
    .order("joined_at", { ascending: true });
  if (error) throw dbError("getTenantMembers", error);
  return (data ?? []) as MemberRow[];
}

export async function listActiveInvites(tenantId: string): Promise<InviteRow[]> {
  const supa = getServiceSupabase();
  const { data, error } = await supa
    .from("tenant_invites")
    .select(
      "id, tenant_id, email, team_role, created_by, expires_at, redeemed_at, redeemed_by, revoked_at, created_at"
    )
    .eq("tenant_id", tenantId)
    .is("redeemed_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error) throw dbError("listActiveInvites", error);
  return (data ?? []) as InviteRow[];
}

export async function createInvite(
  args: {
    tenantId: string;
    role: Exclude<TeamRole, "owner">;
    createdBy: string;
    email?: string | null;
  },
  /**
   * Injectable for tests ONLY; every caller in the app omits it.
   *
   * The bug this exists to prevent was invisible to unit tests: the invite
   * insert omitted a NOT NULL column, which no pure function could reveal and
   * which only surfaced when a person clicked the button in production. The test
   * fake enforces the REAL column contract, so dropping a required field fails
   * here instead of in front of CC. See tests/team-invites.test.ts.
   */
  db: ReturnType<typeof getServiceSupabase> = getServiceSupabase(),
): Promise<{ id: string; rawToken: string; expiresAt: string }> {
  const supa = db;
  const { raw, hash } = generateInviteToken();
  const { data, error } = await supa
    .from("tenant_invites")
    .insert({
      tenant_id: args.tenantId,
      email: args.email ?? null,
      team_role: args.role,
      token_hash: hash,
      created_by: args.createdBy,
      // Supplied explicitly — see INVITE_TTL_DAYS. Do not remove this on the
      // assumption the column defaults: on Turso it does not, and the failure is
      // a NOT NULL violation at the moment a real person clicks Generate link.
      expires_at: inviteExpiryFrom(),
    })
    .select("id, expires_at")
    .single();
  // dbError, not `throw error`: a PostgREST/libSQL error is a PLAIN OBJECT, so
  // the route's `err instanceof Error ? err.message : "..."` fell through to the
  // generic string and hid "NOT NULL constraint failed: tenant_invites.expires_at"
  // for months. See lib/db-error.ts.
  if (error || !data) throw dbError("invite_create_failed", error);
  return { id: data.id, rawToken: raw, expiresAt: data.expires_at as string };
}

export async function previewInvite(rawToken: string): Promise<InvitePreview | null> {
  const token = rawToken.trim();
  if (!token) return null;
  const supa = getServiceSupabase();
  const { data, error } = await supa.rpc("preview_tenant_invite", {
    p_token_hash: hashInviteToken(token),
  });
  if (error || !data) return null;
  return data as InvitePreview;
}

export async function revokeInvite(inviteId: string, tenantId: string): Promise<void> {
  const supa = getServiceSupabase();
  const { error } = await supa
    .from("tenant_invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", inviteId)
    .eq("tenant_id", tenantId);
  if (error) throw dbError("revokeInvite", error);
}

export async function redeemInvite(
  rawToken: string,
  redeemerAuthId: string
): Promise<
  | { ok: true; tenantId: string; teamRole: TeamRole; idempotent?: boolean }
  | { ok: false; error: string }
> {
  const supa = getServiceSupabase();
  const hash = hashInviteToken(rawToken);

  const preview = await previewInvite(rawToken);
  if (!preview) {
    // previewInvite returns null for invalid / expired / revoked / already-
    // redeemed tokens — the four cases are indistinguishable from its
    // shape. Before declaring failure, check whether the calling user
    // has already redeemed this exact token. That's the legitimate
    // idempotent-success case (back-button, double-submit, retry after
    // network blip, or LoginForm calling us after finalize-invite-signup
    // already ran). Without this disambiguation a real already-redeemed
    // user gets surfaced "Invite redemption failed" — Codex P2 finding.
    const { data: priorRedeem } = await supa
      .from("tenant_invites")
      .select("tenant_id, team_role")
      .eq("token_hash", hash)
      .eq("redeemed_by", redeemerAuthId)
      .not("redeemed_at", "is", null)
      .maybeSingle();
    if (priorRedeem?.tenant_id && priorRedeem.team_role) {
      return {
        ok: true,
        tenantId: priorRedeem.tenant_id as string,
        teamRole: priorRedeem.team_role as TeamRole,
        idempotent: true,
      };
    }
    return { ok: false, error: "invalid_or_expired" };
  }
  // adminGetUser, not supa.auth.admin.getUserById — GoTrue disappears with the
  // Supabase project, and this line is the FIRST thing every join path touches
  // (signup redeem, login redeem, OAuth callback, finalize-invite-signup). It
  // stays a hard requirement rather than a best-effort lookup: the email pin is
  // what stops a leaked token being redeemed onto an unrelated account.
  const authUser = await adminGetUser(supa, redeemerAuthId);
  if (!authUser.ok) return { ok: false, error: "auth_user_not_found" };
  if (!inviteEmailMatchesUser(preview.email_pinned, authUser.value.email)) {
    return { ok: false, error: "email_mismatch" };
  }
  // p_redeemer_email is REQUIRED by the Turso port. Postgres read the email
  // from auth.users inside the SECURITY DEFINER function; there is no auth.users
  // to read under Turso, so the shim takes it as an argument and fails closed
  // without it — returning "auth_user_not_found", the SAME string the lookup
  // above returns on failure. That collision is why this went unnoticed: the
  // join simply reported the error it would have reported anyway.
  // The value is already in hand from the adminGetUser call one line up.
  const { data, error } = await supa.rpc("redeem_tenant_invite", {
    p_token_hash: hash,
    p_redeemer_auth_id: redeemerAuthId,
    p_redeemer_email: authUser.value.email,
    // Postgres pulled this from auth.users metadata inside the function; the
    // Turso port takes it as an argument, and without it a new member's profile
    // is created with full_name set to their email address.
    p_redeemer_full_name: authUser.value.fullName,
  });
  if (error) return { ok: false, error: error.message };
  if (!data?.ok) return { ok: false, error: data?.error ?? "invalid_or_expired" };
  return { ok: true, tenantId: data.tenant_id, teamRole: data.team_role as TeamRole };
}

export async function setMemberRole(args: {
  tenantId: string;
  targetProfileId: string;
  newRole: TeamRole;
  actor: SessionContext;
}): Promise<void> {
  // ESCALATION GUARD: altering another member's team_role is restricted to a
  // PERMANENT (true) admin — NOT the admin_access grant. A toggled agent must
  // never be able to grant/alter roles (and thereby mint an admin). Admin-toggle
  // design, 2026-07-07.
  if (!isTrueAdminRole(args.actor.teamRole, args.actor.isOwner)) {
    throw new Error("forbidden");
  }
  if (args.newRole === "owner") {
    throw new Error("ownership_transfer_not_supported");
  }
  const supa = getServiceSupabase();
  const { data: target, error: tErr } = await supa
    .from("user_profiles")
    .select("id, is_owner, tenant_id")
    .eq("id", args.targetProfileId)
    .single();
  if (tErr || !target) throw new Error("member_not_found");
  if (target.tenant_id !== args.tenantId) throw new Error("forbidden");
  if (target.is_owner) throw new Error("cannot_demote_owner");

  const { error } = await supa
    .from("user_profiles")
    .update({ team_role: args.newRole })
    .eq("id", args.targetProfileId);
  if (error) throw dbError("setMemberRole", error);
}

export async function removeMember(args: {
  tenantId: string;
  targetProfileId: string;
  actor: SessionContext;
}): Promise<void> {
  // Removing a member demotes + detaches them (tenant_id null, team_role
  // member). Though not a role-GRANT, it is high-consequence — a temporarily
  // elevated agent could strip real admins off the tenant — so it is restricted
  // to a PERMANENT admin; the admin_access grant does NOT confer it. The owner
  // is protected below (cannot_remove_owner).
  if (!isTrueAdminRole(args.actor.teamRole, args.actor.isOwner)) {
    throw new Error("forbidden");
  }
  const supa = getServiceSupabase();
  const { data: target, error: tErr } = await supa
    .from("user_profiles")
    .select("id, is_owner, tenant_id, auth_user_id")
    .eq("id", args.targetProfileId)
    .single();
  if (tErr || !target) throw new Error("member_not_found");
  if (target.tenant_id !== args.tenantId) throw new Error("forbidden");
  if (target.is_owner) throw new Error("cannot_remove_owner");

  const { error } = await supa
    .from("user_profiles")
    .update({ tenant_id: null, team_role: "member" })
    .eq("id", args.targetProfileId);
  if (error) throw dbError("removeMember", error);
}
