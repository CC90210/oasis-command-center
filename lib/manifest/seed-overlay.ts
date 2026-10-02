/**
 * lib/manifest/seed-overlay.ts - a workspace that runs on an in-code seed
 * stores its OWN agent lineup changes, never a copy of the seed.
 *
 * WHY (W4a review R2, 2026-10-01). OASIS has no tenant_manifests row: it runs
 * on OASIS_AI_CC_SEED (lib/manifest/seeds.ts), so a code change to the seed is
 * a change to OASIS. The first owner write to its lineup (a teammate built in
 * the builder, an On/Off) used to insert a full copy of the seed, brand, nav,
 * pages, data model and agents. Once a copy like that loads, every later code
 * edit to the seed stops reaching OASIS, silently, and nothing in the UI can
 * undo it. So such a workspace's row holds only
 *
 *   { "seed_overlay": true, "agents": [ ...its own bindings ] }
 *
 * and every reader (lib/manifest/loader.ts by slug and by tenant id,
 * lib/manifest/persistence.ts getManifestRow) serves the CURRENT seed with
 * those bindings applied:
 *   - a binding whose agent the seed does not bind (a teammate the workspace
 *     built, a house agent OASIS added) is appended, in the order written;
 *   - a binding of an agent the seed binds carries only its owner's switch,
 *     and only on a seed binding that is not core: its name, departments,
 *     palette and core flag keep shipping as code.
 * A seed binding cannot be removed through an overlay; changeAgentLineup
 * (lib/manifest/agent-bindings.ts) refuses, and there is no Remove in the UI.
 *
 * Only a workspace with a real seed has one: an overlay is never written for,
 * or applied to, a workspace that would otherwise get UNPROVISIONED_SEED.
 *
 * PURE: no database. Exported for the readers, the one writer and the tests.
 */
import {
  ManifestParseError,
  parseAgentBindings,
  safeParseManifest,
  type ManifestAgentBinding,
  type TenantManifest,
} from "./schema";
import { getSeedManifest, isUnprovisionedManifest } from "./seeds";

/** The marker a seed overlay row carries. */
export const SEED_OVERLAY_KEY = "seed_overlay";

export type SeedOverlay = { seed_overlay: true; agents: ManifestAgentBinding[] };

function asObject(raw: unknown): Record<string, unknown> | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** True when a stored manifest body is a seed overlay rather than a workspace's own manifest. */
export function isSeedOverlay(raw: unknown): boolean {
  return asObject(raw)?.[SEED_OVERLAY_KEY] === true;
}

/**
 * The in-code seed `slug` runs on for `tenantId`, or null when there is none
 * (getSeedManifest would answer UNPROVISIONED_SEED). The alias slugs
 * ("default", "oasis") count only for OASIS's own tenant ids, as everywhere.
 */
export function overlaySeedFor(slug: string | null | undefined, tenantId: string | null | undefined): TenantManifest | null {
  const seed = getSeedManifest(slug, tenantId);
  return isUnprovisionedManifest(seed) ? null : seed;
}

const keyOf = (slug: string) => slug.trim().toLowerCase();

/** The seed's lineup with the workspace's own bindings applied (the rules above). */
export function applySeedOverlay(seed: TenantManifest, own: readonly ManifestAgentBinding[]): TenantManifest {
  const ownBySlug = new Map<string, ManifestAgentBinding>();
  for (const b of own) if (!ownBySlug.has(keyOf(b.slug))) ownBySlug.set(keyOf(b.slug), b);
  const seedSlugs = new Set(seed.agents.map((a) => keyOf(a.slug)));
  const agents: ManifestAgentBinding[] = seed.agents.map((a) => {
    const mine = ownBySlug.get(keyOf(a.slug));
    return mine && a.core !== true ? { ...a, enabled: mine.enabled === true } : a;
  });
  for (const [key, b] of ownBySlug) if (!seedSlugs.has(key)) agents.push(b);
  return { ...seed, agents };
}

/**
 * The inverse, for the writer: the bindings a full lineup holds beyond the
 * seed (appended teammates, and the switch of a non-core seed binding that
 * differs from the seed's), which is all an overlay row stores.
 */
export function seedOverlayAgents(seed: TenantManifest, lineup: readonly ManifestAgentBinding[]): ManifestAgentBinding[] {
  const seedBySlug = new Map(seed.agents.map((a) => [keyOf(a.slug), a] as const));
  const own: ManifestAgentBinding[] = [];
  for (const b of lineup) {
    const s = seedBySlug.get(keyOf(b.slug));
    if (!s) own.push(b);
    else if (s.core !== true && (b.enabled === true) !== (s.enabled === true)) own.push({ ...s, enabled: b.enabled === true });
  }
  return own;
}

/** The body an overlay row stores. */
export function seedOverlayBody(seed: TenantManifest, lineup: readonly ManifestAgentBinding[]): SeedOverlay {
  return { seed_overlay: true, agents: seedOverlayAgents(seed, lineup) };
}

/** An overlay row's own bindings (none for no row). Throws ManifestParseError on a body that is not one. */
export function seedOverlayOwnAgents(raw: unknown): ManifestAgentBinding[] {
  if (raw === null || raw === undefined) return [];
  const body = asObject(raw);
  if (body?.[SEED_OVERLAY_KEY] !== true) throw new ManifestParseError(`$.${SEED_OVERLAY_KEY}`, "not a seed overlay");
  return parseAgentBindings(body.agents ?? []);
}

/**
 * A stored manifest body, as a reader serves it: a workspace's own manifest
 * parsed as it always was, or a seed overlay applied to the seed its row's
 * slug runs on. Never throws: a body that cannot be served is { ok: false }
 * and the reader falls back as it does for any invalid stored manifest.
 */
export function resolveStoredManifest(
  raw: unknown,
  rowSlug: string | null | undefined,
  rowTenantId: string | null | undefined,
): { ok: true; manifest: TenantManifest } | { ok: false; error: ManifestParseError } {
  const body = asObject(raw);
  if (body?.[SEED_OVERLAY_KEY] !== true) return safeParseManifest(raw);
  const seed = overlaySeedFor(rowSlug, rowTenantId);
  if (!seed) {
    return { ok: false, error: new ManifestParseError(`$.${SEED_OVERLAY_KEY}`, `no in-code seed for slug "${rowSlug ?? ""}"`) };
  }
  try {
    return { ok: true, manifest: applySeedOverlay(seed, parseAgentBindings(body.agents ?? [])) };
  } catch (err) {
    if (err instanceof ManifestParseError) return { ok: false, error: err };
    throw err;
  }
}
