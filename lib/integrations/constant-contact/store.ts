/**
 * lib/integrations/constant-contact/store.ts — CC OAuth token store + client
 * factory. Tokens live encrypted in tenant_integration_credentials
 * (service='constant_contact'); client_id / client_secret resolve from the
 * env-var fallbacks (api_key_Constant_Contact / APP_SECRET). Server-only.
 */
import "server-only";
import {
  getTenantIntegrationValue,
  getTenantIntegrationBundle,
  setTenantIntegrationValue,
} from "@/lib/tenant-integration-store";
import { ConstantContactClient, type TokenStore, type CCTokens } from "./client";

export const CC_SERVICE = "constant_contact";
export const CC_SCOPES = ["contact_data", "campaign_data", "account_read"];
// The redirect URI must match EXACTLY what's registered in the CC developer app.
// Defaults to prod; override with CONSTANT_CONTACT_REDIRECT_URI if needed.
export const CC_REDIRECT_URI =
  process.env.CONSTANT_CONTACT_REDIRECT_URI ||
  "https://oasisai.work/api/integrations/constant-contact/callback";

/** TokenStore backed by the encrypted tenant credential store. Persists the rotated refresh token every save. */
export function ccTokenStore(tenantId: string): TokenStore {
  return {
    async load() {
      const b = await getTenantIntegrationBundle(tenantId, CC_SERVICE);
      if (!b.access_token || !b.refresh_token) return null;
      return {
        access_token: b.access_token,
        refresh_token: b.refresh_token,
        expires_at: Number(b.expires_at) || 0,
      };
    },
    async save(t: CCTokens) {
      await setTenantIntegrationValue({ tenantId, service: CC_SERVICE, fieldKey: "access_token", value: t.access_token });
      await setTenantIntegrationValue({ tenantId, service: CC_SERVICE, fieldKey: "refresh_token", value: t.refresh_token });
      await setTenantIntegrationValue({ tenantId, service: CC_SERVICE, fieldKey: "expires_at", value: String(t.expires_at) });
    },
  };
}

/** Resolve the app credentials (env-var fallback). Null if not configured. */
export async function ccCredentials(tenantId: string): Promise<{ clientId: string; clientSecret: string } | null> {
  const clientId = await getTenantIntegrationValue(tenantId, CC_SERVICE, "client_id");
  const clientSecret = await getTenantIntegrationValue(tenantId, CC_SERVICE, "client_secret");
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** A ready client, or null when the app credentials aren't configured. Throws inside on a missing token (not connected). */
export async function getConstantContactClient(tenantId: string): Promise<ConstantContactClient | null> {
  const creds = await ccCredentials(tenantId);
  if (!creds) return null;
  return new ConstantContactClient(creds.clientId, creds.clientSecret, ccTokenStore(tenantId));
}

/** Has this tenant completed the OAuth connect (tokens present)? */
export async function ccIsConnected(tenantId: string): Promise<boolean> {
  const b = await getTenantIntegrationBundle(tenantId, CC_SERVICE);
  return !!(b.access_token && b.refresh_token);
}
