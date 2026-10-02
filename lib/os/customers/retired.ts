/**
 * lib/os/customers/retired.ts: a retired business is never a client.
 *
 * lib/tenant/retired.ts lists the offboarded businesses (SunBiz, retired
 * 2026-09-28) for every AUTOMATED producer. Clients reaches a retired business
 * by another road: OASIS's own records ABOUT it. A won deal in OASIS's
 * pipeline, a client record linked to its workspace, the Link workspace menu.
 * Each of those names the business by its tenant id as `client_tenant_id` (on
 * the lead's data, on the customers row, or as the workspace being linked),
 * and that is what this module asks about.
 *
 * Every Clients read and write consults it:
 *   loadWonDeals, buildClientRows   a deal about a retired business is not a
 *                                   client to list or to convert;
 *   listCustomers                   a record linked to a retired workspace is
 *                                   left out of the list (Include archived still
 *                                   shows it, for its history);
 *   convertLeadToCustomer, POST /api/customers/convert
 *                                   refused, 409 retired_business;
 *   listLinkableWorkspaces, setClientWorkspace, POST /api/clients/[id]/link-workspace
 *                                   a retired workspace is not offered, and
 *                                   linking one is refused, 409 retired_business.
 * tests/retired-tenant-producers.test.ts pins each one.
 *
 * Imports only lib/tenant/retired.ts (a leaf), so the pure clients model
 * (components/os/landings/clients-model.ts) can use it in bare node.
 */
import { RETIRED_TENANT_IDS, isRetiredTenant } from "@/lib/tenant/retired";

/** Anything that names the business it is about: a lead's data, a customers row. */
export type ClientRef = { client_tenant_id?: unknown } | null | undefined;

/** True when this record is about a retired business: its client_tenant_id is a retired tenant. */
export function isRetiredClientRef(ref: ClientRef): boolean {
  const id = ref?.client_tenant_id;
  return typeof id === "string" && isRetiredTenant(id);
}

const SQL_COLUMN = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i;

/**
 * A WHERE clause that keeps the rows whose `column` is not a retired tenant
 * (NULL is kept: no business named), with its arguments. Applied in the query,
 * never after it, so a LIMITed read cannot spend its rows on records it then
 * drops. Case-insensitive, like isRetiredTenant.
 */
export function notRetiredTenantSql(column: string): { sql: string; args: string[] } {
  if (!SQL_COLUMN.test(column)) throw new Error(`notRetiredTenantSql: not a column name: ${column}`);
  const ids = [...RETIRED_TENANT_IDS];
  if (ids.length === 0) return { sql: "1 = 1", args: [] };
  return { sql: `(${column} IS NULL OR lower(${column}) NOT IN (${ids.map(() => "?").join(", ")}))`, args: ids };
}
