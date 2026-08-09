/**
 * lib/health/coverage.ts — discovers what EXISTS so nothing stays invisible.
 *
 * The root cause of the 2026-08-06 incident was not a missing check. It was a
 * hand-maintained watch list: 9 services were listed, the estate has ~20 cron
 * routes, 2 brands, 2 channels and a dozen integrations, and anything not on
 * the list was invisible. Nobody remembers to add things.
 *
 * So coverage is DERIVED, not declared:
 *   - crons      from vercel.json
 *   - brands     from the brand registry
 *   - sequences  from drip_sequences
 *
 * And the gap itself is reportable: anything discovered with no check attached
 * shows up in `uncovered`. Uncovered surface is a finding, not a silence.
 *
 * Pure except for the sequence lookup, so the discovery rules are testable.
 */

import { ALL_BRAND_KEYS } from "@/lib/email/brands";

export type Discovered = {
  crons: string[];
  brands: string[];
  checkIds: string[];
  /** Discovered surface with no check attached. This list should be empty, and
   *  when it is not, that is the alert. */
  uncovered: string[];
};

/**
 * Parse cron paths out of a vercel.json object. Takes the parsed config rather
 * than reading the file, so this is testable and works in any runtime.
 */
export function cronPathsFrom(vercelConfig: unknown): string[] {
  const cfg = vercelConfig as { crons?: Array<{ path?: string }> } | null;
  const crons = Array.isArray(cfg?.crons) ? cfg!.crons : [];
  return crons
    .map((c) => String(c?.path || "").split("?")[0].trim())
    .filter((p) => p.startsWith("/api/"))
    // Distinct: several crons hit the same route with different query strings.
    .filter((p, i, all) => all.indexOf(p) === i)
    .sort();
}

/** Canonical check id for a cron route, so discovery and checks agree. */
export function cronCheckId(path: string): string {
  return `cron${path.replace(/^\/api\/cron/, "").replace(/\//g, ".")}.ran`;
}

/**
 * What exists, what is checked, and what is neither.
 *
 * `knownCheckIds` is what the registry actually implements. Everything
 * discovered that has no corresponding id lands in `uncovered`.
 */
export function computeCoverage(args: {
  vercelConfig: unknown;
  knownCheckIds: string[];
  sequenceStages?: string[];
}): Discovered {
  const crons = cronPathsFrom(args.vercelConfig);
  const brands = [...ALL_BRAND_KEYS];
  const known = new Set(args.knownCheckIds);

  const uncovered: string[] = [];

  for (const path of crons) {
    // The health check route monitoring itself would be circular.
    if (path.includes("/health-check")) continue;
    if (!known.has(cronCheckId(path))) uncovered.push(cronCheckId(path));
  }
  for (const b of brands) {
    if (!known.has(`brand.${b}.sendable`)) uncovered.push(`brand.${b}.sendable`);
  }
  for (const stage of args.sequenceStages || []) {
    if (!known.has(`drips.${stage}.sent_24h`)) uncovered.push(`drips.${stage}.sent_24h`);
  }

  return { crons, brands, checkIds: [...known].sort(), uncovered: uncovered.sort() };
}
