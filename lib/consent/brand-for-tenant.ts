/**
 * lib/consent/brand-for-tenant.ts — which consent site, if any, a public form
 * may seal evidence under.
 *
 * WHY AN ALLOWLIST. /f/[tenant_slug]/[form_slug] is a MULTI-TENANT public route.
 * An earlier version defaulted every form to SunBiz, which meant a different
 * tenant's visitor would have had their email and phone sent to SunBiz's vault
 * and sealed against SunBiz's disclosure — wording they were never shown. An
 * evidence record that misstates what someone agreed to is worse than no record,
 * because it will be produced as if it were true.
 *
 * So the mapping is explicit and closed: a tenant not listed here captures
 * NOTHING. Adding a tenant is a deliberate act that should accompany actually
 * provisioning a capture site and disclosure for them.
 */

import type { ConsentBrand } from "./optinvault";

/** Tenant slugs that own a provisioned Opt-in Vault capture site.
 *  SunBiz's tenant row uses slug "submissions"; "sun" and "sunbiz" are the
 *  profile aliases the public URLs are served under. */
const SUNBIZ_TENANT_SLUGS = new Set(["submissions", "sunbiz", "sun"]);

/**
 * Resolve the capture site for a form, or null to capture nothing.
 *
 * Returns null for any tenant without its own site rather than falling back,
 * because a fallback here is precisely the untruthful-evidence bug above.
 */
export function consentBrandForTenant(
  tenantSlug: string | null | undefined,
  formSlug: string | null | undefined,
): ConsentBrand | null {
  const tenant = String(tenantSlug ?? "").trim().toLowerCase();
  if (!SUNBIZ_TENANT_SLUGS.has(tenant)) return null;
  // Both brands sit on the SunBiz tenant. The form decides which company the
  // visitor actually saw, and therefore whose disclosure the evidence records.
  return String(formSlug ?? "").toLowerCase().includes("bluerise") ? "bluerise" : "sunbiz";
}
