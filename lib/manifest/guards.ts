/**
 * Manifest-route guards.
 *
 * The protected-slug list + cross-tenant check appear in THREE routes
 * (/api/manifest/[slug] POST, /api/manifest/chat POST, /api/onboarding/wizard)
 * and were drifting before this consolidation. Single source of truth lives
 * here so a new guard added in one place propagates to every consumer.
 *
 * Why a `Result` object instead of throwing: every consumer wants to return
 * a JSON response with the same shape. A thrown error would force each
 * caller to translate exception → NextResponse, and the translations were
 * already inconsistent (some returned `error: "protected_slug"`, some
 * returned `error: "forbidden"`). Consolidating the response payload here
 * forces callers to use the canonical shape.
 */

import { getManifestRow } from "./persistence";
import { SEED_MANIFESTS } from "./seeds";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { getServiceSupabase } from "@/lib/supabase-server";

export const PROTECTED_SLUGS: ReadonlySet<string> = new Set([
  "default",
  "oasis",
  "sun",
  "suga",
]);

export type GuardOk = { ok: true };
export type GuardFail = {
  ok: false;
  status: number;
  error: string;
  reason?: string;
};
export type GuardResult = GuardOk | GuardFail;

/**
 * Reject mutations against the platform-managed seed slugs.
 * Tenants modify their OWN manifest; the seeds are the safety-net fallback
 * everyone reads when their own row is missing or unreachable.
 */
export function protectedSlugGuard(slug: string): GuardResult {
  if (PROTECTED_SLUGS.has(slug)) {
    return {
      ok: false,
      status: 403,
      error: "protected_slug",
      reason:
        "Platform seed manifests cannot be modified. Create your own tenant via /onboarding/wizard.",
    };
  }
  return { ok: true };
}

const CROSS_TENANT: GuardFail = {
  ok: false,
  status: 403,
  error: "cross_tenant_forbidden",
  reason: "This manifest belongs to another tenant.",
};

/**
 * Reject writes to a manifest already bound to a different tenant.
 *
 * Outcomes:
 *   - row doesn't exist yet      → see unclaimedSlugGuard below
 *   - row exists, tenant_id null → ok (legacy seed claim path)
 *   - row exists, same tenant    → ok
 *   - row exists, other tenant   → 403 cross_tenant_forbidden
 *
 * Defensive on DB errors: if the row fetch fails we let it through to the
 * no-row check, which still refuses a slug that belongs to someone else. The
 * subsequent save will hit the same DB and surface the error to the caller;
 * blocking here would create a false-positive "cross_tenant" 403 during
 * Supabase transients.
 */
export async function crossTenantGuard(
  slug: string,
  callerTenantId: string
): Promise<GuardResult> {
  const existing = await getManifestRow(slug).catch(() => null);
  if (!existing) return unclaimedSlugGuard(slug, callerTenantId);
  if (!existing.tenant_id) return { ok: true };
  if (existing.tenant_id === callerTenantId) return { ok: true };
  return CROSS_TENANT;
}

/**
 * A slug with no tenant_manifests row is NOT automatically free.
 *
 * WHY (2026-09-11). "No row → the first writer claims it" let any tenant admin
 * take OASIS's own namespace. oasis-ai-cc is a seed manifest and OASIS has
 * never written a row for it, so SunBiz's owner or admins (or any self-signup
 * owner) could POST /api/manifest/oasis-ai-cc and claim it. After that
 * resolveDataTenant denies OASIS its own slug, and the claimer's manifest
 * renders under OASIS's name. oasis-webdev is not even a seed, so the wizard
 * would hand it to anyone as well.
 *
 * So a row-less slug is refused when it is reserved for somebody else:
 *   - it is a seed key (the platform's code manifests), or
 *   - it is another tenant's tenants.slug.
 * UNLESS it is the caller's own client-profile slug, the same test
 * resolveDataTenant uses to grant data access on a row-less slug. OASIS can
 * therefore still claim oasis-ai-cc, and every seed stays readable, because
 * this only runs on writes.
 *
 * Fails CLOSED on a lookup error: if we cannot tell whose slug this is, the
 * claim waits for a retry rather than guessing.
 */
async function unclaimedSlugGuard(
  slug: string,
  callerTenantId: string
): Promise<GuardResult> {
  const db = getServiceSupabase();
  const [caller, holders] = await Promise.all([
    db.from("tenants").select("id, slug, custom_fields").eq("id", callerTenantId).maybeSingle(),
    db.from("tenants").select("id").eq("slug", slug).limit(5),
  ]);
  if (caller.error || holders.error) {
    return {
      ok: false,
      status: 503,
      error: "slug_owner_unverified",
      reason: "Could not check who owns this workspace name. Try again in a moment.",
    };
  }

  const callerTenant = caller.data as Parameters<typeof resolveClientProfileSlug>[0];
  if (resolveClientProfileSlug(callerTenant) === slug) return { ok: true };

  const isSeed = Object.prototype.hasOwnProperty.call(SEED_MANIFESTS, slug);
  const heldByOther = ((holders.data || []) as Array<{ id: string }>).some(
    (t) => t.id !== callerTenantId
  );
  return isSeed || heldByOther ? CROSS_TENANT : { ok: true };
}

/**
 * Sugar that runs the two guards in canonical order. Returns the first
 * failure or `ok`. Most callers want this, not the individual functions.
 */
export async function manifestWriteGuards(
  slug: string,
  callerTenantId: string
): Promise<GuardResult> {
  const proto = protectedSlugGuard(slug);
  if (!proto.ok) return proto;
  return crossTenantGuard(slug, callerTenantId);
}
