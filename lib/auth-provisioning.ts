import type { SupabaseClient } from "@supabase/supabase-js";
import type { Client } from "@libsql/client";
import { dbError } from "@/lib/db-error";
import { dbBool } from "@/lib/db-bool";
import { validateActiveInviteForEmail } from "@/lib/invite-account-recovery";

/**
 * Attach an authenticated session to the user_profile it is entitled to.
 *
 * INVITE-ONLY (P0-8, 2026-09-28). This used to be how a stranger got a
 * workspace: no profile -> `signup_tenant` -> a brand-new tenant, with its shell
 * picked from whatever brand text they typed. It also relinked ANY profile row
 * whose email matched, whatever auth account already owned it — and since
 * signup never proved the caller owned the address, registering someone's email
 * and calling provision took over their profile. Now:
 *
 *   1. A profile already bound to this auth id is returned as-is (idempotent).
 *   2. A pre-created profile row with this email and NO auth account
 *      (auth_user_id IS NULL) is claimed only when the caller also presents an
 *      active invite pinned to this email for that row's tenant. The invite
 *      reached the mailbox by email; that is the ownership proof.
 *   3. Anything else is refused. Never a new tenant: a teammate joins the
 *      inviting tenant through /api/auth/redeem-invite, and a client workspace
 *      is operator-provisioned.
 */

export type ProvisioningRefusalCode =
  | "invite_required"
  | "invite_invalid"
  | "invite_email_mismatch"
  | "no_claimable_profile"
  | "profile_owned_by_another_account";

/**
 * A refusal, not a failure: the caller is not entitled to what it asked for.
 * Thrown (rather than returned) so a caller that ignores the result — the legacy
 * Supabase OAuth callback does — still logs it instead of carrying on silently.
 */
export class ProvisioningRefusedError extends Error {
  readonly code: ProvisioningRefusalCode;
  readonly status: 403 | 409;

  constructor(code: ProvisioningRefusalCode, status: 403 | 409, message: string) {
    super(message);
    this.name = "ProvisioningRefusedError";
    this.code = code;
    this.status = status;
  }
}

type ProvisionInput = {
  authUserId: string;
  email: string;
  db: SupabaseClient;
  /**
   * Needed only to claim a pre-created profile row that has no auth account yet.
   * `db` is a raw libSQL handle because the invite check is the same one
   * /api/auth/turso-signup runs (lib/invite-account-recovery.ts).
   */
  invite?: { rawToken: string; db: Pick<Client, "execute"> } | null;
  /** @deprecated Ignored — provisioning never creates a tenant, so there is nothing to name (P0-8). */
  fullName?: string;
  /** @deprecated Ignored — brand text no longer selects a shell (P0-8). */
  brand?: string | null;
};

type ProvisionProfileRow = {
  id: string;
  tenant_id: string | null;
  auth_user_id?: string | null;
  email?: string | null;
  brand?: string | null;
  primary_agent?: string | null;
  is_owner?: boolean | null;
  onboarding_completed_at?: string | null;
};

export type ProvisionResult = {
  ok: true;
  tenant_id: string;
  profile_id: string;
  already_provisioned: true;
  /** True when this call bound a pre-created profile row to the session. */
  relinked?: true;
};

const PROFILE_COLUMNS =
  "id, tenant_id, auth_user_id, email, brand, primary_agent, is_owner, onboarding_completed_at";

export async function provisionAuthenticatedUser({
  authUserId,
  email,
  db,
  invite,
}: ProvisionInput): Promise<ProvisionResult> {
  const existing = await db
    .from("user_profiles")
    .select(PROFILE_COLUMNS)
    .eq("auth_user_id", authUserId)
    .limit(20);
  // A failed read must not look like "no profile": before P0-8 that fell
  // straight through to creating a tenant, and now it would be misreported to
  // a real member as "invite required".
  if (existing.error) throw dbError("provision.profile_by_auth_id", existing.error);

  const existingRow = chooseProvisioningRow(
    ((existing.data || []) as ProvisionProfileRow[]),
    email,
  );
  if (existingRow) {
    return {
      ok: true,
      already_provisioned: true,
      tenant_id: existingRow.tenant_id,
      profile_id: existingRow.id,
    };
  }

  if (!invite) {
    throw new ProvisioningRefusedError(
      "invite_required",
      403,
      "OASIS OS is invite-only — open the invite link you were emailed to join a workspace",
    );
  }

  const verified = await validateActiveInviteForEmail(invite.db, {
    rawToken: invite.rawToken,
    email,
  });
  if (!verified.ok) {
    throw verified.error === "email_mismatch"
      ? new ProvisioningRefusedError(
          "invite_email_mismatch",
          403,
          "this invite was sent to a different email address",
        )
      : new ProvisioningRefusedError(
          "invite_invalid",
          403,
          "this invite is no longer active — ask your admin for a new link",
        );
  }

  const byEmail = await db
    .from("user_profiles")
    .select(PROFILE_COLUMNS)
    .eq("email", email)
    .eq("tenant_id", verified.tenantId)
    .limit(20);
  if (byEmail.error) throw dbError("provision.profile_by_email", byEmail.error);
  const inTenant = (byEmail.data || []) as ProvisionProfileRow[];

  // Only a row no auth account owns can be claimed. A row bound to another
  // auth id belongs to someone else, whatever its email says. `== null` is the
  // same predicate the IS NULL guard in the write below enforces.
  const claimable = chooseProvisioningRow(
    inTenant.filter((row) => row.auth_user_id == null),
    email,
  );
  if (!claimable) {
    if (inTenant.some((row) => row.auth_user_id != null)) {
      throw new ProvisioningRefusedError(
        "profile_owned_by_another_account",
        409,
        "this workspace profile is already linked to a different account — ask your admin",
      );
    }
    throw new ProvisioningRefusedError(
      "no_claimable_profile",
      409,
      "there is no profile to claim for this email — open the invite link to join the workspace",
    );
  }

  // Compare-and-swap: the NULL check is re-asserted in the write, so a
  // concurrent claim by another account cannot be overwritten between the read
  // above and this update.
  const claim = await db
    .from("user_profiles")
    .update({ auth_user_id: authUserId })
    .eq("id", claimable.id)
    .eq("tenant_id", verified.tenantId)
    .is("auth_user_id", null)
    .select("id");
  if (claim.error) throw dbError("provision.relink", claim.error);
  if (!claim.data || claim.data.length !== 1) {
    throw new ProvisioningRefusedError(
      "profile_owned_by_another_account",
      409,
      "this workspace profile was just linked to a different account — ask your admin",
    );
  }

  return {
    ok: true,
    already_provisioned: true,
    relinked: true,
    tenant_id: claimable.tenant_id,
    profile_id: claimable.id,
  };
}

function chooseProvisioningRow<T extends {
  id: string;
  tenant_id: string | null;
  email?: string | null;
  brand?: string | null;
  primary_agent?: string | null;
  is_owner?: boolean | null;
  onboarding_completed_at?: string | null;
}>(
  rows: T[],
  email: string,
): (T & { tenant_id: string }) | null {
  const scopedRows = rows.filter((row): row is T & { tenant_id: string } => !!row.tenant_id);
  if (scopedRows.length === 0) return null;
  if (scopedRows.length === 1) return scopedRows[0];
  const normalizedEmail = email.trim().toLowerCase();
  const exactEmail = scopedRows.filter((row) => (row.email || "").trim().toLowerCase() === normalizedEmail);
  const candidates = exactEmail.length > 0 ? exactEmail : scopedRows;
  // dbBool (lib/db-bool.ts): a stored "0" must not pick a seat as the owner's.
  return (
    candidates.find((row) => {
      const brand = (row.brand || "").toLowerCase();
      return dbBool(row.is_owner) && row.primary_agent === "bravo" && brand.includes("oasis");
    }) ||
    candidates.find((row) => dbBool(row.is_owner) && row.onboarding_completed_at) ||
    candidates.find((row) => row.onboarding_completed_at) ||
    candidates.find((row) => dbBool(row.is_owner)) ||
    candidates[0]
  );
}
