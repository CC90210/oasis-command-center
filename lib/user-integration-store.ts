/**
 * lib/user-integration-store.ts — server-side per-(tenant, user)
 * integration credential store.
 *
 * Companion to lib/tenant-integration-store.ts. Same AES-256-GCM
 * encryption (via lib/field-encryption), same read/write semantics —
 * just scoped to a specific employee instead of the tenant. Used for
 * credentials that MUST be the employee's personally (Gmail OAuth
 * refresh tokens — Alex's emails come from Alex's address, not Ezra's
 * shared submissions@).
 *
 * Read precedence in the send pipeline:
 *   1. user-scope value (this module) when acted_by_user_id is known
 *   2. fall back to tenant-scope value (tenant-integration-store) for
 *      services that have a shared tenant default (e.g. SMTP relay)
 *   3. env-var fallback (tenant-integration-store handles it)
 *
 * Phase 4 of the SunBiz multi-employee personalization plan
 * (2026-05-29). Migration 076 (CEO-Agent) backs the table; RLS
 * enforces user-owned writes + admin-read visibility.
 */

import "server-only";
import { getServiceSupabase } from "./supabase-server";
import { encryptField, decryptField } from "./field-encryption";

export type UserIntegrationStatusRow = {
  service: string;
  field_key: string;
  has_value: boolean;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  updated_at: string | null;
};

export type UserIntegrationSetResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Resolve a single per-user credential field. Returns null when the
 * row doesn't exist OR decryption fails. NEVER throws.
 */
export async function getUserIntegrationValue(
  tenantId: string,
  userId: string,
  service: string,
  fieldKey: string,
): Promise<string | null> {
  if (!tenantId || !userId || !service || !fieldKey) return null;
  const db = getServiceSupabase();
  const r = await db
    .from("user_integration_credentials")
    .select("encrypted_value")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .eq("service", service)
    .eq("field_key", fieldKey)
    .maybeSingle();
  if (!r.data || !(r.data as { encrypted_value?: string }).encrypted_value) {
    return null;
  }
  try {
    return decryptField((r.data as { encrypted_value: string }).encrypted_value);
  } catch (err) {
    console.error("[user-integration-store] decrypt failed", { service, fieldKey, err });
    return null;
  }
}

/**
 * Resolve every field for a (tenant, user, service) tuple in one
 * round trip. Useful for the Gmail OAuth bundle (refresh_token +
 * access_token + expires_at + scope + gmail_address) — single SELECT
 * + decrypt loop. Fields that fail decryption are omitted.
 */
export async function getUserIntegrationBundle(
  tenantId: string,
  userId: string,
  service: string,
): Promise<Record<string, string>> {
  if (!tenantId || !userId || !service) return {};
  const db = getServiceSupabase();
  const r = await db
    .from("user_integration_credentials")
    .select("field_key, encrypted_value")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .eq("service", service);
  const bundle: Record<string, string> = {};
  for (const row of (r.data || []) as Array<{ field_key: string; encrypted_value: string }>) {
    try {
      bundle[row.field_key] = decryptField(row.encrypted_value);
    } catch (err) {
      console.error("[user-integration-store] decrypt failed", { service, field: row.field_key, err });
    }
  }
  return bundle;
}

/**
 * Upsert a single field. Encrypts via AES-256-GCM before insert.
 * Returns the row id on success.
 */
export async function setUserIntegrationValue(
  tenantId: string,
  userId: string,
  service: string,
  fieldKey: string,
  plaintextValue: string,
): Promise<UserIntegrationSetResult> {
  if (!tenantId || !userId || !service || !fieldKey) {
    return { ok: false, error: "missing_required_field" };
  }
  let encrypted: string;
  try {
    encrypted = encryptField(plaintextValue);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "encrypt_failed";
    return { ok: false, error: msg };
  }
  const db = getServiceSupabase();
  // Upsert on the composite unique key (tenant_id, user_id, service,
  // field_key). Migration 076 backs the constraint.
  const { data, error } = await db
    .from("user_integration_credentials")
    .upsert(
      {
        tenant_id: tenantId,
        user_id: userId,
        service,
        field_key: fieldKey,
        encrypted_value: encrypted,
      },
      { onConflict: "tenant_id,user_id,service,field_key" },
    )
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message || "upsert_failed" };
  }
  return { ok: true, id: (data as { id: string }).id };
}

/**
 * Bulk-set every field in a bundle in one batch. Useful for OAuth
 * callbacks where we receive { refresh_token, access_token, expires_at,
 * scope, gmail_address } at once and want them all in or none in.
 *
 * Each entry that fails encryption is skipped and reported in the
 * returned errors map. A partial success is still a success — the
 * caller decides whether to surface the partial state to the user.
 */
export async function setUserIntegrationBundle(
  tenantId: string,
  userId: string,
  service: string,
  bundle: Record<string, string>,
): Promise<{ ok: boolean; written: string[]; errors: Record<string, string> }> {
  const written: string[] = [];
  const errors: Record<string, string> = {};
  for (const [fieldKey, value] of Object.entries(bundle)) {
    const r = await setUserIntegrationValue(tenantId, userId, service, fieldKey, value);
    if (r.ok) {
      written.push(fieldKey);
    } else {
      errors[fieldKey] = r.error;
    }
  }
  return { ok: written.length > 0, written, errors };
}

/**
 * Operator-facing status list: every field this user has saved, with
 * its tested-at metadata. Used by Settings → Personal integrations
 * to render the connected/disconnected state. Does NOT decrypt — the
 * settings UI only needs presence, not value.
 */
export async function listUserIntegrationStatus(
  tenantId: string,
  userId: string,
): Promise<UserIntegrationStatusRow[]> {
  if (!tenantId || !userId) return [];
  const db = getServiceSupabase();
  const r = await db
    .from("user_integration_credentials")
    .select("service, field_key, encrypted_value, last_tested_at, last_test_ok, last_test_error, updated_at")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId);
  return (r.data || []).map((row) => {
    const r2 = row as {
      service: string;
      field_key: string;
      encrypted_value: string | null;
      last_tested_at: string | null;
      last_test_ok: boolean | null;
      last_test_error: string | null;
      updated_at: string | null;
    };
    return {
      service: r2.service,
      field_key: r2.field_key,
      has_value: !!r2.encrypted_value,
      last_tested_at: r2.last_tested_at,
      last_test_ok: r2.last_test_ok,
      last_test_error: r2.last_test_error,
      updated_at: r2.updated_at,
    };
  });
}

/**
 * Disconnect a service for this user — deletes every field row in one
 * call. Used by Settings → Personal → "Disconnect Gmail".
 */
export async function clearUserIntegration(
  tenantId: string,
  userId: string,
  service: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!tenantId || !userId || !service) {
    return { ok: false, error: "missing_required_field" };
  }
  const db = getServiceSupabase();
  const { error } = await db
    .from("user_integration_credentials")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .eq("service", service);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Clear a SINGLE field for this user without touching the service's other
 * fields. Needed where one service holds multiple independent per-rep
 * overrides (e.g. Kixie's kixie_agent_email + kixie_from_number) and the
 * operator should be able to clear one without nuking the other.
 */
export async function clearUserIntegrationField(
  tenantId: string,
  userId: string,
  service: string,
  fieldKey: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!tenantId || !userId || !service || !fieldKey) {
    return { ok: false, error: "missing_required_field" };
  }
  const db = getServiceSupabase();
  const { error } = await db
    .from("user_integration_credentials")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .eq("service", service)
    .eq("field_key", fieldKey);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
