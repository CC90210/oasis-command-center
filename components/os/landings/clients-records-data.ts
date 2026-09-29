/**
 * clients-records-data — the reads behind /clients (the `customers` list) and
 * /clients/[id] (one record and its tabs). Every read takes the tenant from the
 * viewer the page resolved from the SESSION (lib/os/customers/session.ts); the
 * store binds it into every WHERE.
 *
 * Each read reports ok / not_set_up / not_allowed / error separately, so a page
 * can say "client records are not set up yet", "owners only" and "this failed"
 * in different words, and none of them is a 0 or an empty list.
 *
 *   not_set_up   the customers table is missing (migration bravo__188).
 *   not_allowed  the tab needs the workspace's desk (owners and admins):
 *                tickets, projects, files and the source deal's activity hold
 *                every customer's messages and documents.
 */
import "server-only";

import type { Client } from "@libsql/client";
import { getTenantMembers, type MemberRow } from "@/lib/team";
import { listProjects, listTickets, type Project, type Ticket } from "@/lib/delivery/store";
import {
  customerIdsBySourceLead,
  getCustomer,
  isMissingCustomersSchema,
  listContacts,
  listCustomers,
  listLeadActivity,
  listLeadFiles,
  type ActivityItem,
  type Customer,
  type CustomerContact,
  type CustomerFilters,
  type CustomerListRow,
  type LeadFile,
} from "@/lib/os/customers/store";
import { getCustomersDb, type ClientsViewer } from "@/lib/os/customers/session";

export type Loaded<T> =
  | { state: "ok"; value: T }
  | { state: "not_set_up" }
  | { state: "not_allowed" }
  | { state: "error" };

async function attempt<T>(label: string, fn: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { state: "ok", value: await fn() };
  } catch (err) {
    if (isMissingCustomersSchema(err)) return { state: "not_set_up" };
    console.error(`[os.clients.${label}]`, err);
    return { state: "error" };
  }
}

function dbOrThrow(): Client {
  const db = getCustomersDb();
  if (!db) throw new Error("Turso is not configured on this deployment");
  return db;
}

/** The workspace's clients, with desk counts only for a viewer who may read the desk. */
export function loadCustomerRecords(
  viewer: ClientsViewer,
  filters: CustomerFilters,
): Promise<Loaded<{ rows: CustomerListRow[]; truncated: boolean }>> {
  if (!viewer.canRead) return Promise.resolve({ state: "not_allowed" });
  return attempt("customers", () => listCustomers(dbOrThrow(), viewer.tenantId, filters, { withDelivery: viewer.desk !== null }));
}

/**
 * Which of these won deals already are client records (archived included), as
 * lead id → client id — so a converted deal leaves "Not yet client records"
 * for good, whatever the list's filters or its 500-row page show.
 */
export function loadConvertedLeads(viewer: ClientsViewer, leadIds: readonly string[]): Promise<Loaded<Map<string, string>>> {
  if (!viewer.canRead) return Promise.resolve({ state: "not_allowed" });
  if (leadIds.length === 0) return Promise.resolve({ state: "ok", value: new Map() });
  return attempt("converted_leads", () => customerIdsBySourceLead(dbOrThrow(), viewer.tenantId, leadIds));
}

/** Everyone in the workspace, deactivated included — for naming owners on old records. */
export async function loadWorkspaceDirectory(tenantId: string): Promise<MemberRow[] | null> {
  try {
    return await getTenantMembers(tenantId, { includeInactive: true });
  } catch (err) {
    console.error("[os.clients.directory]", err);
    return null;
  }
}

export function memberLabel(m: Pick<MemberRow, "display_name" | "full_name" | "email">): string {
  return (m.display_name || m.full_name || m.email || "Teammate").trim();
}

/** Active members as owner options (the API validates against the same list). */
export function ownerOptions(directory: readonly MemberRow[] | null): Array<{ value: string; label: string }> {
  return (directory ?? [])
    .filter((m) => m.auth_user_id && !m.deactivated_at)
    .map((m) => ({ value: String(m.auth_user_id).toLowerCase(), label: memberLabel(m) }));
}

export function ownerName(id: string | null, directory: readonly MemberRow[] | null): string | null {
  if (!id) return null;
  if (!directory) return null;
  const m = directory.find((x) => (x.auth_user_id || "").toLowerCase() === id.toLowerCase());
  return m ? memberLabel(m) : "Former teammate";
}

export type ClientTab = "overview" | "tickets" | "projects" | "files" | "activity";
export const CLIENT_TABS: ReadonlyArray<{ key: ClientTab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "tickets", label: "Tickets" },
  { key: "projects", label: "Projects" },
  { key: "files", label: "Files" },
  { key: "activity", label: "Activity" },
];

export type ClientRecordData = {
  customer: Customer;
  contacts: Loaded<CustomerContact[]>;
  /** The client's tickets on the workspace's own desk (all statuses). */
  tickets: Loaded<{ rows: Ticket[]; truncated: boolean }>;
  projects: Loaded<{ rows: Project[]; truncated: boolean }>;
  /** Documents on the source deal, and attachments on the client's tickets. */
  files: Loaded<{ leadFiles: LeadFile[] | null; ticketFiles: Array<{ ticketId: string; ticketNumber: string; index: number; filename: string; sizeBytes: number; stored: boolean }> }>;
  activity: Loaded<ActivityItem[] | null>;
};

/**
 * One client of THIS workspace, or null when the id is not one (another
 * workspace's client included — the store matches tenant_id AND id). Only the
 * tab being viewed is read beyond the overview's counts.
 */
export async function loadClientRecord(
  viewer: ClientsViewer,
  id: string,
  tab: ClientTab,
): Promise<Loaded<ClientRecordData | null>> {
  if (!viewer.canRead) return { state: "not_allowed" };
  const head = await attempt("record", async () => {
    const db = dbOrThrow();
    return getCustomer(db, viewer.tenantId, id);
  });
  if (head.state !== "ok") return head;
  const customer = head.value;
  if (!customer) return { state: "ok", value: null };
  const db = dbOrThrow();
  const desk = viewer.desk;
  const deskOnly = <T,>(label: string, fn: () => Promise<T>): Promise<Loaded<T>> =>
    desk ? attempt(label, fn) : Promise.resolve({ state: "not_allowed" });
  const skip = <T,>(): Promise<Loaded<T>> => Promise.resolve({ state: "not_allowed" });

  const wantTickets = tab === "overview" || tab === "tickets" || tab === "files";
  const [contacts, tickets, projects, leadFiles, activity] = await Promise.all([
    attempt("contacts", () => listContacts(db, viewer.tenantId, customer.id)),
    wantTickets
      ? deskOnly("tickets", () => listTickets(db, desk!, { customer_id: customer.id, status: "all" }))
      : skip<{ rows: Ticket[]; truncated: boolean }>(),
    tab === "overview" || tab === "projects"
      ? deskOnly("projects", () => listProjects(db, desk!, { customer_id: customer.id, includeArchived: true }))
      : skip<{ rows: Project[]; truncated: boolean }>(),
    tab === "files"
      ? deskOnly("files", async () => (customer.source_lead_id ? listLeadFiles(db, viewer.tenantId, customer.source_lead_id) : null))
      : skip<LeadFile[] | null>(),
    tab === "activity"
      ? deskOnly("activity", async () => (customer.source_lead_id ? listLeadActivity(db, viewer.tenantId, customer.source_lead_id) : null))
      : skip<ActivityItem[] | null>(),
  ]);

  let files: ClientRecordData["files"] = { state: "not_allowed" };
  if (tab === "files") {
    if (leadFiles.state !== "ok") files = leadFiles;
    else if (tickets.state !== "ok") files = tickets;
    else {
      files = {
        state: "ok",
        value: {
          leadFiles: leadFiles.value,
          ticketFiles: tickets.value.rows.flatMap((t) =>
            t.attachments.map((a, index) => ({
              ticketId: t.id,
              ticketNumber: t.ticket_number,
              index,
              filename: a.filename,
              sizeBytes: a.size_bytes,
              stored: Boolean(a.storage_path),
            })),
          ),
        },
      };
    }
  }
  return { state: "ok", value: { customer, contacts, tickets, projects, files, activity } };
}
