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
 * The env fallback is OASIS's OWN tenants only (OASIS_ENV_CREDENTIAL_TENANT_IDS,
 * by id). Every env value is an account OASIS operates, so any other tenant
 * with no stored key gets null ("not connected"), never OASIS's account. A
 * stored credential that cannot be read (query error, bad ciphertext) is also
 * null — it is never silently replaced by the env value.
 *
 * All functions are server-only — field-encryption requires
 * BRAVO_FIELD_ENCRYPTION_KEY which never ships to the browser.
 */

import "server-only";
import type { Client, InStatement, InValue } from "@libsql/client";
import { getServiceSupabase } from "./supabase-server";
import { encryptField, decryptField } from "./field-encryption";
import { TENANT_MANUALLY_EDITABLE_INTEGRATION_SCHEMAS } from "./tenant-integration-schemas";

/**
 * Sentinel `service` value for the arbitrary KEY=VALUE vault
 * (Settings → Custom credentials). Distinct from the schema-locked
 * KNOWN_INTEGRATIONS entries (stripe, twilio, etc.) — `service="custom"`
 * rows are user-named and have no schema validation.
 *
 * Single source of truth so every reader/writer (API route, agent
 * tool, redaction loader) refers to the same string. Pre-extraction
 * this was duplicated as CUSTOM_SERVICE / CUSTOM_CREDENTIAL_SERVICE /
 * CUSTOM_VAULT_SERVICE across three files — a rename would have
 * silently drifted them.
 */
export const VAULT_CUSTOM_SERVICE = "custom";

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
  source: "stored" | "environment" | null;
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
 * leakage path. Registered pairs fall back only for an OASIS tenant
 * (tenantMayUseEnvFallback). Exported read-only so
 * tests/env-fallback-oasis-only.test.ts covers every service in it.
 */
export const ENV_FALLBACKS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  twilio: {
    account_sid: "TWILIO_ACCOUNT_SID",
    auth_token: "TWILIO_AUTH_TOKEN",
    from_number: "TWILIO_FROM_NUMBER",
    messaging_service_sid: "TWILIO_MESSAGING_SERVICE_SID",
  },
  texttorrent: {
    api_sid: "TEXTTORRENT_API_SID",
    api_public_key: "TEXTTORRENT_PUBLIC_KEY",
    api_key: "TEXTTORRENT_API_KEY",
    from_number: "TEXTTORRENT_FROM_NUMBER",
    act_as_email: "TEXTTORRENT_ACT_AS_EMAIL",
  },
  // Dedicated "follow-up" TextTorrent account (its own SID/public key) for the
  // stage-triggered drip cadences — a separate account so it gets its own 60/min
  // rate budget and never starves the live Jordan line on the shared parent key.
  texttorrent_followup: {
    api_sid: "TEXTTORRENT_FOLLOWUP_API_SID",
    api_public_key: "TEXTTORRENT_FOLLOWUP_PUBLIC_KEY",
    api_key: "TEXTTORRENT_FOLLOWUP_API_KEY",
    from_number: "TEXTTORRENT_FOLLOWUP_FROM_NUMBER",
    act_as_email: "TEXTTORRENT_FOLLOWUP_ACT_AS_EMAIL",
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
    // The App Password belongs to the SMTP login, not an arbitrary display
    // address. Matching auth-email + direct Gmail send paths keeps Settings
    // from reporting a mailbox configured when GMAIL_USER is absent.
    from_address: "GMAIL_USER",
  },
  late: {
    api_key: "LATE_API_KEY",
  },
  telegram: {
    bot_token: "TELEGRAM_BOT_TOKEN",
    chat_id: "TELEGRAM_CHAT_ID",
  },
  // Kixie (SunBiz dialer): the whole team shares ONE Kixie account, so the
  // api_key + business_id resolve tenant-wide from env — same pattern as
  // TextTorrent/Twilio above. Per-rep identity (kixie_agent_email +
  // kixie_from_number) stays in user_integration_credentials, set by each rep.
  kixie: {
    api_key: "KIXIE_API_KEY",
    business_id: "KIXIE_BUSINESS_ID",
    from_number: "KIXIE_FROM_NUMBER",
    default_agent_email: "KIXIE_DEFAULT_AGENT_EMAIL",
  },
  send_gateway: {
    hmac_secret: "OASIS_OUTBOUND_HMAC_SECRET",
  },
  // Constant Contact: the app credentials come from env (the OAuth access +
  // refresh tokens are DB-only, written by the connect flow). NOTE: APP_SECRET
  // is a generic name — confirm it holds the Constant Contact app secret.
  constant_contact: {
    client_id: "api_key_Constant_Contact",
    client_secret: "APP_SECRET",
  },
};

// Ordered aliases for one logical lane. OASIS notifications intentionally use
// OASIS_* first and the historical bare key second; SunBiz keys never appear
// here, so status cannot borrow credentials from another tenant lane.
const ENV_FALLBACK_ALIASES: Record<string, Record<string, readonly string[]>> = {
  telegram: {
    bot_token: ["OASIS_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN"],
    chat_id: ["OASIS_TELEGRAM_CHAT_ID", "TELEGRAM_CHAT_ID"],
  },
};

// Exported for tests/env-fallback-oasis-only.test.ts (env names only, never values).
export function envKeysFor(service: string, fieldKey: string): readonly string[] {
  const aliases = ENV_FALLBACK_ALIASES[service]?.[fieldKey];
  if (aliases) return aliases;
  const fallback = ENV_FALLBACKS[service]?.[fieldKey];
  return fallback ? [fallback] : [];
}

function readEnvFallback(service: string, fieldKey: string): string | null {
  for (const envKey of envKeysFor(service, fieldKey)) {
    const value = process.env[envKey];
    if (value?.trim()) return value.trim();
  }
  return null;
}

/**
 * The only tenants that may resolve a credential from the Worker's env.
 *
 * Every env value in ENV_FALLBACKS is an account OASIS operates (Stripe,
 * Gmail, Telegram, Twilio, the send-gateway HMAC …), or one it hosted for
 * SunBiz (Kixie, TextTorrent) — none is a platform default a customer may
 * borrow. Until 2026-09-28 only Stripe was gated: the Worker's STRIPE_SECRET_KEY
 * is a full live key for OASIS's Stripe (2026-09-25), and a SunBiz lead that
 * carried the website-sales marker could create payment links in OASIS's
 * account. Every other service still answered its env account to ANY tenant
 * with no key of its own, so a new client workspace would text, email and
 * notify through OASIS's accounts. Now every service is gated the same way.
 *
 * Keyed by tenant ID, not slug: a slug is display text a workspace can claim
 * (the historical "oasis" slug has no tenant row today). Verified against the
 * live `tenants` table 2026-09-28 — these are the only two tenants whose slug
 * contains "oasis". Mirrors the "oasis" rows of TENANT_ID_BRAND in
 * lib/email/brand-for-tenant.ts; tests/env-fallback-oasis-only.test.ts asserts
 * the two sets are equal, so adding an OASIS tenant is a decision made here.
 */
export const OASIS_ENV_CREDENTIAL_TENANT_IDS: ReadonlySet<string> = new Set([
  "ef8d389e-3f15-43f2-ae00-3660f69a1452", // slug "oasis-ai-cc" (also web-leads' WEBDEV_TENANT_ID)
  "42423fde-be8b-454f-932a-750e8c9b743d", // slug "oasis-webdev"
]);

/**
 * True only for an OASIS tenant id, exact match. Anything else — another
 * tenant, an unknown id, "", null — is false, so the fallback fails closed.
 * Exported so direct env readers outside this store can apply the same rule.
 */
export function tenantMayUseEnvFallback(tenantId: string | null | undefined): boolean {
  return typeof tenantId === "string" && OASIS_ENV_CREDENTIAL_TENANT_IDS.has(tenantId);
}

/**
 * Resolve a single value. Returns null when neither the DB nor the
 * env-var fallback has it. NEVER throws on missing data — callers
 * decide whether absence is fatal.
 *
 * Returns null (and logs) when the stored row cannot be read — a query
 * error or a ciphertext that will not decrypt. It never falls through to
 * the env value then: that would quietly send as a different account than
 * the one the tenant configured.
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
  if (r.error) {
    console.error("[tenant-integration-store] credential lookup failed; refusing env fallback", {
      tenantId,
      service,
      fieldKey,
      error: r.error.message,
    });
    return null;
  }
  if (r.data && (r.data as { encrypted_value: string }).encrypted_value) {
    try {
      return decryptField((r.data as { encrypted_value: string }).encrypted_value);
    } catch (err) {
      console.error("[tenant-integration-store] decrypt failed; credential unreadable, env fallback refused", {
        tenantId,
        service,
        fieldKey,
        err,
      });
      return null;
    }
  }
  if (!tenantMayUseEnvFallback(tenantId)) return null;
  return readEnvFallback(service, fieldKey);
}

/**
 * Resolve every field for a service in one round trip. Useful for
 * send paths that need (sid, token, from) together — single SELECT
 * + decrypt loop. Values that can't be resolved are absent from the
 * returned map.
 *
 * A stored field that will not decrypt stays absent and is never filled
 * from env (that would pair this tenant's sid with another account's
 * token). A query error returns an empty bundle, logged, with no env.
 */
export async function getTenantIntegrationBundle(
  tenantId: string,
  service: string,
  options: { allowEnvFallback?: boolean } = {},
): Promise<Record<string, string>> {
  const db = getServiceSupabase();
  const r = await db
    .from("tenant_integration_credentials")
    .select("field_key, encrypted_value")
    .eq("tenant_id", tenantId)
    .eq("service", service);
  if (r.error) {
    console.error("[tenant-integration-store] credential bundle lookup failed; refusing env fallback", {
      tenantId,
      service,
      error: r.error.message,
    });
    return {};
  }
  const bundle: Record<string, string> = {};
  const unreadable = new Set<string>();
  for (const row of (r.data || []) as { field_key: string; encrypted_value: string }[]) {
    try {
      bundle[row.field_key] = decryptField(row.encrypted_value);
    } catch (err) {
      unreadable.add(row.field_key);
      console.error("[tenant-integration-store] decrypt failed; credential unreadable, env fallback refused", {
        tenantId,
        service,
        field: row.field_key,
        err,
      });
    }
  }
  if (options.allowEnvFallback !== false) {
    const envMap = tenantMayUseEnvFallback(tenantId) ? ENV_FALLBACKS[service] || {} : {};
    for (const fieldKey of Object.keys(envMap)) {
      if (bundle[fieldKey] || unreadable.has(fieldKey)) continue;
      const value = readEnvFallback(service, fieldKey);
      if (value) bundle[fieldKey] = value;
    }
  }
  return bundle;
}

/**
 * Strict, value-free credential readiness for operator-facing status UI.
 *
 * Mirrors the send paths: env counts only for an OASIS tenant, and an
 * unreadable stored credential is never carried by env. A query failure or an
 * unreadable stored credential is "unavailable" (throws), never "not
 * configured". Only booleans leave this function; plaintext never does.
 */
export async function getTenantIntegrationPresenceForStatus(
  tenantId: string,
  service: string,
  fieldKeys: readonly string[],
): Promise<Record<string, boolean>> {
  if (!tenantId || !service) throw new Error("tenant_integration_status_scope_missing");
  const db = getServiceSupabase();
  const result = await db
    .from("tenant_integration_credentials")
    .select("field_key, encrypted_value")
    .eq("tenant_id", tenantId)
    .eq("service", service);
  if (result.error) {
    throw new Error(result.error.message || "tenant_integration_status_failed");
  }

  const stored = new Map(
    ((result.data || []) as Array<{ field_key: string; encrypted_value: string | null }>).map(
      (row) => [row.field_key, row.encrypted_value],
    ),
  );
  const presence: Record<string, boolean> = {};
  const envAllowed = tenantMayUseEnvFallback(tenantId);
  for (const fieldKey of fieldKeys) {
    const envPresent = envAllowed && envKeysFor(service, fieldKey).some(
      (envKey) => Boolean(process.env[envKey]?.trim()),
    );
    const encrypted = stored.get(fieldKey);
    if (!encrypted) {
      presence[fieldKey] = envPresent;
      continue;
    }
    try {
      presence[fieldKey] = Boolean(decryptField(encrypted).trim()) || envPresent;
    } catch (error) {
      console.error("[tenant-integration-store] status decrypt failed; credential unreadable", {
        tenantId,
        service,
        field: fieldKey,
        error,
      });
      // The send path returns null for this field (no env fallback), so an
      // env value must not make the status say it is configured.
      throw new Error("tenant_integration_status_decrypt_failed");
    }
  }
  return presence;
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

/**
 * Write every field of a bundle in ONE statement (one multi-row upsert), so an
 * OAuth token set is all saved or none of it is — never a new access token
 * beside the old, already-rotated refresh token. Encryption finishes for every
 * field before anything is written; a field that will not encrypt writes
 * nothing. Cloned from setUserIntegrationBundle (lib/user-integration-store.ts),
 * which fixed the same gap for personal tokens; doc 03 F7 is the tenant-side
 * instance (Constant Contact saved its tokens in three separate writes).
 */
export async function setTenantIntegrationBundle(input: {
  tenantId: string;
  service: string;
  bundle: Record<string, string>;
  createdBy?: string | null;
}): Promise<{ ok: true; written: string[] } | { ok: false; error: string }> {
  const entries = Object.entries(input.bundle);
  if (!input.tenantId || !input.service || entries.length === 0) {
    return { ok: false, error: "missing_required_field" };
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const [fieldKey, raw] of entries) {
    const value = (raw || "").trim();
    if (!fieldKey || !value) return { ok: false, error: `empty_value:${fieldKey}` };
    let encrypted: string;
    try {
      encrypted = encryptField(value);
    } catch (err) {
      return { ok: false, error: `encrypt_failed: ${(err as Error).message}` };
    }
    rows.push({
      tenant_id: input.tenantId,
      service: input.service,
      field_key: fieldKey,
      encrypted_value: encrypted,
      created_by: input.createdBy ?? null,
      last_tested_at: null,
      last_test_ok: null,
      last_test_error: null,
    });
  }
  const db = getServiceSupabase();
  const r = await db
    .from("tenant_integration_credentials")
    .upsert(rows, { onConflict: "tenant_id,service,field_key" });
  if (r.error) return { ok: false, error: r.error.message || "upsert_failed" };
  return { ok: true, written: entries.map(([k]) => k) };
}

/** A SQL condition and its arguments (lib/connections/store.ts SqlGuard). */
type CredentialGuard = { sql: string; args: InValue[] };

/**
 * A connection's credential bundle, written ONLY while `guard` holds, in one
 * atomic batch on the raw libSQL client: the same database and table the
 * PostgREST adapter writes (lib/supabase-server.ts wraps getTursoClient()).
 * The guard is the connection's own claim (lib/connections/store.ts
 * pendingClaimGuard), so a write that lost a race with a disconnect, or with a
 * newer install of the same connection, writes nothing at all: never a token
 * stored under a row that has moved on, never a newer install's token
 * overwritten. Encrypted here, exactly as setTenantIntegrationBundle does.
 */
export async function setTenantIntegrationBundleWhile(
  db: Client,
  input: { tenantId: string; service: string; bundle: Record<string, string>; createdBy?: string | null; guard: CredentialGuard; now: Date },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const entries = Object.entries(input.bundle);
  if (!input.tenantId || !input.service || entries.length === 0) return { ok: false, error: "missing_required_field" };
  const nowIso = input.now.toISOString();
  const statements: InStatement[] = [];
  for (const [fieldKey, raw] of entries) {
    const value = (raw || "").trim();
    if (!fieldKey || !value) return { ok: false, error: `empty_value:${fieldKey}` };
    let encrypted: string;
    try {
      encrypted = encryptField(value);
    } catch (err) {
      return { ok: false, error: `encrypt_failed: ${(err as Error).message}` };
    }
    statements.push({
      sql: `INSERT INTO tenant_integration_credentials
              (tenant_id, service, field_key, encrypted_value, created_by, last_tested_at, last_test_ok, last_test_error, updated_at)
            SELECT ?, ?, ?, ?, ?, NULL, NULL, NULL, ? WHERE ${input.guard.sql}
            ON CONFLICT (tenant_id, service, field_key) DO UPDATE SET
              encrypted_value = excluded.encrypted_value,
              created_by = excluded.created_by,
              last_tested_at = NULL,
              last_test_ok = NULL,
              last_test_error = NULL,
              updated_at = excluded.updated_at`,
      args: [input.tenantId, input.service, fieldKey, encrypted, input.createdBy ?? null, nowIso, ...input.guard.args],
    });
  }
  let written: number[];
  try {
    written = (await db.batch(statements, "write")).map((r) => r.rowsAffected);
  } catch (err) {
    return { ok: false, error: (err as Error).message || "upsert_failed" };
  }
  if (written.every((n) => n === 1)) return { ok: true };
  if (written.every((n) => n === 0)) return { ok: false, error: "guard_refused" };
  // One guard for every statement in one transaction: a split result is impossible.
  throw new Error("tenant_integration_store: a guarded bundle was written in part");
}

/**
 * The statement that deletes EVERY field under one service, while `guard`
 * holds, for the caller's own batch (a disconnect's: lib/connections/store.ts
 * finishDisconnect), so the credential goes in the same transaction as the
 * connection it belongs to.
 */
export function deleteTenantIntegrationServiceWhile(input: { tenantId: string; service: string; guard: CredentialGuard }): InStatement {
  if (!input.tenantId || !input.service) throw new Error("tenant_credential_scope_missing");
  return {
    sql: `DELETE FROM tenant_integration_credentials WHERE tenant_id = ? AND service = ? AND ${input.guard.sql}`,
    args: [input.tenantId, input.service, ...input.guard.args],
  };
}

/**
 * A stored credential, read with no env fallback of any kind and with its
 * failure modes kept apart: "missing" (no row), "unreadable" (a row that will
 * not decrypt) and "lookup_failed" (the query itself failed). The Connections
 * framework reports each differently — an unreadable key is not a missing one,
 * and a database outage is neither.
 */
export type StrictCredentialRead =
  | { ok: true; value: string }
  | { ok: false; reason: "missing" | "unreadable" | "lookup_failed" };

export async function readTenantCredentialStrict(
  tenantId: string,
  service: string,
  fieldKey: string,
): Promise<StrictCredentialRead> {
  if (!tenantId || !service || !fieldKey) throw new Error("tenant_credential_scope_missing");
  const db = getServiceSupabase();
  const r = await db
    .from("tenant_integration_credentials")
    .select("encrypted_value")
    .eq("tenant_id", tenantId)
    .eq("service", service)
    .eq("field_key", fieldKey)
    .maybeSingle();
  if (r.error) {
    console.error("[tenant-integration-store] strict credential lookup failed", {
      tenantId,
      service,
      fieldKey,
      error: r.error.message,
    });
    return { ok: false, reason: "lookup_failed" };
  }
  const encrypted = (r.data as { encrypted_value?: string } | null)?.encrypted_value;
  if (!encrypted) return { ok: false, reason: "missing" };
  try {
    const value = decryptField(encrypted);
    return value.trim() ? { ok: true, value } : { ok: false, reason: "missing" };
  } catch (err) {
    console.error("[tenant-integration-store] strict credential decrypt failed", { tenantId, service, fieldKey, err });
    return { ok: false, reason: "unreadable" };
  }
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
 * A stored test result as a boolean. libSQL hands an INTEGER column back as 0/1
 * (and as "0"/"1" over HTTP), so a reader comparing `=== true` never saw a
 * passing test: the Twilio card could not turn green and "Last check failed"
 * never showed (W10a, 2026-10-01). Anything unrecognised is "not tested".
 */
export function storedTestResult(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return null;
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
  if (r.error) throw new Error(r.error.message || "tenant_integration_status_failed");

  // Env-backed status exists only where the resolver would actually use env:
  // an OASIS tenant. Everyone else sees stored rows or "not connected".
  const envAllowed = tenantMayUseEnvFallback(tenantId);
  const rows = new Map<string, IntegrationStatusRow>();
  for (const row of (r.data || []) as StoreRow[]) {
    const envPresent = envAllowed && envKeysFor(row.service, row.field_key).some((envKey) =>
      Boolean(process.env[envKey]?.trim()),
    );
    let storedPresent = false;
    if (row.encrypted_value) {
      try {
        storedPresent = Boolean(decryptField(row.encrypted_value).trim());
      } catch (error) {
        console.error("[tenant-integration-store] list status decrypt failed; credential unreadable", {
          tenantId,
          service: row.service,
          field: row.field_key,
          error,
        });
        // Never reported as env-backed: the resolver refuses env for an
        // unreadable row, so "environment" here would be a false green.
        throw new Error("tenant_integration_status_decrypt_failed");
      }
    }
    rows.set(`${row.service}:${row.field_key}`, {
      service: row.service,
      field_key: row.field_key,
      has_value: storedPresent || envPresent,
      last_tested_at: row.last_tested_at,
      last_test_ok: storedTestResult(row.last_test_ok),
      last_test_error: row.last_test_error,
      updated_at: row.updated_at,
      source: storedPresent ? "stored" : envPresent ? "environment" : null,
    });
  }

  // Environment-backed integrations are real production configuration even
  // when no encrypted tenant row exists. Synthesize value-free status rows so
  // Credentials cannot say "not set" while the send path is actively using
  // GMAIL_USER/GMAIL_APP_PASSWORD (or another canonical fallback). OASIS
  // tenants only — no other tenant can resolve these, so none is synthesized.
  for (const schema of envAllowed ? TENANT_MANUALLY_EDITABLE_INTEGRATION_SCHEMAS : []) {
    for (const field of schema.fields) {
      const key = `${schema.service}:${field.key}`;
      if (rows.has(key)) continue;
      const envPresent = envKeysFor(schema.service, field.key).some((envKey) =>
        Boolean(process.env[envKey]?.trim()),
      );
      if (!envPresent) continue;
      rows.set(key, {
        service: schema.service,
        field_key: field.key,
        has_value: true,
        last_tested_at: null,
        last_test_ok: null,
        last_test_error: null,
        updated_at: null,
        source: "environment",
      });
    }
  }

  return [...rows.values()];
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
