import type { SupabaseClient } from "@supabase/supabase-js";
import { applyClientProvisioningProfile } from "@/lib/client-provisioning";

type ProvisionInput = {
  authUserId: string;
  email: string;
  fullName: string;
  brand?: string | null;
  db: SupabaseClient;
};

type ProvisionProfileRow = {
  id: string;
  tenant_id: string | null;
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
  slug?: string;
  already_provisioned?: boolean;
  client_profile_slug: string | null;
  primary_agent: string | null;
};

export async function provisionAuthenticatedUser({
  authUserId,
  email,
  fullName,
  brand,
  db,
}: ProvisionInput): Promise<ProvisionResult> {
  const existing = await db
    .from("user_profiles")
    .select("id, tenant_id, email, brand, primary_agent, is_owner, onboarding_completed_at")
    .eq("auth_user_id", authUserId)
    .limit(20);

  const existingRow = chooseProvisioningRow(
    ((existing.data || []) as ProvisionProfileRow[]),
    email,
  );
  if (existingRow) {
    const client = await applyClientProvisioningProfile({
      db,
      tenantId: existingRow.tenant_id,
      profileId: existingRow.id,
      brand: existingRow.brand || brand,
      email: existingRow.email || email,
    });
    return {
      ok: true,
      already_provisioned: true,
      tenant_id: existingRow.tenant_id,
      profile_id: existingRow.id,
      client_profile_slug: client.clientProfileSlug,
      primary_agent: client.primaryAgent,
    };
  }

  const byEmail = await db
    .from("user_profiles")
    .select("id, tenant_id, email, brand, primary_agent, is_owner, onboarding_completed_at")
    .eq("email", email)
    .limit(20);

  const emailRow = chooseProvisioningRow(
    ((byEmail.data || []) as ProvisionProfileRow[]),
    email,
  );
  if (emailRow) {
    await db.from("user_profiles").update({ auth_user_id: authUserId }).eq("id", emailRow.id);
    const client = await applyClientProvisioningProfile({
      db,
      tenantId: emailRow.tenant_id,
      profileId: emailRow.id,
      brand: emailRow.brand || brand,
      email: emailRow.email || email,
    });
    return {
      ok: true,
      already_provisioned: true,
      tenant_id: emailRow.tenant_id,
      profile_id: emailRow.id,
      client_profile_slug: client.clientProfileSlug,
      primary_agent: client.primaryAgent,
    };
  }

  const r = await db.rpc("signup_tenant", {
    p_auth_user_id: authUserId,
    p_email: email,
    p_full_name: fullName,
    p_brand: brand || "OASIS AI",
  });

  if (r.error || !r.data) {
    throw new Error(r.error?.message || "provisioning failed");
  }

  const out = r.data as { tenant_id: string; profile_id: string; slug: string };
  const client = await applyClientProvisioningProfile({
    db,
    tenantId: out.tenant_id,
    profileId: out.profile_id,
    brand,
    email,
  });

  return {
    ok: true,
    ...out,
    client_profile_slug: client.clientProfileSlug,
    primary_agent: client.primaryAgent,
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
  return (
    candidates.find((row) => {
      const brand = (row.brand || "").toLowerCase();
      return row.is_owner && row.primary_agent === "bravo" && brand.includes("oasis");
    }) ||
    candidates.find((row) => row.is_owner && row.onboarding_completed_at) ||
    candidates.find((row) => row.onboarding_completed_at) ||
    candidates.find((row) => row.is_owner) ||
    candidates[0]
  );
}
