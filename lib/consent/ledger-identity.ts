/**
 * lib/consent/ledger-identity.ts — which business name and address the
 * consent ledger's disclosure names for a given workspace.
 *
 * SOURCE OF TRUTH, IN ORDER:
 *   1. lib/email/brand-for-tenant.ts -> lib/email/brands.ts. The same
 *      registry every outbound email already identifies itself under
 *      (legalName, postalAddress — both real, verified addresses CC supplied,
 *      not invented ones; see brands.ts for provenance). Today this covers
 *      SunBiz, Bluerise and OASIS's own two tenants.
 *   2. SAFE GENERIC FALLBACK, only when (1) resolves nothing. #541 ("each
 *      workspace registers the business name and address its emails go out
 *      under") is an OPEN PR, not yet merged on this branch's base
 *      (origin/main bcfa2861) — so a self-signup workspace with no mapped
 *      brand has NO registered address anywhere in this codebase today
 *      (confirmed: the `tenants` table has no address column). Inventing one
 *      would be worse than this fallback: a fabricated address is
 *      affirmatively misleading, which is precisely what brands.ts refuses to
 *      do for Bluerise's own entry. Falling back to OASIS's own real,
 *      verified identity — the platform operator, and the only legally
 *      accurate identity available until #541 ships per-workspace
 *      registration — is "truly absent, so fail closed to a safe generic",
 *      per the agreed design. `source: "generic_fallback"` on the return
 *      marks every row this produced, so it is auditable and not silently
 *      indistinguishable from a real per-workspace identity.
 *
 * KNOWN GAP, reported rather than hidden: once #541 lands, this must read
 * that table FIRST, ahead of brand-for-tenant.ts, and the generic_fallback
 * rows already written stay exactly what they say they are — evidence of
 * what was actually disclosed at the time, never rewritten.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { brandForTenant } from "@/lib/email/brand-for-tenant";
import { getBrand } from "@/lib/email/brands";
import type { ConsentIdentity } from "./ledger-disclosure";

export type ConsentIdentitySource = "brand" | "generic_fallback";

export type ResolvedConsentIdentity = {
  identity: ConsentIdentity;
  source: ConsentIdentitySource;
};

const PRIVACY_URL = "https://oasisai.work/privacy";

/** OASIS AI Solutions' own identity (lib/email/brands.ts "oasis" entry) —
 *  the safe generic used only when no workspace brand resolves. */
function genericFallbackIdentity(): ConsentIdentity {
  const b = getBrand("oasis");
  return { businessName: b.legalName, address: b.postalAddress, privacyUrl: PRIVACY_URL };
}

/**
 * Resolve the identity a workspace's public forms disclose under.
 *
 * Never throws: a database read failure resolves to the generic fallback
 * rather than blocking the enquiry — the disclosure still names a REAL,
 * accurate business (OASIS's own), it is simply not this workspace's own when
 * one exists and the read to find it failed. Marked generic_fallback either
 * way, so a read failure is never confused with "this tenant's real identity
 * IS OASIS".
 */
export function resolveConsentIdentity(args: {
  tenantId?: string | null;
  tenantSlug?: string | null;
}): ResolvedConsentIdentity {
  try {
    const brand = brandForTenant(args);
    if (brand) {
      const b = getBrand(brand);
      return {
        identity: { businessName: b.legalName, address: b.postalAddress, privacyUrl: PRIVACY_URL },
        source: "brand",
      };
    }
  } catch (err) {
    console.error("[consent.ledger-identity] brandForTenant threw", err instanceof Error ? err.message : String(err));
  }
  return { identity: genericFallbackIdentity(), source: "generic_fallback" };
}

/**
 * Unused today (resolveConsentIdentity above needs no I/O: brand-for-tenant
 * is a pure map). Exported for #541's eventual per-workspace lookup, and so a
 * caller that already holds a db handle has the right shape to extend rather
 * than inventing a second resolver. Reads tenants.name only — there is no
 * address column to read yet (confirmed via live schema inspection,
 * 2026-10-11).
 */
export async function workspaceRegisteredName(
  db: SupabaseClient,
  tenantId: string,
): Promise<string | null> {
  try {
    const row = await db.from("tenants").select("name").eq("id", tenantId).maybeSingle();
    const name = (row.data as { name?: unknown } | null)?.name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch (err) {
    console.error("[consent.ledger-identity] workspaceRegisteredName threw", err instanceof Error ? err.message : String(err));
    return null;
  }
}
