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
 * Per-service env-var fallbacks. Unregistered (service, field_key)
 * pairs DB-only — no env-var leakage path.
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

/**
 * Field-shape schema. The settings UI iterates this to render paste
 * inputs; the upsert endpoint validates against it before writing so
 * unknown (service, field_key) pairs are rejected.
 */
export type IntegrationFieldDef = {
  key: string;
  label: string;
  hint?: string;
  /** Show as a password input (masked) rather than plain text. */
  sensitive: boolean;
  /** Optional pattern validation in the upsert endpoint. */
  validation?: "phone_e164" | "url" | "email" | "alphanum_uppercase";
};

export type IntegrationSchema = {
  service: string;
  label: string;
  description: string;
  fields: IntegrationFieldDef[];
};

export const INTEGRATION_SCHEMAS: IntegrationSchema[] = [
  {
    service: "twilio",
    label: "Twilio",
    description: "SMS dispatch via Twilio. Required for the Send SMS button on the lead drawer.",
    fields: [
      { key: "account_sid", label: "Account SID", sensitive: false, validation: "alphanum_uppercase" },
      { key: "auth_token", label: "Auth Token", sensitive: true, hint: "Find this under Twilio → Account Info." },
      { key: "from_number", label: "From Number", sensitive: false, validation: "phone_e164", hint: "E.164 format, e.g. +14165551212" },
    ],
  },
  {
    service: "texttorrent",
    label: "TextTorrent",
    description: "TT API for the Text Torrent button on the lead drawer + bulk sequences.",
    fields: [
      { key: "api_key", label: "API Key", sensitive: true },
      { key: "from_number", label: "From Number (optional)", sensitive: false, validation: "phone_e164" },
    ],
  },
  {
    service: "gws",
    label: "Google Workspace (Gmail)",
    description: "Outbound email via Gmail App Password. Consumed by send_gateway.py on the operator machine.",
    fields: [
      { key: "app_password", label: "App Password", sensitive: true, hint: "Generate at myaccount.google.com/apppasswords" },
      { key: "from_address", label: "From Address", sensitive: false, validation: "email" },
    ],
  },
  {
    service: "smtp",
    label: "Custom SMTP",
    description: "Direct SMTP for outbound email (alternative to Gmail App Password).",
    fields: [
      { key: "host", label: "Host", sensitive: false, hint: "e.g. smtp.sendgrid.net" },
      { key: "port", label: "Port", sensitive: false, hint: "Usually 587 (STARTTLS) or 465 (SSL)" },
      { key: "user", label: "Username", sensitive: false },
      { key: "password", label: "Password", sensitive: true },
      { key: "from_address", label: "From Address", sensitive: false, validation: "email" },
    ],
  },
  {
    service: "n8n",
    label: "n8n",
    description: "Inbound webhook bridge (the Inbound Qualifier workflow posts here).",
    fields: [
      { key: "outbound_url", label: "Outbound URL", sensitive: false, validation: "url" },
      { key: "outbound_secret", label: "Webhook Secret", sensitive: true },
    ],
  },
  {
    service: "stripe",
    label: "Stripe",
    description: "Subscription billing + ARR widget.",
    fields: [
      { key: "secret_key", label: "Secret Key", sensitive: true, hint: "starts with sk_live_ or sk_test_" },
      { key: "publishable_key", label: "Publishable Key", sensitive: false, hint: "starts with pk_" },
    ],
  },
  {
    service: "late",
    label: "Late / Zernio",
    description: "Multi-platform social media scheduling.",
    fields: [{ key: "api_key", label: "API Key", sensitive: true }],
  },
  {
    service: "telegram",
    label: "Telegram Bridge",
    description: "Mobile notifications via BotFather.",
    fields: [{ key: "bot_token", label: "Bot Token", sensitive: true, hint: "Format: <digits>:<base64>" }],
  },
];

export function findIntegrationSchema(service: string): IntegrationSchema | null {
  return INTEGRATION_SCHEMAS.find((s) => s.service === service) || null;
}

/**
 * Validate a value against a field's `validation` pattern. Returns
 * an error string when the value is bad; null when ok or when the
 * field has no validation declared.
 */
export function validateIntegrationValue(
  field: IntegrationFieldDef,
  value: string,
): string | null {
  if (!field.validation) return null;
  switch (field.validation) {
    case "phone_e164":
      return /^\+[1-9]\d{6,14}$/.test(value) ? null : "expected E.164 phone (e.g. +14165551212)";
    case "url":
      try {
        const u = new URL(value);
        return u.protocol === "http:" || u.protocol === "https:" ? null : "url must be http(s)";
      } catch {
        return "invalid url";
      }
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : "invalid email";
    case "alphanum_uppercase":
      return /^[A-Z0-9_]+$/.test(value) ? null : "expected uppercase letters / digits / underscore";
    default:
      return null;
  }
}
