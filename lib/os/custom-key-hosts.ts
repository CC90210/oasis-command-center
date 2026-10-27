/**
 * lib/os/custom-key-hosts.ts - the one website each custom key may be sent to.
 *
 * CC, 2026-10-27: client workspaces' agents get their custom keys. They get
 * them the safe way: use_custom_key (lib/cloud-tool-runner.ts) attaches a key
 * to a GET request on the server, and only to the host its owner set here, so
 * the agent never sees the value and cannot send it anywhere else. A key with
 * no host cannot be used that way.
 *
 * Kept in tenant_integration_credentials (CUSTOM_KEY_HOST_SERVICE, field = the
 * key name lowercased), tenant-scoped like the key itself; no migration.
 */
import "server-only";

import { keyHost } from "@/lib/os/custom-keys";
import {
  CUSTOM_KEY_HOST_SERVICE,
  deleteTenantIntegrationValue,
  getTenantIntegrationValue,
  setTenantIntegrationValue,
} from "@/lib/tenant-integration-store";
import { getServiceSupabase } from "@/lib/supabase-server";
import { decryptField } from "@/lib/field-encryption";

/** Every key's host in this workspace, by key name (upper case); `ok: false` when they could not be read. */
export async function readKeyHosts(tenantId: string): Promise<{ ok: true; hosts: Map<string, string> } | { ok: false; error: string }> {
  const r = await getServiceSupabase()
    .from("tenant_integration_credentials")
    .select("field_key, encrypted_value")
    .eq("tenant_id", tenantId)
    .eq("service", CUSTOM_KEY_HOST_SERVICE);
  if (r.error) return { ok: false, error: r.error.message || "key_hosts_unreadable" };
  const hosts = new Map<string, string>();
  for (const row of (r.data || []) as { field_key: string; encrypted_value: string }[]) {
    try {
      const checked = keyHost(decryptField(row.encrypted_value));
      // An unreadable or invalid host is no host: the key cannot be sent anywhere.
      if (checked.ok) hosts.set(row.field_key.toUpperCase(), checked.host);
    } catch {
      continue;
    }
  }
  return { ok: true, hosts };
}

/** The host one key may be sent to, or null (none set, or it could not be read). */
export async function keyHostFor(tenantId: string, key: string): Promise<string | null> {
  const raw = await getTenantIntegrationValue(tenantId, CUSTOM_KEY_HOST_SERVICE, key.toLowerCase());
  if (!raw) return null;
  const checked = keyHost(raw);
  return checked.ok ? checked.host : null;
}

export async function saveKeyHost(input: { tenantId: string; key: string; host: string; createdBy?: string | null }): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await setTenantIntegrationValue({
    tenantId: input.tenantId,
    service: CUSTOM_KEY_HOST_SERVICE,
    fieldKey: input.key.toLowerCase(),
    value: input.host,
    createdBy: input.createdBy ?? null,
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export async function clearKeyHost(input: { tenantId: string; key: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  return deleteTenantIntegrationValue({ tenantId: input.tenantId, service: CUSTOM_KEY_HOST_SERVICE, fieldKey: input.key.toLowerCase() });
}
