/**
 * lib/os/customers/store.ts — every read and write for Clients (`customers`,
 * `customer_contacts`) and the links from tickets and projects to a client.
 *
 * Raw SQL on the libSQL client, the same way lib/delivery/store.ts works, so
 * tests drive every function against a local libSQL file with a fixed clock.
 *
 * TWO RULES EVERY FUNCTION FOLLOWS
 *   1. Every statement takes `tenantId` as an argument and binds it into its
 *      WHERE (or its INSERT). The caller passes the tenant from the RESOLVED
 *      SESSION (lib/os/customers/session.ts), never from a request body. libSQL
 *      has no row-level security, so that WHERE is the isolation boundary: a
 *      read or write for workspace B cannot name, see or change workspace A's
 *      rows, because every row is matched on (tenant_id, id) together.
 *   2. Nothing is swallowed. A failed statement throws and the route turns it
 *      into a loud 500. The only errors handled here are the ones that ARE the
 *      answer: a unique-index collision becomes "that email is already a
 *      client", and a missing table on the intake path means "no client records
 *      in this database yet" (see isMissingCustomersSchema).
 *
 * Writes take already-validated input (lib/os/customers/rules.ts).
 *
 * THE LEDGER. This module is the catalog owner of customer.created,
 * customer.churned and customer.reactivated (lib/ledger/catalog.ts). Each is
 * emitted in the SAME db.batch as the write it records, so a client record and
 * its ledger row commit or roll back together (lib/ledger/emit.ts). The
 * client's Activity tab reads them back by customer_id.
 */
import { randomUUID } from "node:crypto";
import type { Client, InStatement, ResultSet } from "@libsql/client";
import { isUniqueViolationError } from "@/lib/api-helpers";
import { assertNoPayloadConflicts, emit, emitIfChanged, type LedgerStatement } from "@/lib/ledger/emit";
import {
  CUSTOMER_LIFECYCLES,
  contactFromLead,
  customerFromLead,
  isConvertibleLeadStage,
  isOneOf,
  normalizeEmail,
  type ContactInput,
  type CustomerLifecycle,
} from "@/lib/os/customers/rules";

/** A page of rows never exceeds this; one more is read to detect truncation. */
export const CUSTOMER_LIST_LIMIT = 500;

type Row = Record<string, unknown>;

function rows(rs: ResultSet): Row[] {
  return rs.rows.map((r) => {
    const o: Row = {};
    rs.columns.forEach((c, i) => {
      const v = (r as unknown as unknown[])[i];
      o[c] = typeof v === "bigint" ? Number(v) : v;
    });
    return o;
  });
}

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const nOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function requireTenant(tenantId: string): string {
  if (typeof tenantId !== "string" || !tenantId.trim()) throw new Error("customers.store: a tenant id is required");
  return tenantId;
}

/**
 * Is this error "the customers schema is not in this database"? Migration
 * bravo__188 creates it. Only the support intake and the pipeline card treat
 * that as an answer ("no client records here yet"); the Clients pages let it
 * surface, because a page whose table is missing should say so.
 */
export function isMissingCustomersSchema(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /no such table: (customers|customer_contacts|support_desks)\b/.test(msg) || /no such column: [a-z_.]*customer_id\b/.test(msg);
}

function parseJson<T>(v: unknown, fallback: T, label: string): T {
  if (typeof v !== "string" || !v.trim()) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    // A corrupt JSON column must not take the whole record down: the record
    // still renders, and the log says which column to repair.
    console.error(`[customers.store] unparseable ${label} column`);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type Customer = {
  id: string;
  display_name: string;
  company_name: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  lifecycle: CustomerLifecycle;
  owner_user_id: string | null;
  source_lead_id: string | null;
  stripe_customer_id: string | null;
  /**
   * The client's own OASIS workspace (tenants.id), set by the operator-only
   * "Link workspace" action (migration bravo__195). Null = not linked, and
   * also what a database without that migration reads as.
   */
  client_tenant_id: string | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
  archived_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CustomerListRow = Customer & {
  /** Null = the viewer may not read the desk (or it was not asked for). */
  open_ticket_count: number | null;
  active_project_count: number | null;
  last_ticket_at: string | null;
};

function mapCustomer(r: Row): Customer {
  const tags = parseJson<unknown>(r.tags, [], "tags");
  const custom = parseJson<unknown>(r.custom_fields, {}, "custom_fields");
  return {
    id: String(r.id),
    display_name: String(r.display_name ?? ""),
    company_name: s(r.company_name),
    primary_email: s(r.primary_email),
    primary_phone: s(r.primary_phone),
    // An unknown stored value reads as "active" for display only; writes never store one.
    lifecycle: (isOneOf(CUSTOMER_LIFECYCLES, r.lifecycle) ? r.lifecycle : "active") as CustomerLifecycle,
    owner_user_id: s(r.owner_user_id),
    source_lead_id: s(r.source_lead_id),
    stripe_customer_id: s(r.stripe_customer_id),
    client_tenant_id: s(r.client_tenant_id),
    tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [],
    custom_fields: custom && typeof custom === "object" && !Array.isArray(custom) ? (custom as Record<string, unknown>) : {},
    archived_at: s(r.archived_at),
    created_by: s(r.created_by),
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
  };
}

export type CustomerContact = {
  id: string;
  customer_id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  role: string | null;
  created_at: string;
};

export type Listed<T> = { rows: T[]; truncated: boolean };

function likeArg(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const OPEN_TICKET_SQL = "'open', 'in_progress', 'waiting_on_client'";
const ACTIVE_PROJECT_SQL = "'discovery', 'building', 'review'";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type CustomerFilters = {
  lifecycle?: string | null;
  q?: string | null;
  owner?: string | null;
  includeArchived?: boolean;
};

/**
 * The workspace's clients. `withDelivery` adds each client's open tickets,
 * active projects and latest ticket from the workspace's OWN desk (same
 * tenant_id): pass it only for a viewer who may read that desk, so a count
 * they may not see is null (an em dash), never a 0.
 */
export async function listCustomers(
  db: Client,
  tenantId: string,
  filters: CustomerFilters = {},
  opts: { withDelivery?: boolean } = {},
): Promise<Listed<CustomerListRow>> {
  requireTenant(tenantId);
  const where = ["c.tenant_id = ?"];
  const args: Array<string> = [tenantId];
  if (!filters.includeArchived) where.push("c.archived_at IS NULL");
  if (filters.lifecycle && isOneOf(CUSTOMER_LIFECYCLES, filters.lifecycle)) {
    where.push("c.lifecycle = ?");
    args.push(filters.lifecycle);
  }
  if (filters.owner) {
    if (filters.owner === "unassigned") where.push("c.owner_user_id IS NULL");
    else {
      where.push("c.owner_user_id = ?");
      args.push(filters.owner.trim().toLowerCase());
    }
  }
  if (filters.q && filters.q.trim()) {
    const like = likeArg(filters.q.trim().slice(0, 120));
    where.push(
      "(c.display_name LIKE ? ESCAPE '\\' OR c.company_name LIKE ? ESCAPE '\\' OR c.primary_email LIKE ? ESCAPE '\\' OR c.primary_phone LIKE ? ESCAPE '\\')",
    );
    args.push(like, like, like, like);
  }
  const delivery = opts.withDelivery
    ? `,
      (SELECT COUNT(*) FROM support_tickets t
         WHERE t.tenant_id = c.tenant_id AND t.customer_id = c.id AND t.status IN (${OPEN_TICKET_SQL})) AS open_ticket_count,
      (SELECT COUNT(*) FROM delivery_projects p
         WHERE p.tenant_id = c.tenant_id AND p.customer_id = c.id AND p.archived_at IS NULL
           AND p.stage IN (${ACTIVE_PROJECT_SQL})) AS active_project_count,
      (SELECT MAX(t.created_at) FROM support_tickets t
         WHERE t.tenant_id = c.tenant_id AND t.customer_id = c.id) AS last_ticket_at`
    : "";
  const rs = await db.execute({
    sql: `SELECT c.*${delivery}
          FROM customers c
          WHERE ${where.join(" AND ")}
          ORDER BY CASE c.lifecycle WHEN 'onboarding' THEN 0 WHEN 'active' THEN 1 WHEN 'paused' THEN 2
                                    WHEN 'prospect' THEN 3 ELSE 4 END,
                   c.updated_at DESC, c.id
          LIMIT ${CUSTOMER_LIST_LIMIT + 1}`,
    args,
  });
  const all = rows(rs).map((r) => ({
    ...mapCustomer(r),
    open_ticket_count: opts.withDelivery ? nOrNull(r.open_ticket_count) ?? 0 : null,
    active_project_count: opts.withDelivery ? nOrNull(r.active_project_count) ?? 0 : null,
    last_ticket_at: opts.withDelivery ? s(r.last_ticket_at) : null,
  }));
  return all.length > CUSTOMER_LIST_LIMIT
    ? { rows: all.slice(0, CUSTOMER_LIST_LIMIT), truncated: true }
    : { rows: all, truncated: false };
}

export async function getCustomer(db: Client, tenantId: string, id: string): Promise<Customer | null> {
  requireTenant(tenantId);
  const rs = await db.execute({
    sql: "SELECT * FROM customers WHERE tenant_id = ? AND id = ? LIMIT 1",
    args: [tenantId, id],
  });
  const r = rows(rs)[0];
  return r ? mapCustomer(r) : null;
}

export async function getCustomerBySourceLead(db: Client, tenantId: string, leadId: string): Promise<Customer | null> {
  requireTenant(tenantId);
  const rs = await db.execute({
    sql: "SELECT * FROM customers WHERE tenant_id = ? AND source_lead_id = ? LIMIT 1",
    args: [tenantId, leadId],
  });
  const r = rows(rs)[0];
  return r ? mapCustomer(r) : null;
}

/**
 * Which of these leads already became a client record in THIS workspace, as
 * lead id → client id. Archived records count: a converted deal stays
 * converted when its client is archived, and is never offered for conversion
 * again. Unbounded by the list page's 500-row limit, since it asks by lead id.
 */
export async function customerIdsBySourceLead(
  db: Client,
  tenantId: string,
  leadIds: readonly string[],
): Promise<Map<string, string>> {
  requireTenant(tenantId);
  const out = new Map<string, string>();
  const ids = [...new Set(leadIds.filter((x) => typeof x === "string" && x))];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const rs = await db.execute({
      sql: `SELECT source_lead_id, id FROM customers
            WHERE tenant_id = ? AND source_lead_id IN (${chunk.map(() => "?").join(", ")})`,
      args: [tenantId, ...chunk],
    });
    for (const r of rows(rs)) out.set(String(r.source_lead_id), String(r.id));
  }
  return out;
}

async function getCustomerByEmail(db: Client, tenantId: string, email: string): Promise<Customer | null> {
  const rs = await db.execute({
    sql: "SELECT * FROM customers WHERE tenant_id = ? AND primary_email = ? LIMIT 1",
    args: [tenantId, email],
  });
  const r = rows(rs)[0];
  return r ? mapCustomer(r) : null;
}

/** Id + name pairs for pickers (ticket and project "Client" selects). Active records only. */
export async function listCustomerOptions(
  db: Client,
  tenantId: string,
): Promise<Array<{ value: string; label: string; email: string | null }>> {
  requireTenant(tenantId);
  const rs = await db.execute({
    sql: `SELECT id, display_name, primary_email FROM customers
          WHERE tenant_id = ? AND archived_at IS NULL
          ORDER BY display_name COLLATE NOCASE, id LIMIT ${CUSTOMER_LIST_LIMIT}`,
    args: [tenantId],
  });
  return rows(rs).map((r) => ({ value: String(r.id), label: String(r.display_name ?? ""), email: s(r.primary_email) }));
}

export async function customerExists(db: Client, tenantId: string, id: string): Promise<boolean> {
  requireTenant(tenantId);
  const rs = await db.execute({ sql: "SELECT 1 AS ok FROM customers WHERE tenant_id = ? AND id = ? LIMIT 1", args: [tenantId, id] });
  return rs.rows.length > 0;
}

export async function listContacts(db: Client, tenantId: string, customerId: string): Promise<CustomerContact[]> {
  requireTenant(tenantId);
  const rs = await db.execute({
    sql: `SELECT * FROM customer_contacts WHERE tenant_id = ? AND customer_id = ?
          ORDER BY created_at, id LIMIT 200`,
    args: [tenantId, customerId],
  });
  return rows(rs).map((r) => ({
    id: String(r.id),
    customer_id: String(r.customer_id),
    name: s(r.name),
    email: s(r.email),
    phone: s(r.phone),
    role: s(r.role),
    created_at: String(r.created_at ?? ""),
  }));
}

/**
 * Which client does this email belong to? The client's primary address first,
 * then a contact's. Ambiguity (the address is a contact at two clients) is
 * never guessed through: no client. Used by the support intake, so the email
 * here is UNVERIFIED — the link it makes is the team's internal bookkeeping,
 * never a grant of access to anything.
 */
export async function matchCustomerByEmail(db: Client, tenantId: string, email: string): Promise<string | null> {
  requireTenant(tenantId);
  const norm = normalizeEmail(email);
  if (!norm) return null;
  const primary = await db.execute({
    sql: "SELECT id FROM customers WHERE tenant_id = ? AND primary_email = ? AND archived_at IS NULL LIMIT 1",
    args: [tenantId, norm],
  });
  if (primary.rows.length) return String(rows(primary)[0].id);
  const contacts = rows(
    await db.execute({
      sql: `SELECT DISTINCT cc.customer_id FROM customer_contacts cc
            JOIN customers c ON c.id = cc.customer_id AND c.tenant_id = cc.tenant_id
            WHERE cc.tenant_id = ? AND cc.email = ? AND c.archived_at IS NULL
            LIMIT 2`,
      args: [tenantId, norm],
    }),
  );
  return contacts.length === 1 ? String(contacts[0].customer_id) : null;
}

// ---------------------------------------------------------------------------
// Ledger events this module owns (lib/ledger/catalog.ts)
// ---------------------------------------------------------------------------

/** The producer every emit here names: the catalog's owning module for these keys. */
export const CUSTOMERS_LEDGER_PRODUCER = "lib/os/customers/store.ts";

export type CustomerOrigin = "conversion" | "manual" | "import";

function ledgerActor(actor: string | null): { type: "human" | "system"; id: string | null } {
  return actor ? { type: "human", id: actor } : { type: "system", id: null };
}

/** customer.created, for the batch that inserts the record. One per record (cust:{id}). */
function customerCreatedEvent(
  tenantId: string,
  customer: { id: string; source_lead_id: string | null },
  origin: CustomerOrigin,
  actor: string | null,
  now: Date,
): LedgerStatement {
  return emit(
    {
      tenantId,
      eventKey: "customer.created",
      eventVersion: 1,
      occurredAt: now,
      subject: { type: "customer", id: customer.id },
      customerId: customer.id,
      // A converted deal carries its lead into the ledger, so the deal's
      // journey (deal.won, then this) reads as one line.
      dealId: origin === "conversion" ? customer.source_lead_id : null,
      actor: ledgerActor(actor),
      source: origin === "import" ? "import" : "native",
      idempotencyKey: `cust:${customer.id}`,
      confidence: "verified",
      payload: { origin, ...(customer.source_lead_id ? { source_lead_id: customer.source_lead_id } : {}) },
      producer: CUSTOMERS_LEDGER_PRODUCER,
    },
    now,
  );
}

/**
 * customer.churned / customer.reactivated for a lifecycle move into or out of
 * "churned" (shown as Past). Conditional on the UPDATE right before it in the
 * batch, so a write that changed nothing records nothing. One per client per
 * day (the catalog's key shape).
 */
function lifecycleStatement(
  tenantId: string,
  customerId: string,
  kind: "churned" | "reactivated",
  actor: string | null | undefined,
  now: Date,
): LedgerStatement {
  const day = now.toISOString().slice(0, 10);
  return emitIfChanged(
    {
      tenantId,
      eventKey: kind === "churned" ? "customer.churned" : "customer.reactivated",
      eventVersion: 1,
      occurredAt: now,
      subject: { type: "customer", id: customerId },
      customerId,
      // Every edit reaches here from a person's click; a caller that did not
      // pass their id still records a human, with the id unknown.
      actor: actor === undefined ? { type: "human", id: null } : ledgerActor(actor),
      source: "native",
      idempotencyKey: kind === "churned" ? `churn:${customerId}:${day}` : `reactivate:${customerId}:${day}`,
      confidence: "verified",
      payload: {},
      producer: CUSTOMERS_LEDGER_PRODUCER,
    },
    now,
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type NewCustomer = {
  display_name: string;
  company_name: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  lifecycle: CustomerLifecycle;
  owner_user_id: string | null;
  stripe_customer_id: string | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
  source_lead_id?: string | null;
};

export type Conflict = "email_taken" | "stripe_customer_taken" | "source_lead_taken";

/** Which unique index a collision hit, from libSQL's message. */
function conflictOf(err: unknown): Conflict | null {
  const e = err as { message?: string; code?: string };
  if (!isUniqueViolationError(e)) return null;
  const msg = (e.message || "").toLowerCase();
  if (msg.includes("primary_email")) return "email_taken";
  if (msg.includes("stripe_customer_id")) return "stripe_customer_taken";
  if (msg.includes("source_lead_id")) return "source_lead_taken";
  return null;
}

export type CreateResult =
  | { ok: true; customer: Customer }
  | { ok: false; error: Conflict; existingId: string | null };

function insertCustomerStatement(tenantId: string, id: string, input: NewCustomer, actor: string | null, at: string): InStatement {
  return {
    sql: `INSERT INTO customers
            (id, tenant_id, display_name, company_name, primary_email, primary_phone, lifecycle, owner_user_id,
             source_lead_id, stripe_customer_id, tags, custom_fields, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      tenantId,
      input.display_name,
      input.company_name,
      input.primary_email,
      input.primary_phone,
      input.lifecycle,
      input.owner_user_id,
      input.source_lead_id ?? null,
      input.stripe_customer_id,
      JSON.stringify(input.tags),
      JSON.stringify(input.custom_fields),
      actor,
      at,
      at,
    ],
  };
}

async function existingIdFor(db: Client, tenantId: string, conflict: Conflict, input: NewCustomer): Promise<string | null> {
  const [col, v] =
    conflict === "email_taken"
      ? ["primary_email", input.primary_email]
      : conflict === "stripe_customer_taken"
        ? ["stripe_customer_id", input.stripe_customer_id]
        : ["source_lead_id", input.source_lead_id ?? null];
  if (!v) return null;
  const rs = await db.execute({ sql: `SELECT id FROM customers WHERE tenant_id = ? AND ${col} = ? LIMIT 1`, args: [tenantId, v] });
  return rs.rows.length ? String(rows(rs)[0].id) : null;
}

/**
 * Create a client. The unique indexes decide duplicates (one email, one Stripe
 * customer, one source lead per workspace), so two requests racing to add the
 * same address cannot both win; the loser is told which record already holds
 * it. Existing unlinked work for the new client is linked in the same pass
 * (linkWorkToCustomer). The record and its customer.created ledger row are
 * one batch: neither lands without the other.
 */
export async function createCustomer(
  db: Client,
  tenantId: string,
  input: NewCustomer,
  actor: string | null,
  now: Date,
  origin: CustomerOrigin = "manual",
): Promise<CreateResult> {
  requireTenant(tenantId);
  const id = randomUUID();
  const at = now.toISOString();
  const stmts: InStatement[] = [
    insertCustomerStatement(tenantId, id, input, actor, at),
    customerCreatedEvent(tenantId, { id, source_lead_id: input.source_lead_id ?? null }, origin, actor, now),
  ];
  try {
    await db.batch(stmts, "write");
  } catch (err) {
    const conflict = conflictOf(err);
    if (!conflict) throw err;
    return { ok: false, error: conflict, existingId: await existingIdFor(db, tenantId, conflict, input) };
  }
  await assertNoPayloadConflicts(db, stmts);
  const customer = (await getCustomer(db, tenantId, id))!;
  await linkWorkToCustomer(db, tenantId, customer, now);
  return { ok: true, customer };
}

export type CustomerChanges = Partial<{
  display_name: string;
  company_name: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  lifecycle: CustomerLifecycle;
  owner_user_id: string | null;
  stripe_customer_id: string | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
  archived: boolean;
}>;

export type UpdateResult =
  | { ok: true; customer: Customer; changed: string[] }
  | { ok: false; error: "not_found" }
  | { ok: false; error: Conflict; existingId: string | null };

const SCALAR_COLUMNS = [
  "display_name",
  "company_name",
  "primary_email",
  "primary_phone",
  "lifecycle",
  "owner_user_id",
  "stripe_customer_id",
] as const;

/**
 * Apply an edit to a client of THIS workspace. A client of another workspace is
 * not_found. A status move into Past (churned) records customer.churned, and
 * one out of it customer.reactivated, in the same batch as the edit. `actor` is
 * the person who made the edit (auth user id); undefined means a person whose
 * id the caller did not pass.
 */
export async function updateCustomer(
  db: Client,
  tenantId: string,
  id: string,
  changes: CustomerChanges,
  now: Date,
  actor?: string | null,
): Promise<UpdateResult> {
  requireTenant(tenantId);
  const cur = await getCustomer(db, tenantId, id);
  if (!cur) return { ok: false, error: "not_found" };
  const at = now.toISOString();
  const sets: string[] = [];
  const args: Array<string | null> = [];
  for (const col of SCALAR_COLUMNS) {
    if (!(col in changes)) continue;
    const v = (changes as Record<string, string | null>)[col] ?? null;
    if (v === (cur as unknown as Record<string, unknown>)[col]) continue;
    sets.push(`${col} = ?`);
    args.push(v);
  }
  if (changes.tags && JSON.stringify(changes.tags) !== JSON.stringify(cur.tags)) {
    sets.push("tags = ?");
    args.push(JSON.stringify(changes.tags));
  }
  if (changes.custom_fields && JSON.stringify(changes.custom_fields) !== JSON.stringify(cur.custom_fields)) {
    sets.push("custom_fields = ?");
    args.push(JSON.stringify(changes.custom_fields));
  }
  if (changes.archived !== undefined && changes.archived !== Boolean(cur.archived_at)) {
    sets.push("archived_at = ?");
    args.push(changes.archived ? at : null);
  }
  if (sets.length === 0) return { ok: true, customer: cur, changed: [] };
  const changed = sets.map((x) => x.split(" = ")[0]);
  sets.push("updated_at = ?");
  args.push(at);
  const stmts: InStatement[] = [
    { sql: `UPDATE customers SET ${sets.join(", ")} WHERE tenant_id = ? AND id = ?`, args: [...args, tenantId, id] },
  ];
  if (changed.includes("lifecycle")) {
    const next = changes.lifecycle;
    const move = next === "churned" ? "churned" : cur.lifecycle === "churned" ? "reactivated" : null;
    if (move) stmts.push(lifecycleStatement(tenantId, id, move, actor, now));
  }
  try {
    await db.batch(stmts, "write");
  } catch (err) {
    const conflict = conflictOf(err);
    if (!conflict) throw err;
    const probe: NewCustomer = {
      ...cur,
      primary_email: changes.primary_email ?? cur.primary_email,
      stripe_customer_id: changes.stripe_customer_id ?? cur.stripe_customer_id,
      source_lead_id: cur.source_lead_id,
    };
    return { ok: false, error: conflict, existingId: await existingIdFor(db, tenantId, conflict, probe) };
  }
  const customer = (await getCustomer(db, tenantId, id))!;
  if (changed.includes("primary_email") && customer.primary_email) await linkWorkToCustomer(db, tenantId, customer, now);
  return { ok: true, customer, changed };
}

export async function addContact(
  db: Client,
  tenantId: string,
  customerId: string,
  input: ContactInput,
  now: Date,
): Promise<CustomerContact | null> {
  requireTenant(tenantId);
  if (!(await customerExists(db, tenantId, customerId))) return null;
  const id = randomUUID();
  const at = now.toISOString();
  await db.batch(
    [
      {
        sql: `INSERT INTO customer_contacts (id, tenant_id, customer_id, name, email, phone, role, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, tenantId, customerId, input.name, input.email, input.phone, input.role, at, at],
      },
      { sql: "UPDATE customers SET updated_at = ? WHERE tenant_id = ? AND id = ?", args: [at, tenantId, customerId] },
    ],
    "write",
  );
  return { id, customer_id: customerId, ...input, created_at: at };
}

/** Returns false when the contact is not on that client in this workspace. */
export async function removeContact(db: Client, tenantId: string, customerId: string, contactId: string): Promise<boolean> {
  requireTenant(tenantId);
  const rs = await db.execute({
    sql: "DELETE FROM customer_contacts WHERE tenant_id = ? AND customer_id = ? AND id = ?",
    args: [tenantId, customerId, contactId],
  });
  return rs.rowsAffected === 1;
}

/**
 * Link the workspace's existing, UNLINKED work to this client:
 *   - projects that came from the client's source lead (the same deal);
 *   - tickets on one of the client's projects;
 *   - tickets whose requester email is the client's primary address.
 * A row already linked to a client is never moved: re-linking is the team's
 * explicit decision on the ticket or project, not a side effect. The email
 * match is the same rule the support intake applies to new tickets.
 */
export async function linkWorkToCustomer(
  db: Client,
  tenantId: string,
  customer: Pick<Customer, "id" | "primary_email" | "source_lead_id">,
  now: Date,
): Promise<{ projects: number; tickets: number }> {
  requireTenant(tenantId);
  const at = now.toISOString();
  const stmts: InStatement[] = [];
  if (customer.source_lead_id) {
    stmts.push({
      sql: `UPDATE delivery_projects SET customer_id = ?, updated_at = ?
            WHERE tenant_id = ? AND lead_id = ? AND customer_id IS NULL`,
      args: [customer.id, at, tenantId, customer.source_lead_id],
    });
  }
  stmts.push({
    sql: `UPDATE support_tickets SET customer_id = ?, updated_at = ?
          WHERE tenant_id = ? AND customer_id IS NULL AND project_id IN (
            SELECT id FROM delivery_projects WHERE tenant_id = ? AND customer_id = ?
          )`,
    args: [customer.id, at, tenantId, tenantId, customer.id],
  });
  if (customer.primary_email) {
    stmts.push({
      sql: `UPDATE support_tickets SET customer_id = ?, updated_at = ?
            WHERE tenant_id = ? AND customer_id IS NULL AND client_email = ?`,
      args: [customer.id, at, tenantId, customer.primary_email],
    });
  }
  const results = await db.batch(stmts, "write");
  const projects = customer.source_lead_id ? results[0].rowsAffected : 0;
  const tickets = results.slice(customer.source_lead_id ? 1 : 0).reduce((sum, r) => sum + r.rowsAffected, 0);
  return { projects, tickets };
}

// ---------------------------------------------------------------------------
// Convert a won lead
// ---------------------------------------------------------------------------

export type ConvertResult =
  | { ok: true; customer: Customer; created: boolean; linkedBy: "source_lead" | "email" | null }
  | { ok: false; status: 404 | 409; error: "lead_not_found" | "lead_not_won" | "email_belongs_to_another_client"; existingId?: string | null };

/**
 * "Convert to client": a won lead in THIS workspace's pipeline becomes a client
 * record linked to it by source_lead_id.
 *
 * IDEMPOTENT. A second convert of the same lead — a double click, two tabs, a
 * retry — returns the record the first one made (created: false). Two converts
 * racing are settled by the unique (tenant_id, source_lead_id) index: the loser
 * reads the winner's record back.
 *
 * AN EXISTING CLIENT WITH THE SAME EMAIL. A client typed in by hand before the
 * deal was marked won is the same client: it is linked to the lead (its
 * source_lead_id set) rather than duplicated. One that already came from a
 * DIFFERENT lead is refused with its id, so the team decides.
 */
export async function convertLeadToCustomer(
  db: Client,
  tenantId: string,
  leadId: string,
  actor: string | null,
  now: Date,
): Promise<ConvertResult> {
  requireTenant(tenantId);
  const existing = await getCustomerBySourceLead(db, tenantId, leadId);
  if (existing) return { ok: true, customer: existing, created: false, linkedBy: "source_lead" };

  const lead = rows(
    await db.execute({
      sql: "SELECT id, data FROM tenant_records WHERE tenant_id = ? AND id = ? AND entity_type = 'lead' LIMIT 1",
      args: [tenantId, leadId],
    }),
  )[0];
  if (!lead) return { ok: false, status: 404, error: "lead_not_found" };
  const data = parseJson<Record<string, unknown>>(lead.data, {}, "tenant_records.data");
  if (!isConvertibleLeadStage(data.stage)) return { ok: false, status: 409, error: "lead_not_won" };

  const from = customerFromLead(data);
  if (from.primary_email) {
    const byEmail = await getCustomerByEmail(db, tenantId, from.primary_email);
    if (byEmail) {
      if (byEmail.source_lead_id && byEmail.source_lead_id !== leadId) {
        return { ok: false, status: 409, error: "email_belongs_to_another_client", existingId: byEmail.id };
      }
      const at = now.toISOString();
      const claim = await db.execute({
        sql: `UPDATE customers SET source_lead_id = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ? AND source_lead_id IS NULL`,
        args: [leadId, at, tenantId, byEmail.id],
      });
      const linked = (await getCustomer(db, tenantId, byEmail.id))!;
      if (claim.rowsAffected === 1) await linkWorkToCustomer(db, tenantId, linked, now);
      if (linked.source_lead_id !== leadId) {
        // Another convert claimed it for a different lead between the read and the write.
        return { ok: false, status: 409, error: "email_belongs_to_another_client", existingId: linked.id };
      }
      return { ok: true, customer: linked, created: false, linkedBy: "email" };
    }
  }

  const id = randomUUID();
  const at = now.toISOString();
  const input: NewCustomer = {
    ...from,
    owner_user_id: actor,
    stripe_customer_id: null,
    tags: [],
    custom_fields: {},
    source_lead_id: leadId,
  };
  const contact = contactFromLead(data);
  const stmts: InStatement[] = [
    insertCustomerStatement(tenantId, id, input, actor, at),
    customerCreatedEvent(tenantId, { id, source_lead_id: leadId }, "conversion", actor, now),
  ];
  if (contact) {
    stmts.push({
      sql: `INSERT INTO customer_contacts (id, tenant_id, customer_id, name, email, phone, role, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [randomUUID(), tenantId, id, contact.name, contact.email, contact.phone, contact.role, at, at],
    });
  }
  try {
    await db.batch(stmts, "write");
  } catch (err) {
    const conflict = conflictOf(err);
    if (!conflict) throw err;
    // A racing convert of the same lead won: return what it made.
    const winner = await getCustomerBySourceLead(db, tenantId, leadId);
    if (winner) return { ok: true, customer: winner, created: false, linkedBy: "source_lead" };
    // The email was taken by a record made between our check and our insert.
    const holder = from.primary_email ? await getCustomerByEmail(db, tenantId, from.primary_email) : null;
    return { ok: false, status: 409, error: "email_belongs_to_another_client", existingId: holder?.id ?? null };
  }
  await assertNoPayloadConflicts(db, stmts);
  const customer = (await getCustomer(db, tenantId, id))!;
  await linkWorkToCustomer(db, tenantId, customer, now);
  return { ok: true, customer, created: true, linkedBy: null };
}

// ---------------------------------------------------------------------------
// Past engagements and the client's own workspace
// ---------------------------------------------------------------------------

export type EndEngagementResult =
  | { ok: true; customer: Customer; changed: boolean }
  | { ok: false; error: "not_found" };

/**
 * "Mark engagement ended": the founder says this client is Past. Sets lifecycle
 * to churned with a compare-and-swap (a record already Past is left alone and
 * records nothing) and emits customer.churned in the same batch. Nothing else
 * on the record changes; its history stays where it is.
 */
export async function endEngagement(
  db: Client,
  tenantId: string,
  id: string,
  actor: string | null,
  now: Date,
): Promise<EndEngagementResult> {
  requireTenant(tenantId);
  const cur = await getCustomer(db, tenantId, id);
  if (!cur) return { ok: false, error: "not_found" };
  if (cur.lifecycle === "churned") return { ok: true, customer: cur, changed: false };
  const at = now.toISOString();
  const results = await db.batch(
    [
      {
        sql: `UPDATE customers SET lifecycle = 'churned', updated_at = ?
              WHERE tenant_id = ? AND id = ? AND lifecycle <> 'churned'`,
        args: [at, tenantId, id],
      },
      lifecycleStatement(tenantId, id, "churned", actor, now),
    ],
    "write",
  );
  const customer = (await getCustomer(db, tenantId, id))!;
  return { ok: true, customer, changed: results[0].rowsAffected === 1 };
}

export type LinkWorkspaceResult =
  | { ok: true; customer: Customer; changed: boolean }
  | { ok: false; error: "not_found" | "client_tenant_not_found" | "client_tenant_is_this_workspace" | "client_tenant_taken"; existingId?: string | null };

/**
 * Link a client record to the client's own workspace (customers.client_tenant_id,
 * migration bravo__195), or unlink it with null. The CALLER decides who may:
 * the route allows the platform operator only. The tenant must exist and may
 * not be the business's own workspace; one workspace belongs to one client
 * record per business (a unique index, not a pre-check).
 */
export async function setClientWorkspace(
  db: Client,
  tenantId: string,
  id: string,
  clientTenantId: string | null,
  now: Date,
): Promise<LinkWorkspaceResult> {
  requireTenant(tenantId);
  const cur = await getCustomer(db, tenantId, id);
  if (!cur) return { ok: false, error: "not_found" };
  if (clientTenantId !== null) {
    if (clientTenantId === tenantId) return { ok: false, error: "client_tenant_is_this_workspace" };
    const t = await db.execute({ sql: "SELECT id FROM tenants WHERE id = ? LIMIT 1", args: [clientTenantId] });
    if (t.rows.length === 0) return { ok: false, error: "client_tenant_not_found" };
  }
  if ((cur.client_tenant_id ?? null) === clientTenantId) return { ok: true, customer: cur, changed: false };
  try {
    await db.execute({
      sql: "UPDATE customers SET client_tenant_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?",
      args: [clientTenantId, now.toISOString(), tenantId, id],
    });
  } catch (err) {
    if (!isUniqueViolationError(err as { message?: string; code?: string })) throw err;
    const holder = await db.execute({
      sql: "SELECT id FROM customers WHERE tenant_id = ? AND client_tenant_id = ? LIMIT 1",
      args: [tenantId, clientTenantId],
    });
    return { ok: false, error: "client_tenant_taken", existingId: holder.rows.length ? String(rows(holder)[0].id) : null };
  }
  return { ok: true, customer: (await getCustomer(db, tenantId, id))!, changed: true };
}

/**
 * The workspaces a record may be linked to: every tenant except the business's
 * own, by name. Operator-only surface (the caller gates it).
 */
export async function listLinkableWorkspaces(
  db: Client,
  tenantId: string,
): Promise<Array<{ id: string; name: string; slug: string | null }>> {
  requireTenant(tenantId);
  const rs = await db.execute({
    sql: "SELECT id, name, slug FROM tenants WHERE id <> ? ORDER BY name COLLATE NOCASE, id LIMIT 1000",
    args: [tenantId],
  });
  return rows(rs).map((r) => ({ id: String(r.id), name: String(r.name ?? ""), slug: s(r.slug) }));
}

// ---------------------------------------------------------------------------
// The record's Activity and Files tabs
// ---------------------------------------------------------------------------

export type ActivityItem = {
  id: string;
  type: string | null;
  channel: string | null;
  direction: string | null;
  subject: string | null;
  preview: string | null;
  created_at: string;
};

/** lead_interactions of the client's source lead, newest first, in THIS workspace only. */
export async function listLeadActivity(db: Client, tenantId: string, leadId: string, limit = 100): Promise<ActivityItem[]> {
  requireTenant(tenantId);
  const rs = await db.execute({
    sql: `SELECT id, type, channel, direction, subject, content_preview, content, created_at
          FROM lead_interactions
          WHERE tenant_id = ? AND lead_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
    args: [tenantId, leadId, Math.min(Math.max(limit, 1), 200)],
  });
  return rows(rs).map((r) => {
    const preview = s(r.content_preview) ?? s(r.content);
    return {
      id: String(r.id),
      type: s(r.type),
      channel: s(r.channel),
      direction: s(r.direction),
      subject: s(r.subject),
      preview: preview ? preview.slice(0, 280) : null,
      created_at: String(r.created_at ?? ""),
    };
  });
}

export type LeadFile = {
  id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  doc_type: string | null;
  uploaded_at: string;
};

/**
 * Documents stored on the client's source lead (lead_documents), in THIS
 * workspace only, soft-deleted ones left out — the same rows the lead's own
 * Documents panel lists. Bytes are served by /api/lead-documents/[id]/content,
 * which applies the lead's access rule.
 */
export async function listLeadFiles(db: Client, tenantId: string, leadId: string): Promise<LeadFile[]> {
  requireTenant(tenantId);
  const rs = await db.execute({
    sql: `SELECT id, filename, mime_type, size_bytes, doc_type, uploaded_at, metadata
          FROM lead_documents
          WHERE tenant_id = ? AND lead_id = ?
          ORDER BY uploaded_at DESC, id DESC
          LIMIT 200`,
    args: [tenantId, leadId],
  });
  return rows(rs)
    .filter((r) => {
      const meta = parseJson<Record<string, unknown> | null>(r.metadata, null, "lead_documents.metadata");
      return !(meta && meta.deleted_at);
    })
    .map((r) => ({
      id: String(r.id),
      filename: String(r.filename ?? "file"),
      mime_type: s(r.mime_type),
      size_bytes: nOrNull(r.size_bytes),
      doc_type: s(r.doc_type),
      uploaded_at: String(r.uploaded_at ?? ""),
    }));
}
