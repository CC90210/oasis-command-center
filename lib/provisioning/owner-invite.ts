/**
 * lib/provisioning/owner-invite.ts - the founder's invite into a workspace
 * OASIS set up for them (tenant_invites.kind = 'owner_claim', bravo__196).
 *
 * THE ONE MINTER. Only app/api/admin/installs/[tenantId]/owner-invite imports
 * this module (tests/admin-installs.test.ts fails the build if anything else
 * does). Team invites (lib/team.ts createInvite, /api/team/invites) keep
 * refusing "owner" through isInvitableRole, so no workspace member can ever
 * mint an owner, and a member invite whose row says team_role 'owner' still
 * joins as a member (lib/turso-rpc-shim.ts redeem_tenant_invite reads KIND).
 *
 * Refuses a workspace that already has an owner: a second owner is not
 * something redemption can create (user_profiles_one_owner_per_tenant), so the
 * invite would be a link that can only fail.
 */

import "server-only";

import { getServiceSupabase } from "@/lib/supabase-server";
import { generateInviteToken, inviteExpiryFrom, normalizeInviteEmail, supersedeActiveInvites } from "@/lib/team";

export class OwnerInviteError extends Error {
  constructor(
    public readonly code:
      | "invite_email_required"
      | "workspace_already_has_owner"
      | "migration_196_not_applied"
      | "owner_invite_create_failed",
    message: string,
  ) {
    super(message);
    this.name = "OwnerInviteError";
  }
}

export async function mintOwnerClaimInvite(args: {
  tenantId: string;
  email: string;
  createdBy: string;
}): Promise<{ id: string; rawToken: string; expiresAt: string; superseded: number }> {
  const email = normalizeInviteEmail(args.email);
  if (!email) throw new OwnerInviteError("invite_email_required", "Enter the founder's email address.");
  const db = getServiceSupabase();

  const owner = await db
    .from("user_profiles")
    .select("id")
    .eq("tenant_id", args.tenantId)
    .eq("is_owner", true)
    .limit(1);
  if (owner.error) throw new OwnerInviteError("owner_invite_create_failed", `owner check failed: ${owner.error.message}`);
  if ((owner.data || []).length > 0) {
    throw new OwnerInviteError("workspace_already_has_owner", "This workspace already has an owner.");
  }

  const superseded = await supersedeActiveInvites({ tenantId: args.tenantId, email });
  const { raw, hash } = generateInviteToken();
  const expiresAt = inviteExpiryFrom();
  const { data, error } = await db
    .from("tenant_invites")
    .insert({
      tenant_id: args.tenantId,
      email,
      team_role: "owner",
      kind: "owner_claim",
      token_hash: hash,
      created_by: args.createdBy,
      expires_at: expiresAt,
    })
    .select("id, expires_at")
    .single();
  if (error || !data) {
    const message = error?.message ?? "no row returned";
    if (/no column named kind|no such column:?\s*"?kind"?/i.test(message)) {
      throw new OwnerInviteError(
        "migration_196_not_applied",
        "Owner invites need database migration bravo__196_owner_claim_invites.sql, which has not been applied yet.",
      );
    }
    throw new OwnerInviteError("owner_invite_create_failed", message);
  }
  return { id: String(data.id), rawToken: raw, expiresAt: String(data.expires_at), superseded };
}

/** The email the founder receives. Names the workspace; nothing invented. */
export function ownerInviteEmailText(input: { workspaceName: string; inviteUrl: string; expiresAt: string }): string {
  const expires = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(input.expiresAt));
  return [
    `You have been invited to own the ${input.workspaceName} workspace on OASIS OS.`,
    "",
    "Create your account using this one-time link:",
    input.inviteUrl,
    "",
    `This link expires ${expires}.`,
    "If you were not expecting this invitation, you can ignore this email.",
  ].join("\n");
}
