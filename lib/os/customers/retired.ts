/**
 * lib/os/customers/retired.ts: a retired business is never a client.
 *
 * lib/tenant/retired.ts lists the offboarded businesses (SunBiz, retired
 * 2026-09-28) for every AUTOMATED producer. Clients reaches a retired business
 * by another road: OASIS's own records ABOUT it. A won deal in OASIS's
 * pipeline, a client record linked to its workspace, a delivery project or
 * ticket naming its workspace, the pickers and matchers that offer or guess a
 * client. Each of those names the business by its tenant id as
 * `client_tenant_id` (on the lead's data, the customers row, the project or
 * ticket, or the workspace being linked), and that is what this module asks
 * about. It is the ONE rule: every client-facing read and validator below
 * consults it, and nothing else decides it.
 *
 *   lists      buildClientRows (deals, projects and tickets), loadWonDeals,
 *              listCustomers (Include archived too), listLinkableWorkspaces,
 *              listClientTenants (lib/delivery/store.ts);
 *   pickers    listCustomerOptions (the ticket and project Client select),
 *              listClientTenants (their client-workspace select, where a
 *              row's existing link to a retired workspace shows as a
 *              disabled "Former client workspace" that None clears:
 *              components/delivery/client-workspace-options.tsx);
 *   matches    matchCustomerByEmail and isCustomerEmail (support intake,
 *              email purpose), matchClientByEmail (its project step and its
 *              workspace step);
 *   validators clientTenantExists, deskCustomerExists (lib/delivery/store.ts;
 *              an edit is refused a NEW retired link only, so a row linked
 *              before the retirement can still be saved and unlinked:
 *              clientTenantChangeAllowed), convertLeadToCustomer and POST
 *              /api/customers/convert, setClientWorkspace and POST
 *              /api/clients/[id]/link-workspace (409 retired_business);
 *   the record loadClientHeader and loadClientRecord: a record linked to a
 *              retired workspace is a 404, like another workspace's record,
 *              so no tab ever reads the retired workspace (Usage included);
 *              ClientRecordCard draws no card on a deal about a retired
 *              business or on one whose record is linked to its workspace.
 * tests/retired-tenant-producers.test.ts pins each one, with
 * tests/os-customers.test.ts (the matcher's project step, editing an existing
 * link, the select) and tests/clients-hub.test.ts (the record, the deal card).
 *
 * Not consulted yet: the Slack channel mapper (app/api/slack/channels and
 * saveChannelRoute in lib/slack/routing.ts) reads customers directly. That
 * code is on hold with the Slack work; when it resumes it must take its
 * records from listCustomerOptions.
 *
 * A typed name is not a link: a deal or project that only SAYS "SunBiz" is
 * not caught here, because a name proves nothing. Rows like that are retired
 * by archiving them (scripts/clients-blank-start.ts). Breeze is not an OASIS
 * workspace at all, so no id can name it: its record and deal are archived the
 * same way.
 *
 * Imports only lib/tenant/retired.ts (a leaf; the libSQL import is a type), so
 * the pure clients model (components/os/landings/clients-model.ts) can use it
 * in bare node.
 */
import type { ResultSet } from "@libsql/client";
import { RETIRED_TENANT_IDS, isRetiredTenant } from "@/lib/tenant/retired";

/** Anything that names the business it is about: a lead's data, a customers row, a project, a ticket. */
export type ClientRef = { client_tenant_id?: unknown } | null | undefined;

/** True when this record is about a retired business: its client_tenant_id is a retired tenant. */
export function isRetiredClientRef(ref: ClientRef): boolean {
  const id = ref?.client_tenant_id;
  return typeof id === "string" && isRetiredTenant(id);
}

const SQL_COLUMN = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i;

/** A SQL condition and its arguments. */
export type SqlGuard = { sql: string; args: string[] };

/**
 * A WHERE clause that keeps the rows whose `column` is not a retired tenant
 * (NULL is kept: no business named), with its arguments. Applied in the query,
 * never after it, so a LIMITed read cannot spend its rows on records it then
 * drops. Case-insensitive, like isRetiredTenant.
 *
 * The one exception is won deals (loadWonDeals in
 * components/os/landings/clients-data.ts): a deal names its business inside
 * its JSON data, which the shared lead reader cannot filter on, so those rows
 * are dropped with isRetiredClientRef after the read. That read is capped at
 * 1000 deals and the page says when the cap is hit, so a dropped row can cost
 * a slot but never hides that the list was cut.
 */
export function notRetiredTenantSql(column: string): SqlGuard {
  if (!SQL_COLUMN.test(column)) throw new Error(`notRetiredTenantSql: not a column name: ${column}`);
  const ids = [...RETIRED_TENANT_IDS];
  if (ids.length === 0) return { sql: "1 = 1", args: [] };
  return { sql: `(${column} IS NULL OR lower(${column}) NOT IN (${ids.map(() => "?").join(", ")}))`, args: ids };
}

/**
 * Run a read of client records with the guard on their client_tenant_id
 * (`column`). A database without migration bravo__195 has no client_tenant_id
 * column, so no record there can name a retired workspace: the read runs again
 * with a guard that keeps every row, as every other read treats that database
 * ("not linked"). Any other failure is thrown.
 */
export async function readNotRetired(column: string, read: (guard: SqlGuard) => Promise<ResultSet>): Promise<ResultSet> {
  try {
    return await read(notRetiredTenantSql(column));
  } catch (err) {
    if (!/no such column: (?:[a-z_]+\.)?client_tenant_id\b/i.test(err instanceof Error ? err.message : String(err))) throw err;
    return read({ sql: "1 = 1", args: [] });
  }
}
