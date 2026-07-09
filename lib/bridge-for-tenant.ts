/**
 * lib/bridge-for-tenant.ts — resolve the subscription-bridge target for a tenant
 * id, or null when the bridge isn't configured/eligible for it (caller then uses
 * its paid-API fallback). Soft-fail: any lookup error returns null so an AI
 * feature never breaks on a tenant/bridge lookup. Server-only.
 */
import "server-only";
import { getServiceSupabase } from "./supabase-server";
import { resolveBridgeTarget, type BridgeTarget } from "./bridge-proxy";

export async function resolveBridgeForTenant(tenantId: string): Promise<BridgeTarget | null> {
  if (!tenantId) return null;
  try {
    const r = await getServiceSupabase()
      .from("tenants")
      .select("slug, custom_fields")
      .eq("id", tenantId)
      .maybeSingle();
    const t = r.data as { slug?: string; custom_fields?: Record<string, unknown> | null } | null;
    if (!t) return null;
    return resolveBridgeTarget({ slug: (t.slug || "").toLowerCase(), custom_fields: t.custom_fields ?? null });
  } catch {
    return null;
  }
}
