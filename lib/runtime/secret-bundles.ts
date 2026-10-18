/**
 * lib/runtime/secret-bundles.ts - many Worker secrets carried in a few.
 *
 * WHY. Cloudflare allows 128 secrets plus vars per Worker (Workers Paid). This Worker reached it on 2026-10-18: a new
 * secret was refused with "Too many text bindings" until a dead one was deleted, and every new integration would hit
 * the same wall (CC: "we need to avoid this"). A bundle is ONE secret, named OCC_SECRET_BUNDLE_<n>, whose value is a
 * JSON object of many secrets ({"STRIPE_SECRET_KEY": "...", ...}), at most 5 KB (Cloudflare's per-secret size).
 * worker-entry.ts expands every bundle into the env the app is given, before OpenNext copies that env into
 * process.env, so app code reads a bundled key exactly as it reads an individual one.
 *
 * RULES
 *   - A key also set individually wins over its bundled copy. That is what makes the move safe: a bundle is pushed
 *     while the individual secrets still exist (nothing changes), the two are compared by digest, and only then is
 *     the individual deleted, which frees its slot.
 *   - The bundle secrets themselves are dropped from the env, so their JSON never reaches process.env.
 *   - A bundle that is not a JSON object of strings is skipped as a whole and named in the report: its keys stay
 *     unset rather than half set, and the entry logs it.
 *   - OCC_SECRET_BUNDLE_DIGESTS (a JSON {key: digest}) records each bundled value's digest, never the value, so the
 *     signed digest check (app/api/internal/tools/secret-digests) can prove an individual secret and its bundled copy
 *     are the same before the individual is deleted.
 *
 * No server-only import: worker-entry.ts runs outside Next's bundle, where that package's guard throws.
 */
import { createHash } from "node:crypto";

export const SECRET_BUNDLE_KEY = /^OCC_SECRET_BUNDLE_\d{1,2}$/;
export const SECRET_BUNDLE_DIGESTS_KEY = "OCC_SECRET_BUNDLE_DIGESTS";
/** Cloudflare's size limit for one secret, in bytes. A bundle is built to stay under it. */
export const SECRET_BUNDLE_MAX_BYTES = 5 * 1024;

export type SecretBundleReport = {
  /** The bundles read, by name. */
  bundles: string[];
  /** Keys added to the env from bundles (not counting ones an individual secret shadows). */
  added: number;
  /** Keys present in a bundle AND individually: the individual is the one used. */
  shadowed: string[];
  /** Bundles skipped because their value is not a JSON object of strings. */
  invalid: string[];
};

/** A short, non-reversible fingerprint of a secret's value: the first 12 hex characters of its SHA-256. */
export function secretDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

function bundleEntries(raw: unknown): Array<[string, string]> | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (!entries.every(([key, value]) => isSecretName(key) && typeof value === "string")) {
    return null;
  }
  return entries as Array<[string, string]>;
}

/**
 * An env-style key a bundle may carry. "__proto__" (and the other names an ordinary object treats specially) fits the
 * pattern but is never a secret, and assigning it would set a prototype instead of a value (CodeRabbit on #699).
 */
export function isSecretName(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) && !RESERVED_NAMES.has(key);
}
const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Remove the raw bundle secrets from process.env. With nodejs_compat (this compatibility date populates process.env
 * from the Worker's bindings at isolate start), each bundle's JSON is copied there before worker-entry.ts runs, and
 * OpenNext only adds keys, never removes them (CodeRabbit on #699). The values are the same ones the app reads
 * individually; this keeps the rule that a bundle's JSON never sits in process.env. Returns how many it removed.
 */
export function scrubBundlesFromProcessEnv(processEnv: Record<string, string | undefined>): number {
  let removed = 0;
  for (const name of Object.keys(processEnv)) {
    if (SECRET_BUNDLE_KEY.test(name)) {
      delete processEnv[name];
      removed += 1;
    }
  }
  return removed;
}

/**
 * The env the app is given: every bundle's keys added, individual secrets winning, bundle secrets removed, plus the
 * digests record. The input is never changed (a Worker's env object is not ours to mutate); bindings pass through.
 */
export function expandSecretBundles<E extends Record<string, unknown>>(env: E): { env: E; report: SecretBundleReport } {
  const report: SecretBundleReport = { bundles: [], added: 0, shadowed: [], invalid: [] };
  // Null-prototype records: a key is always an own property (isSecretName already refuses the special names).
  const fromBundles: Record<string, string> = Object.create(null);
  const digests: Record<string, string> = Object.create(null);
  const passThrough: Record<string, unknown> = {};
  for (const name of Object.keys(env).sort()) {
    if (!SECRET_BUNDLE_KEY.test(name)) {
      if (name !== SECRET_BUNDLE_DIGESTS_KEY) passThrough[name] = env[name];
      continue;
    }
    const entries = bundleEntries(env[name]);
    if (!entries) {
      report.invalid.push(name);
      continue;
    }
    report.bundles.push(name);
    for (const [key, value] of entries) {
      fromBundles[key] = value;
      digests[key] = secretDigest(value);
    }
  }
  for (const key of Object.keys(fromBundles)) {
    if (Object.prototype.hasOwnProperty.call(passThrough, key)) report.shadowed.push(key);
    else report.added += 1;
  }
  const merged = {
    ...fromBundles,
    ...passThrough,
    ...(report.bundles.length ? { [SECRET_BUNDLE_DIGESTS_KEY]: JSON.stringify(digests) } : {}),
  };
  return { env: merged as E, report };
}
