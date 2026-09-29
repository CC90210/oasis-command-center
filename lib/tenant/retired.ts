/**
 * lib/tenant/retired.ts — tenants that have been offboarded.
 *
 * A retired tenant's data is waiting to be exported and deleted. Nothing
 * automated may write new rows for it: no cron, no health lane, no webhook, no
 * metrics snapshot. Otherwise the tables refill between the export and the
 * delete, and the deletion certificate is wrong the moment it is written.
 *
 * This is the one list every automated producer consults. Retiring a future
 * client is one line here plus the data-level freeze; the producers already
 * skip whatever this set contains.
 *
 * Deliberately a leaf module with no imports, so any layer (cron routes, lib,
 * webhooks, the Turso RPC shim) can use it without an import cycle.
 */

/**
 * SunBiz (tenant slug `submissions`, profile slug `sun`, brands sunbiz and
 * bluerise). Retired 2026-09-28 on CC's order; runbook step C-6a in
 * docs/os-revamp/02-data-safety-sunbiz-retirement.md.
 */
export const SUNBIZ_RETIRED_TENANT_ID = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

export const RETIRED_TENANT_IDS: ReadonlySet<string> = new Set([SUNBIZ_RETIRED_TENANT_ID]);

/**
 * True when automated work must not write anything for this tenant.
 * Case-insensitive, because Postgres canonicalises uuids to lowercase while
 * some callers carry them as they were typed.
 */
export function isRetiredTenant(tenantId: string | null | undefined): boolean {
  if (typeof tenantId !== "string") return false;
  return RETIRED_TENANT_IDS.has(tenantId.trim().toLowerCase());
}

/**
 * The retired ids as a PostgREST list literal, for excluding them in the query
 * itself: `.not("tenant_id", "in", RETIRED_TENANT_ID_LIST)`.
 *
 * Use this rather than a JS filter on any query that is ordered and LIMITed
 * (claim queues, "stalest first" pollers): filtering after the limit would let
 * the retired tenant's rows fill every slot and starve every other tenant.
 *
 * NULL tenant_id rows are also excluded by `NOT (tenant_id IN (...))`, so use
 * it only on tables where tenant_id is always set; filter in JS otherwise.
 */
export const RETIRED_TENANT_ID_LIST = `(${[...RETIRED_TENANT_IDS].join(",")})`;
