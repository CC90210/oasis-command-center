/**
 * clients-records-data — the reads behind /clients (the `customers` list) and
 * /clients/[id] (one record and its tabs). Every read takes the tenant from the
 * viewer the page resolved from the SESSION (lib/os/customers/session.ts); the
 * stores bind it into every WHERE.
 *
 * Each read reports ok / not_set_up / not_allowed / error separately, so a page
 * can say "client records are not set up yet", "owners only" and "this failed"
 * in different words, and none of them is a 0 or an empty list.
 *
 *   not_set_up   the customers table is missing (migration bravo__188).
 *   not_allowed  the tab needs the workspace's desk (owners and admins):
 *                conversations, tickets, projects, files, activity and usage
 *                hold every customer's messages, documents and data.
 *
 * THE TABS (the record's hub):
 *   Conversations  lib/os/customers/conversations.ts: email and SMS from the
 *                  message ledger, Slack from the mirrored events, the
 *                  agents' drafts awaiting approval; plus the composer.
 *   Money          lib/os/customers/money.ts: OASIS's books, OASIS's own
 *                  records only, for the founders who may open Money.
 *   Usage          lib/os/customers/usage.ts: the client's own workspace,
 *                  once the operator has linked it.
 *   Activity       lib/os/customers/activity.ts: ledger facts and the source
 *                  deal's interactions (labelled inferred).
 *   Health         lib/os/customers/health.ts, computed on read; its badge is
 *                  on every tab and on the list.
 */
import "server-only";

import type { Client } from "@libsql/client";
import { getTenantMembers, type MemberRow } from "@/lib/team";
import { DELIVERY_TENANT_ID } from "@/lib/delivery/rules";
import { listProjects, listTickets, type Project, type Ticket } from "@/lib/delivery/store";
import { resolveFinanceViewer } from "@/lib/founders-finances/access-io";
import {
  customerIdsBySourceLead,
  getCustomer,
  isMissingCustomersSchema,
  listContacts,
  listCustomers,
  listLeadFiles,
  listLinkableWorkspaces,
  type Customer,
  type CustomerContact,
  type CustomerFilters,
  type CustomerListRow,
  type LeadFile,
} from "@/lib/os/customers/store";
import { lastTouchFor, loadClientActivity, type ActivityEntry } from "@/lib/os/customers/activity";
import { clientAddresses, loadClientConversation, type ClientAddresses, type ClientConversation } from "@/lib/os/customers/conversations";
import { loadClientMoney, type ClientMoney } from "@/lib/os/customers/money";
import { loadClientUsage, type ClientUsage } from "@/lib/os/customers/usage";
import { deskSignalsFor, health, moneySignalsFor, type Health, type MoneySignals } from "@/lib/os/customers/health";
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

/** YYYY-MM-DD in Toronto, the day "overdue" is counted against (the books' own calendar). */
export function torontoDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * May this viewer read OASIS's books for these records? Only in OASIS's own
 * workspace, only for its desk team, and only for a founder who may open Money
 * (resolveFinanceViewer, the Finances pages' own gate).
 *   "read"         yes.
 *   "not_tracked"  another workspace: its money is not in the app.
 *   "not_allowed"  OASIS, but this viewer may not open Money.
 *   "error"        the gate itself failed (logged); counted as unknown.
 */
export type MoneyAccess = "read" | "not_tracked" | "not_allowed" | "error";

export async function moneyAccessFor(viewer: ClientsViewer): Promise<MoneyAccess> {
  if (viewer.tenantId !== DELIVERY_TENANT_ID) return "not_tracked";
  if (!viewer.desk) return "not_allowed";
  try {
    return (await resolveFinanceViewer()) ? "read" : "not_allowed";
  } catch (err) {
    console.error("[os.clients.money_access]", err);
    return "error";
  }
}

export type ListedClient = CustomerListRow & {
  /** The latest activity, never updated_at. null = nothing recorded; undefined = could not be read. */
  last_touch: string | null | undefined;
  health: Health;
};

/**
 * The workspace's clients, with desk counts only for a viewer who may read the
 * desk, each with its last touch and its health.
 */
export async function loadCustomerRecords(
  viewer: ClientsViewer,
  filters: CustomerFilters,
  now: Date = new Date(),
): Promise<Loaded<{ rows: ListedClient[]; truncated: boolean; money: MoneyAccess }>> {
  if (!viewer.canRead) return { state: "not_allowed" };
  const listed = await attempt("customers", () => listCustomers(dbOrThrow(), viewer.tenantId, filters, { withDelivery: viewer.desk !== null }));
  if (listed.state !== "ok") return listed;
  const db = dbOrThrow();
  const { rows, truncated } = listed.value;
  const money = await moneyAccessFor(viewer);
  const [touch, desk, signals] = await Promise.all([
    viewer.desk ? attempt("last_touch", () => lastTouchFor(db, viewer.tenantId, rows)) : Promise.resolve({ state: "not_allowed" } as const),
    viewer.desk ? attempt("desk_signals", () => deskSignalsFor(db, viewer.tenantId, rows.map((r) => r.id), now)) : Promise.resolve({ state: "not_allowed" } as const),
    money === "read" ? attempt("money_signals", () => moneySignalsFor(db, rows, torontoDay(now))) : Promise.resolve(null),
  ]);
  return {
    state: "ok",
    value: {
      truncated,
      money,
      rows: rows.map((r) => {
        const lastTouch = touch.state === "ok" ? touch.value.get(r.id) ?? null : undefined;
        const d = desk.state === "ok" ? desk.value.get(r.id) : undefined;
        return {
          ...r,
          last_touch: lastTouch,
          health: health({
            lifecycle: r.lifecycle,
            createdAt: r.created_at,
            now,
            lastTouch,
            slaBreaches30d: d ? d.slaBreaches30d : null,
            projectsPastDue: d ? d.projectsPastDue : null,
            money: moneyInput(money, signals, r.id),
          }),
        };
      }),
    },
  };
}

function moneyInput(
  access: MoneyAccess,
  signals: Loaded<Map<string, MoneySignals>> | null,
  id: string,
): MoneySignals | "not_tracked" | null {
  if (access === "not_tracked") return "not_tracked";
  if (access !== "read" || !signals || signals.state !== "ok") return null;
  return signals.value.get(id) ?? { overdueInvoices: 0, failedPayments: 0, cancelAtPeriodEnd: false };
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

export type ClientTab = "overview" | "conversations" | "tickets" | "projects" | "money" | "usage" | "activity" | "health" | "files";
export const CLIENT_TABS: ReadonlyArray<{ key: ClientTab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "conversations", label: "Conversations" },
  { key: "tickets", label: "Tickets" },
  { key: "projects", label: "Projects" },
  { key: "money", label: "Money" },
  { key: "usage", label: "Usage" },
  { key: "activity", label: "Activity" },
  { key: "health", label: "Health" },
  { key: "files", label: "Files" },
];

/** Money: Loaded, or "not_tracked" in a workspace whose books are not in the app. */
export type MoneyState = Loaded<ClientMoney | null> | { state: "not_tracked" };

/** Usage: Loaded (null = not linked yet), or "not_applicable" outside OASIS. */
export type UsageState = Loaded<ClientUsage | null> | { state: "not_applicable" };

export type ClientRecordData = {
  customer: Customer;
  contacts: Loaded<CustomerContact[]>;
  /** The client's tickets on the workspace's own desk (all statuses). */
  tickets: Loaded<{ rows: Ticket[]; truncated: boolean }>;
  projects: Loaded<{ rows: Project[]; truncated: boolean }>;
  /** Documents on the source deal, and attachments on the client's tickets. */
  files: Loaded<{
    leadFiles: LeadFile[] | null;
    ticketFiles: Array<{ ticketId: string; ticketNumber: string; index: number; filename: string; sizeBytes: number; stored: boolean }>;
    /** The ticket read hit its cap: files on tickets past it are not listed. */
    ticketsTruncated: boolean;
  }>;
  conversation: Loaded<ClientConversation & { addresses: ClientAddresses }>;
  money: MoneyState;
  usage: UsageState;
  /** For the operator's Link workspace control; null when the viewer is not the operator. */
  linkableWorkspaces: Loaded<Array<{ id: string; name: string; slug: string | null }>> | null;
  activity: Loaded<{ entries: ActivityEntry[]; truncated: boolean }>;
  lastTouch: Loaded<string | null>;
  health: Health;
  moneyAccess: MoneyAccess;
};

/**
 * One client of THIS workspace, or null when the id is not one (another
 * workspace's client included — the store matches tenant_id AND id). Only the
 * tab being viewed is read beyond the header's counts and health.
 */
export async function loadClientRecord(
  viewer: ClientsViewer,
  id: string,
  tab: ClientTab,
  opts: { isOperator?: boolean; now?: Date } = {},
): Promise<Loaded<ClientRecordData | null>> {
  if (!viewer.canRead) return { state: "not_allowed" };
  const now = opts.now ?? new Date();
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
  const oasisBooks = viewer.tenantId === DELIVERY_TENANT_ID;
  const moneyAccess = await moneyAccessFor(viewer);

  const wantTickets = tab === "overview" || tab === "tickets" || tab === "files";
  const [contacts, tickets, projects, leadFiles, activity, lastTouch, deskSignals, moneySignals] = await Promise.all([
    attempt("contacts", () => listContacts(db, viewer.tenantId, customer.id)),
    wantTickets
      ? deskOnly("tickets", () => listTickets(db, desk!, { customer_id: customer.id, status: "all" }))
      : skip<{ rows: Ticket[]; truncated: boolean }>(),
    // Every tab: the header's New ticket form links one of this client's
    // projects whichever tab is open (Codex, PR #473).
    deskOnly("projects", () => listProjects(db, desk!, { customer_id: customer.id, includeArchived: true })),
    tab === "files"
      ? deskOnly("files", async () => (customer.source_lead_id ? listLeadFiles(db, viewer.tenantId, customer.source_lead_id) : null))
      : skip<LeadFile[] | null>(),
    tab === "activity"
      ? deskOnly("activity", () => loadClientActivity(db, viewer.tenantId, customer))
      : skip<{ entries: ActivityEntry[]; truncated: boolean }>(),
    deskOnly("last_touch", async () => (await lastTouchFor(db, viewer.tenantId, [customer])).get(customer.id) ?? null),
    deskOnly("desk_signals", async () => (await deskSignalsFor(db, viewer.tenantId, [customer.id], now)).get(customer.id)!),
    moneyAccess === "read" ? attempt("money_signals", () => moneySignalsFor(db, [customer], torontoDay(now))) : Promise.resolve(null),
  ]);

  const conversation: ClientRecordData["conversation"] =
    tab === "conversations" && contacts.state === "ok"
      ? await deskOnly("conversation", async () => ({
          ...(await loadClientConversation(db, viewer.tenantId, customer, contacts.value)),
          addresses: clientAddresses(customer, contacts.value),
        }))
      : tab === "conversations" && contacts.state !== "ok"
        ? contacts
        : { state: "not_allowed" };

  let money: MoneyState = { state: "not_allowed" };
  if (tab === "money") {
    if (!oasisBooks) money = { state: "not_tracked" };
    else if (moneyAccess === "read") money = await attempt("money", () => loadClientMoney(db, customer, torontoDay(now)));
    else if (moneyAccess === "error") money = { state: "error" };
  }

  let usage: UsageState = { state: "not_allowed" };
  let linkableWorkspaces: ClientRecordData["linkableWorkspaces"] = null;
  if (tab === "usage") {
    if (!viewer.oasis) usage = { state: "not_applicable" };
    else if (desk) {
      usage = customer.client_tenant_id
        ? await attempt("usage", () => loadClientUsage(db, customer.client_tenant_id!, now))
        : { state: "ok", value: null };
      if (opts.isOperator && viewer.canWrite) linkableWorkspaces = await attempt("linkable_workspaces", () => listLinkableWorkspaces(db, viewer.tenantId));
    }
  }

  let files: ClientRecordData["files"] = { state: "not_allowed" };
  if (tab === "files") {
    if (leadFiles.state !== "ok") files = leadFiles;
    else if (tickets.state !== "ok") files = tickets;
    else {
      files = {
        state: "ok",
        value: {
          leadFiles: leadFiles.value,
          ticketsTruncated: tickets.value.truncated,
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

  const clientHealth = health({
    lifecycle: customer.lifecycle,
    createdAt: customer.created_at,
    now,
    lastTouch: lastTouch.state === "ok" ? lastTouch.value : undefined,
    slaBreaches30d: deskSignals.state === "ok" ? deskSignals.value.slaBreaches30d : null,
    projectsPastDue: deskSignals.state === "ok" ? deskSignals.value.projectsPastDue : null,
    money: moneyInput(moneyAccess, moneySignals, customer.id),
  });

  return {
    state: "ok",
    value: {
      customer,
      contacts,
      tickets,
      projects,
      files,
      conversation,
      money,
      usage,
      linkableWorkspaces,
      activity,
      lastTouch,
      health: clientHealth,
      moneyAccess,
    },
  };
}
