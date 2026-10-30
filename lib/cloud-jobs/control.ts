import { WEBDEV_TENANT_ID } from "@/lib/oasis-tenant";

/**
 * The API-only handover jobs are OASIS-owned, not multi-tenant background
 * scans. Reuse the product's canonical OASIS workspace id so every read and
 * write carries an explicit tenant boundary.
 */
export const OASIS_OPERATOR_TENANT_ID = WEBDEV_TENANT_ID;

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** Fail closed: only the literal value "on" starts a migrated job. */
export function cloudJobEnabled(key: string, env: EnvLike = process.env): boolean {
  return env[key]?.trim().toLowerCase() === "on";
}

/**
 * An authenticated `?dry_run=1` request is the common migration canary.
 * A per-job DRY_RUN env switch is also supported so a live schedule can be
 * observed without a deploy. Dry-run means zero writes or other outward
 * effects; jobs may still read their database and read-only provider APIs to
 * produce a truthful plan. Jobs that offer a config-only mode label it in
 * their response. Neither spelling is inferred from a truthy typo.
 */
export function cloudJobDryRun(
  request: Request,
  envKey: string,
  env: EnvLike = process.env,
): boolean {
  return new URL(request.url).searchParams.get("dry_run") === "1" || env[envKey] === "1";
}

export function operatorEmail(env: EnvLike = process.env): string {
  return env.OPERATOR_EMAIL?.trim().toLowerCase() || "conaugh@oasisai.work";
}
