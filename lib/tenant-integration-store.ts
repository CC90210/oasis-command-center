/**
 * lib/tenant-integration-store.ts — server-side per-tenant integration
 * key store (Twilio, TextTorrent, SMTP, n8n, Stripe, etc.).
 *
 * Reads/writes `tenant_integration_credentials` (migration 058) using
 * the canonical AES-256-GCM encryption helper at lib/field-encryption.
 *
 * Read precedence: tenant DB first, then env-var fallback. The fallback
 * lets pre-058 deployments keep working — if a tenant hasn't pasted a
 * key yet, we look at the env-var listed in lib/integrations-registry
 * `env_key`. Once an operator pastes a value into Settings the DB
 * takes precedence (no need to wipe the env var).
 *
 * All functions are server-only — field-encryption requires
 * BRAVO_FIELD_ENCRYPTION_KEY which never ships to the browser.
 */

import "server-only";
import { getServiceSupabase } from "./supabase-server";
import { encryptField, decryptField } from "./field-encryption";

type StoreRow = {
  id: string;
  tenant_id: string;
  service: string;
  field_key: string;
  encrypted_value: string;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  created_by: string | null;
  updated_at: string;
};

export type IntegrationStatusRow = {
  service: string;
  field_key: string;
  has_value: boolean;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  updated_at: string | null;
};

export type IntegrationSetResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Per-service env-var fallbacks.
 *
 * Relationship to lib/integrations-registry.ts: that file's `env_key`
 * field is single-valued — one env var per service — because the
 * legacy paste modal at /integrations only ever wrote one key. This
 * table is field-key-aware: Twilio has three env vars (sid + token +
 * from), SMTP has five. We keep both because the registry powers the
 * /integrations marketplace UI (signup_url, api_key_url, category,
 * agent membership) while ENV_FALLBACKS powers the per-tenant
 * resolver. The registry's single env_key matches the most important
 * field's env-name (e.g. "TWILIO_AUTH_TOKEN" for service=twilio); the
 * registry's `env_key` is informational, ENV_FALLBACKS is the
 * resolver's source of truth.
 *
 * Unregistered (service, field_key) pairs DB-only — no env-var
 * leakage path.
 */
const ENV_FALLBACKS: Record<string, Record<string, string>> = {
  twilio: {
    account_sid: "TWILIO_ACCOUNT_SID",
    auth_token: "TWILIO_AUTH_TOKEN",
    from_number: "TWILIO_FROM_NUMBER",
  },
  texttorrent: {
    api_key: "TEXTTORRENT_API_KEY",
    from_number: "TEXTTORRENT_FROM_NUMBER",
  },
  smtp: {
    host: "SMTP_HOST",
    port: "SMTP_PORT",
    user: "SMTP_USER",
    password: "SMTP_PASSWORD",
    from_address: "SMTP_FROM_ADDRESS",
  },
  n8n: {
    outbound_url: "N8N_OUTBOUND_URL",
    outbound_secret: "N8N_OUTBOUND_SECRET",
  },
  stripe: {
    secret_key: "STRIPE_SECRET_KEY",
    publishable_key: "STRIPE_PUBLISHABLE_KEY",
  },
  gws: {
    app_password: "GMAIL_APP_PASSWORD",
    from_address: "GMAIL_FROM_ADDRESS",
  },
  late: {
    api_key: "LATE_API_KEY",
  },
  telegram: {
    bot_token: "TELEGRAM_BOT_TOKEN",
  },
  send_gateway: {
    hmac_secret: "OASIS_OUTBOUND_HMAC_SECRET",
  },
};

/**
 * Resolve a single value. Returns null when neither the DB nor the
 * env-var fallback has it. NEVER throws on missing data — callers
 * decide whether absence is fatal.
 */
export async function getTenantIntegrationValue(
  tenantId: string,
  service: string,
  fieldKey: string,
): Promise<string | null> {
  const db = getServiceSupabase();
  const r = await db
    .from("tenant_integration_credentials")
    .select("encrypted_value")
    .eq("tenant_id", tenantId)
    .eq("service", service)
    .eq("field_key", fieldKey)
    .maybeSingle();
  if (r.data && (r.data as { encrypted_value: string }).encrypted_value) {
    try {
      return decryptField((r.data as { encrypted_value: string }).encrypted_value);
    } catch (err) {
      console.error("[tenant-integration-store] decrypt failed", { service, fieldKey, err });
      // Fall through to env-var fallback so a corrupt ciphertext
      // doesn't take the send path down entirely.
    }
  }
  const envKey = ENV_FALLBACKS[service]?.[fieldKey];
  if (envKey) {
    const v = process.env[envKey];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Resolve every field for a service in one round trip. Useful for
 * send paths that need (sid, token, from) together — single SELECT
 * + decrypt loop. Values that can't be resolved are absent from the
 * returned map.
 */
export async function getTenantIntegrationBundle(
  tenantId: string,
  service: string,
): Promise<Record<string, string>> {
  const db = getServiceSupabase();
  const r = await db
    .from("tenant_integration_credentials")
    .select("field_key, encrypted_value")
    .eq("tenant_id", tenantId)
    .eq("service", service);
  const bundle: Record<string, string> = {};
  for (const row of (r.data || []) as { field_key: string; encrypted_value: string }[]) {
    try {
      bundle[row.field_key] = decryptField(row.encrypted_value);
    } catch (err) {
      console.error("[tenant-integration-store] decrypt failed", { service, field: row.field_key, err });
    }
  }
  const envMap = ENV_FALLBACKS[service] || {};
  for (const [fieldKey, envKey] of Object.entries(envMap)) {
    if (bundle[fieldKey]) continue;
    const v = process.env[envKey];
    if (v && v.trim()) bundle[fieldKey] = v.trim();
  }
  return bundle;
}

/**
 * Upsert a value. Encrypts on the way in; returns the row id. Empty
 * strings are rejected — use deleteTenantIntegrationValue to clear
 * a field explicitly.
 */
export async function setTenantIntegrationValue(input: {
  tenantId: string;
  service: string;
  fieldKey: string;
  value: string;
  createdBy?: string | null;
}): Promise<IntegrationSetResult> {
  const value = (input.value || "").trim();
  if (!value) return { ok: false, error: "empty_value" };

  let encrypted: string;
  try {
    encrypted = encryptField(value);
  } catch (err) {
    return { ok: false, error: `encrypt_failed: ${(err as Error).message}` };
  }

  const db = getServiceSupabase();
  const r = await db
    .from("tenant_integration_credentials")
    .upsert(
      {
        tenant_id: input.tenantId,
        service: input.service,
        field_key: input.fieldKey,
        encrypted_value: encrypted,
        created_by: input.createdBy ?? null,
        last_tested_at: null,
        last_test_ok: null,
        last_test_error: null,
      },
      { onConflict: "tenant_id,service,field_key" },
    )
    .select("id")
    .single();
  if (r.error) return { ok: false, error: r.error.message };
  return { ok: true, id: (r.data as { id: string }).id };
}

export async function deleteTenantIntegrationValue(input: {
  tenantId: string;
  service: string;
  fieldKey: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getServiceSupabase();
  const r = await db
    .from("tenant_integration_credentials")
    .delete()
    .eq("tenant_id", input.tenantId)
    .eq("service", input.service)
    .eq("field_key", input.fieldKey);
  if (r.error) return { ok: false, error: r.error.message };
  return { ok: true };
}

/**
 * List every stored field for a tenant — returns presence + test
 * status only, NEVER the encrypted ciphertext or decrypted plaintext.
 * Settings page consumes this to render the "Verified / Not set /
 * Failed" status next to each integration field.
 */
export async function listTenantIntegrationStatus(
  tenantId: string,
): Promise<IntegrationStatusRow[]> {
  const db = getServiceSupabase();
  const r = await db
    .from("tenant_integration_credentials")
    .select("service, field_key, last_tested_at, last_test_ok, last_test_error, updated_at, encrypted_value")
    .eq("tenant_id", tenantId);
  return ((r.data || []) as StoreRow[]).map((row) => ({
    service: row.service,
    field_key: row.field_key,
    has_value: !!row.encrypted_value,
    last_tested_at: row.last_tested_at,
    last_test_ok: row.last_test_ok,
    last_test_error: row.last_test_error,
    updated_at: row.updated_at,
  }));
}

export async function recordIntegrationTest(input: {
  tenantId: string;
  service: string;
  fieldKey: string;
  ok: boolean;
  error?: string | null;
}): Promise<void> {
  const db = getServiceSupabase();
  await db
    .from("tenant_integration_credentials")
    .update({
      last_tested_at: new Date().toISOString(),
      last_test_ok: input.ok,
      last_test_error: input.ok ? null : (input.error || "test_failed"),
    })
    .eq("tenant_id", input.tenantId)
    .eq("service", input.service)
    .eq("field_key", input.fieldKey);
}

// Field-shape constants + validator live in
// lib/tenant-integration-schemas (no "server-only" marker, safe in
// client bundles). Import them directly from there — this server-only
// store owns DB CRUD and decryption only.
