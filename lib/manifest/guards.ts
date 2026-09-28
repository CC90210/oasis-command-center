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

import { SEED_MANIFESTS, UNPROVISIONED_SLUG } from "./seeds";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { getServiceSupabase } from "@/lib/supabase-server";

/**
 * Slugs no tenant may write a manifest for, whoever asks.
 *
 * The platform seed names (default/oasis/sun/suga), plus, since 2026-09-28
 * (P0-3), the live slugs of OASIS's and SunBiz's own workspaces and the
 * unprovisioned placeholder. oasis-ai-cc is a seed with no stored row, so
 * before this a tenant admin's first write would have claimed it and CC's
 * workspace would have rendered the claimer's manifest. oasis-webdev,
 * submissions and sunbiz are those tenants' own names. OASIS itself cannot
 * edit these through the manifest routes either: its workspace is defined in
 * code and changes ship as code.
 */
export const PROTECTED_SLUGS: ReadonlySet<string> = new Set([
  "default",
  "oasis",
  "sun",
  "suga",
  "oasis-ai-cc",
  "oasis-webdev",
  "submissions",
  "sunbiz",
  UNPROVISIONED_SLUG,
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
      reason: "This workspace name is reserved and its manifest cannot be changed here.",
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

const OWNER_UNVERIFIED: GuardFail = {
  ok: false,
  status: 503,
  error: "slug_owner_unverified",
  reason: "Could not check who owns this workspace name. Try again in a moment.",
};

/**
 * Reject writes to a manifest already bound to a different tenant.
 *
 * Outcomes:
 *   - row doesn't exist yet      → see unclaimedSlugGuard below
 *   - row exists, tenant_id null → 403 unowned_manifest
 *   - row exists, same tenant    → ok
 *   - row exists, other tenant   → 403 cross_tenant_forbidden
 *   - the lookup fails           → 503 slug_owner_unverified
 *
 * WHY THE LAST TWO CHANGED (2026-09-28, P0-3). A row with no tenant used to be
 * "the legacy seed claim path": any tenant admin could write it and the save
 * kept tenant_id NULL, so the row stayed claimable by the next writer too.
 * None exist live, so refusing costs nothing and closes it.
 *
 * The lookup used to go through getManifestRow(...).catch(() => null), which
 * read BOTH a DB error and a stored body that no longer parses as "no row".
 * saveManifest keeps the prior row's tenant_id, so a foreign row with a broken
 * body could be overwritten by anyone its slug did not otherwise protect. This
 * reads the owner column only, without parsing, and a failed read refuses
 * with a retryable 503 rather than guessing. The old reason for letting
 * errors through was to avoid a false "cross_tenant" 403 during a DB blip;
 * the 503 says what actually happened.
 */
export async function crossTenantGuard(
  slug: string,
  callerTenantId: string
): Promise<GuardResult> {
  const lookup = await getServiceSupabase()
    .from("tenant_manifests")
    .select("tenant_id")
    .eq("slug", slug)
    .maybeSingle();
  if (lookup.error) {
    console.error("[manifest.guards] manifest owner lookup failed", {
      slug,
      error: lookup.error.message,
    });
    return OWNER_UNVERIFIED;
  }
  const existing = lookup.data as { tenant_id: string | null } | null;
  if (!existing) return unclaimedSlugGuard(slug, callerTenantId);
  if (!existing.tenant_id) {
    return {
      ok: false,
      status: 403,
      error: "unowned_manifest",
      reason: "This workspace name has no owner on record, so it cannot be claimed.",
    };
  }
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
    console.error("[manifest.guards] slug owner lookup failed", {
      slug,
      error: (caller.error || holders.error)?.message,
    });
    return OWNER_UNVERIFIED;
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
