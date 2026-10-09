/**
 * lib/delivery/store.ts — every read and write for Projects + Tickets.
 *
 * Raw SQL on the libSQL client, because these tables exist only in Turso and a
 * query this shape (scoped subqueries, INSERT ... SELECT numbering) is clearer
 * here than through the PostgREST adapter.
 *
 * TWO RULES EVERY FUNCTION FOLLOWS
 *   1. Every statement is pinned to ONE workspace's desk (tenant_id). Every
 *      READ takes a DeliveryViewer and builds its WHERE from access.ts; every
 *      WRITE takes the desk's `tenantId` as its second argument, which the
 *      route takes from the viewer it resolved from the SESSION (never from a
 *      request body). Child rows (tasks, updates, comments, a project's
 *      tickets) are read THROUGH a join to their scoped parent, so a caller
 *      that forgot to check the parent first still cannot read another
 *      client's rows, and every write matches (tenant_id, id) together, so a
 *      desk can never change another desk's row by naming its id.
 *   2. Nothing is swallowed. A failed statement throws; the route turns it into
 *      a loud 500. An empty list here means the query ran and matched nothing.
 *
 * Writes take already-validated input (lib/delivery/rules.ts) and a clock, so
 * tests drive them against a local libSQL file with a fixed `now`.
 *
 * customer_id (migration bravo__188) is READ through `t.*` / `p.*`, so it is
 * simply absent before that migration, and it is only ever WRITTEN when it has
 * a value — so OASIS's desk keeps working on a database that has not had 188.
 *
 * THE LEDGER. This module is the catalog owner of ticket.opened,
 * ticket.first_response and ticket.resolved (lib/ledger/catalog.ts). Each is
 * emitted in the SAME db.batch as the ticket write it records (a ticket and
 * its ledger row commit together), carrying the ticket's client record
 * (customer_id) so the client's Activity tab shows it in the same request.
 * outcome_events (migration bravo__190) must exist: a desk write without it
 * fails loudly rather than landing unrecorded.
 */
import { randomUUID } from "node:crypto";
import type { Client, InStatement, InValue, ResultSet } from "@libsql/client";
import { isUniqueViolationError } from "@/lib/api-helpers";
import { emit, emitIfChanged, type LedgerStatement } from "@/lib/ledger/emit";
import { isRetiredClientRef, notRetiredTenantSql, readNotRetired } from "@/lib/os/customers/retired";
import {
  CLIENT_VISIBLE_MATCHES,
  commentScope,
  rowScope,
  ticketRowScope,
  updateScope,
  type DeliveryViewer,
} from "@/lib/delivery/access";
import {
  DELIVERY_TENANT_ID,
  OPEN_TICKET_STATUSES,
  PROJECT_STAGE_LABELS,
  PROJECT_STAGES,
  TICKET_SEVERITIES,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  canTransitionTicket,
  isClientVisibleComment,
  isOneOf,
  retargetForSeverity,
  slaTargetFor,
  statusTimestampsFor,
  type ProjectPriority,
  type ProjectStage,
  type TaskStatus,
  type TicketCategory,
  type TicketSeverity,
  type TicketSource,
  type TicketStatus,
  type UpdateVisibility,
} from "@/lib/delivery/rules";

/** A page of rows never exceeds this; one more is read to detect truncation. */
export const LIST_LIMIT = 500;

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
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

const OPEN_STATUS_SQL = OPEN_TICKET_STATUSES.map((x) => `'${x}'`).join(", ");

function requireTenant(tenantId: string): string {
  if (typeof tenantId !== "string" || !tenantId.trim()) throw new Error("delivery.store: a desk tenant id is required");
  return tenantId;
}

/** A system reader for one desk (notifications, the cron). Never acts. */
export function deskReader(tenantId: string): DeliveryViewer {
  return { kind: "founder", tenantId: requireTenant(tenantId), userId: "system", canAct: false };
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type Project = {
  id: string;
  title: string;
  description: string | null;
  client_tenant_id: string | null;
  client_tenant_name: string | null;
  client_name: string | null;
  client_email: string | null;
  lead_id: string | null;
  /** The client record (customers.id) this project is for. Null before migration bravo__188. */
  customer_id: string | null;
  stage: ProjectStage;
  priority: ProjectPriority;
  assigned_to: string | null;
  due_date: string | null;
  started_at: string | null;
  launched_at: string | null;
  archived_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  task_count: number;
  tasks_done: number;
  open_ticket_count: number;
  last_client_update_at: string | null;
  last_client_update_body: string | null;
};

function mapProject(r: Row): Project {
  return {
    id: String(r.id),
    title: String(r.title ?? ""),
    description: s(r.description),
    client_tenant_id: s(r.client_tenant_id),
    client_tenant_name: s(r.client_tenant_name),
    client_name: s(r.client_name),
    client_email: s(r.client_email),
    lead_id: s(r.lead_id),
    customer_id: s(r.customer_id),
    stage: (isOneOf(PROJECT_STAGES, r.stage) ? r.stage : "discovery") as ProjectStage,
    priority: (s(r.priority) ?? "medium") as ProjectPriority,
    assigned_to: s(r.assigned_to),
    due_date: s(r.due_date),
    started_at: s(r.started_at),
    launched_at: s(r.launched_at),
    archived_at: s(r.archived_at),
    created_by: s(r.created_by),
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
    task_count: n(r.task_count),
    tasks_done: n(r.tasks_done),
    open_ticket_count: n(r.open_ticket_count),
    last_client_update_at: s(r.last_client_update_at),
    last_client_update_body: s(r.last_client_update_body),
  };
}

export type Task = {
  id: string;
  project_id: string;
  title: string;
  status: TaskStatus;
  assigned_to: string | null;
  notes: string | null;
  due_date: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type ProjectUpdate = {
  id: string;
  project_id: string;
  author_user_id: string | null;
  author_name: string;
  body: string;
  visibility: UpdateVisibility;
  created_at: string;
};

export type Attachment = {
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string | null;
  error?: string;
};

export type Ticket = {
  id: string;
  ticket_seq: number;
  ticket_number: string;
  title: string;
  description: string | null;
  category: TicketCategory;
  severity: TicketSeverity;
  status: TicketStatus;
  source: TicketSource;
  project_id: string | null;
  project_title: string | null;
  client_tenant_id: string | null;
  client_tenant_name: string | null;
  client_name: string | null;
  client_email: string | null;
  client_company: string | null;
  client_match: string | null;
  project_hint: string | null;
  /** The client record (customers.id) the requester is. Null before migration bravo__188. */
  customer_id: string | null;
  reporter_user_id: string | null;
  assigned_to: string | null;
  resolution: string | null;
  attachments: Attachment[];
  form_submission_id: string | null;
  sla_target: string;
  first_response_at: string | null;
  sla_breached_at: string | null;
  sla_breach_alert_at: string | null;
  sla_breach_alert_status: string | null;
  founder_alert_at: string | null;
  founder_alert_status: string | null;
  client_ack_at: string | null;
  client_ack_status: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  comment_count: number;
  last_public_reply_at: string | null;
  last_public_reply_body: string | null;
};

function parseAttachments(v: unknown): Attachment[] {
  if (typeof v !== "string" || !v.trim()) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? (parsed as Attachment[]) : [];
  } catch {
    // A corrupt attachments column must not take the whole ticket down; the
    // ticket still renders and says there is nothing to download.
    console.error("[delivery.store] unparseable attachments column");
    return [];
  }
}

function mapTicket(r: Row): Ticket {
  return {
    id: String(r.id),
    ticket_seq: n(r.ticket_seq),
    ticket_number: String(r.ticket_number ?? ""),
    title: String(r.title ?? ""),
    description: s(r.description),
    category: (s(r.category) ?? "other") as TicketCategory,
    severity: (isOneOf(TICKET_SEVERITIES, r.severity) ? r.severity : "medium") as TicketSeverity,
    status: (isOneOf(TICKET_STATUSES, r.status) ? r.status : "open") as TicketStatus,
    source: (s(r.source) ?? "internal") as TicketSource,
    project_id: s(r.project_id),
    project_title: s(r.project_title),
    client_tenant_id: s(r.client_tenant_id),
    client_tenant_name: s(r.client_tenant_name),
    client_name: s(r.client_name),
    client_email: s(r.client_email),
    client_company: s(r.client_company),
    client_match: s(r.client_match),
    project_hint: s(r.project_hint),
    customer_id: s(r.customer_id),
    reporter_user_id: s(r.reporter_user_id),
    assigned_to: s(r.assigned_to),
    resolution: s(r.resolution),
    attachments: parseAttachments(r.attachments),
    form_submission_id: s(r.form_submission_id),
    sla_target: String(r.sla_target ?? ""),
    first_response_at: s(r.first_response_at),
    sla_breached_at: s(r.sla_breached_at),
    sla_breach_alert_at: s(r.sla_breach_alert_at),
    sla_breach_alert_status: s(r.sla_breach_alert_status),
    founder_alert_at: s(r.founder_alert_at),
    founder_alert_status: s(r.founder_alert_status),
    client_ack_at: s(r.client_ack_at),
    client_ack_status: s(r.client_ack_status),
    resolved_at: s(r.resolved_at),
    closed_at: s(r.closed_at),
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
    comment_count: n(r.comment_count),
    last_public_reply_at: s(r.last_public_reply_at),
    last_public_reply_body: s(r.last_public_reply_body),
  };
}

export type TicketComment = {
  id: string;
  ticket_id: string;
  author_type: "client" | "team" | "system";
  author_user_id: string | null;
  author_name: string;
  body: string;
  is_internal: boolean;
  email_status: string | null;
  created_at: string;
  /** How it arrived (email, portal, form). Null before migration bravo__200 and for older comments. */
  channel?: string | null;
};

function mapComment(r: Row): TicketComment {
  return {
    id: String(r.id),
    ticket_id: String(r.ticket_id),
    author_type: (s(r.author_type) ?? "team") as TicketComment["author_type"],
    author_user_id: s(r.author_user_id),
    author_name: String(r.author_name ?? ""),
    body: String(r.body ?? ""),
    // Fail closed: only an explicit 0 is public.
    is_internal: !isClientVisibleComment({ is_internal: r.is_internal }),
    email_status: s(r.email_status),
    created_at: String(r.created_at ?? ""),
    channel: s(r.channel),
  };
}

export type Listed<T> = { rows: T[]; truncated: boolean };

function listed<T>(all: T[]): Listed<T> {
  return all.length > LIST_LIMIT ? { rows: all.slice(0, LIST_LIMIT), truncated: true } : { rows: all, truncated: false };
}

function likeArg(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// ---------------------------------------------------------------------------
// Projects — reads
// ---------------------------------------------------------------------------

export type ProjectFilters = {
  stage?: string | null;
  assignee?: string | null;
  q?: string | null;
  includeArchived?: boolean;
  /** A client record's projects (the team only; needs migration bravo__188). */
  customer_id?: string | null;
};

function projectSelect(viewer: DeliveryViewer): { sql: string; args: string[] } {
  // A client's open-ticket count only counts THEIR tickets on the project.
  // Same trusted-link rule as ticketRowScope — one list, CLIENT_VISIBLE_MATCHES.
  const clientTickets = viewer.kind === "client"
    ? ` AND s.client_tenant_id = ? AND s.client_match IN (${CLIENT_VISIBLE_MATCHES.map((m) => `'${m}'`).join(", ")})`
    : "";
  return {
    sql: `SELECT p.*, tn.name AS client_tenant_name,
      (SELECT COUNT(*) FROM delivery_tasks t
         WHERE t.tenant_id = p.tenant_id AND t.project_id = p.id AND t.status <> 'cancelled') AS task_count,
      (SELECT COUNT(*) FROM delivery_tasks t
         WHERE t.tenant_id = p.tenant_id AND t.project_id = p.id AND t.status = 'done') AS tasks_done,
      (SELECT COUNT(*) FROM support_tickets s
         WHERE s.tenant_id = p.tenant_id AND s.project_id = p.id
           AND s.status IN (${OPEN_STATUS_SQL})${clientTickets}) AS open_ticket_count,
      (SELECT u.created_at FROM delivery_updates u
         WHERE u.tenant_id = p.tenant_id AND u.project_id = p.id AND u.visibility = 'client'
         ORDER BY u.created_at DESC, u.id DESC LIMIT 1) AS last_client_update_at,
      (SELECT u.body FROM delivery_updates u
         WHERE u.tenant_id = p.tenant_id AND u.project_id = p.id AND u.visibility = 'client'
         ORDER BY u.created_at DESC, u.id DESC LIMIT 1) AS last_client_update_body
    FROM delivery_projects p
    LEFT JOIN tenants tn ON tn.id = p.client_tenant_id`,
    args: viewer.kind === "client" ? [viewer.clientTenantId] : [],
  };
}

export async function listProjects(
  db: Client,
  viewer: DeliveryViewer,
  filters: ProjectFilters = {},
): Promise<Listed<Project>> {
  const head = projectSelect(viewer);
  const scope = rowScope(viewer, "p");
  const where = [scope.sql];
  const args: string[] = [...head.args, ...scope.args];
  if (!filters.includeArchived) where.push("p.archived_at IS NULL");
  if (filters.stage && isOneOf(PROJECT_STAGES, filters.stage)) {
    where.push("p.stage = ?");
    args.push(filters.stage);
  }
  if (viewer.kind === "founder" && filters.customer_id) {
    where.push("p.customer_id = ?");
    args.push(filters.customer_id);
  }
  // Assignee and free-text search are founder tools; a client's view is small.
  if (viewer.kind === "founder" && filters.assignee) {
    if (filters.assignee === "unassigned") where.push("p.assigned_to IS NULL");
    else {
      where.push("p.assigned_to = ?");
      args.push(filters.assignee.trim().toLowerCase());
    }
  }
  if (viewer.kind === "founder" && filters.q && filters.q.trim()) {
    const like = likeArg(filters.q.trim());
    where.push(
      "(p.title LIKE ? ESCAPE '\\' OR p.client_name LIKE ? ESCAPE '\\' OR p.client_email LIKE ? ESCAPE '\\' OR tn.name LIKE ? ESCAPE '\\')",
    );
    args.push(like, like, like, like);
  }
  const rs = await db.execute({
    sql: `${head.sql}
      WHERE ${where.join(" AND ")}
      ORDER BY CASE p.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
               p.updated_at DESC, p.id
      LIMIT ${LIST_LIMIT + 1}`,
    args,
  });
  return listed(rows(rs).map(mapProject));
}

export async function getProject(db: Client, viewer: DeliveryViewer, id: string): Promise<Project | null> {
  const head = projectSelect(viewer);
  const scope = rowScope(viewer, "p");
  const rs = await db.execute({
    sql: `${head.sql} WHERE ${scope.sql} AND p.id = ? LIMIT 1`,
    args: [...head.args, ...scope.args, id],
  });
  const r = rows(rs)[0];
  return r ? mapProject(r) : null;
}

/** Tasks are internal work items: a client gets none, by construction. */
export async function listProjectTasks(db: Client, viewer: DeliveryViewer, projectId: string): Promise<Task[]> {
  if (viewer.kind !== "founder") return [];
  const scope = rowScope(viewer, "p");
  const rs = await db.execute({
    sql: `SELECT t.* FROM delivery_tasks t
          JOIN delivery_projects p ON p.id = t.project_id AND p.tenant_id = t.tenant_id
          WHERE ${scope.sql} AND t.project_id = ?
          ORDER BY CASE t.status WHEN 'done' THEN 1 WHEN 'cancelled' THEN 2 ELSE 0 END, t.sort_order, t.created_at, t.id`,
    args: [...scope.args, projectId],
  });
  return rows(rs).map((r) => ({
    id: String(r.id),
    project_id: String(r.project_id),
    title: String(r.title ?? ""),
    status: (s(r.status) ?? "todo") as TaskStatus,
    assigned_to: s(r.assigned_to),
    notes: s(r.notes),
    due_date: s(r.due_date),
    sort_order: n(r.sort_order),
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
    completed_at: s(r.completed_at),
  }));
}

export async function listProjectUpdates(
  db: Client,
  viewer: DeliveryViewer,
  projectId: string,
): Promise<ProjectUpdate[]> {
  const scope = rowScope(viewer, "p");
  const rs = await db.execute({
    sql: `SELECT u.* FROM delivery_updates u
          JOIN delivery_projects p ON p.id = u.project_id AND p.tenant_id = u.tenant_id
          WHERE ${scope.sql} AND u.project_id = ? AND ${updateScope(viewer, "u")}
          ORDER BY u.created_at DESC, u.id DESC
          LIMIT 200`,
    args: [...scope.args, projectId],
  });
  return rows(rs).map((r) => ({
    id: String(r.id),
    project_id: String(r.project_id),
    author_user_id: s(r.author_user_id),
    author_name: String(r.author_name ?? ""),
    body: String(r.body ?? ""),
    visibility: (r.visibility === "client" ? "client" : "internal") as UpdateVisibility,
    created_at: String(r.created_at ?? ""),
  }));
}

// ---------------------------------------------------------------------------
// Tickets — reads
// ---------------------------------------------------------------------------

export type TicketFilters = {
  /**
   * "open" (default) = the working statuses; "team" = open + in progress (the
   * ball is in the team's court); "closed" = resolved + closed; "all"; or one status.
   */
  status?: string | null;
  severity?: string | null;
  project_id?: string | null;
  /** An auth user id, or "unassigned". */
  assignee?: string | null;
  q?: string | null;
  /** A client record's tickets (the team only; needs migration bravo__188). */
  customer_id?: string | null;
};

function ticketSelect(viewer: DeliveryViewer): { sql: string; args: string[] } {
  // A client only ever sees the title of a project that is THEIR project.
  const projectJoin =
    viewer.kind === "client"
      ? "LEFT JOIN delivery_projects p ON p.id = t.project_id AND p.tenant_id = t.tenant_id AND p.client_tenant_id = ?"
      : "LEFT JOIN delivery_projects p ON p.id = t.project_id AND p.tenant_id = t.tenant_id";
  return {
    sql: `SELECT t.*, p.title AS project_title, tn.name AS client_tenant_name,
      (SELECT COUNT(*) FROM ticket_comments c
         WHERE c.tenant_id = t.tenant_id AND c.ticket_id = t.id AND ${commentScope(viewer, "c")}) AS comment_count,
      (SELECT c.created_at FROM ticket_comments c
         WHERE c.tenant_id = t.tenant_id AND c.ticket_id = t.id AND c.is_internal = 0 AND c.author_type = 'team'
         ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS last_public_reply_at,
      (SELECT c.body FROM ticket_comments c
         WHERE c.tenant_id = t.tenant_id AND c.ticket_id = t.id AND c.is_internal = 0 AND c.author_type = 'team'
         ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS last_public_reply_body
    FROM support_tickets t
    ${projectJoin}
    LEFT JOIN tenants tn ON tn.id = t.client_tenant_id`,
    args: viewer.kind === "client" ? [viewer.clientTenantId] : [],
  };
}

export async function listTickets(
  db: Client,
  viewer: DeliveryViewer,
  filters: TicketFilters = {},
): Promise<Listed<Ticket>> {
  const head = ticketSelect(viewer);
  const scope = ticketRowScope(viewer, "t");
  const where = [scope.sql];
  const args: string[] = [...head.args, ...scope.args];
  const status = filters.status || "open";
  if (status === "open") where.push(`t.status IN (${OPEN_STATUS_SQL})`);
  else if (status === "team") where.push("t.status IN ('open', 'in_progress')");
  else if (status === "closed") where.push("t.status IN ('resolved', 'closed')");
  else if (isOneOf(TICKET_STATUSES, status)) {
    where.push("t.status = ?");
    args.push(status);
  }
  if (filters.severity && isOneOf(TICKET_SEVERITIES, filters.severity)) {
    where.push("t.severity = ?");
    args.push(filters.severity);
  }
  if (filters.project_id) {
    where.push("t.project_id = ?");
    args.push(filters.project_id);
  }
  if (viewer.kind === "founder" && filters.customer_id) {
    where.push("t.customer_id = ?");
    args.push(filters.customer_id);
  }
  if (viewer.kind === "founder" && filters.assignee) {
    if (filters.assignee === "unassigned") where.push("t.assigned_to IS NULL");
    else {
      where.push("t.assigned_to = ?");
      args.push(filters.assignee.trim().toLowerCase());
    }
  }
  if (viewer.kind === "founder" && filters.q && filters.q.trim()) {
    const like = likeArg(filters.q.trim());
    where.push(
      "(t.ticket_number LIKE ? ESCAPE '\\' OR t.title LIKE ? ESCAPE '\\' OR t.client_name LIKE ? ESCAPE '\\' OR t.client_email LIKE ? ESCAPE '\\' OR t.client_company LIKE ? ESCAPE '\\')",
    );
    args.push(like, like, like, like, like);
  }
  const rs = await db.execute({
    sql: `${head.sql}
      WHERE ${where.join(" AND ")}
      ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'waiting_on_client' THEN 2
                              WHEN 'resolved' THEN 3 ELSE 4 END,
               CASE t.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
               t.created_at DESC, t.id
      LIMIT ${LIST_LIMIT + 1}`,
    args,
  });
  return listed(rows(rs).map(mapTicket));
}

export async function getTicket(db: Client, viewer: DeliveryViewer, id: string): Promise<Ticket | null> {
  const head = ticketSelect(viewer);
  const scope = ticketRowScope(viewer, "t");
  const rs = await db.execute({
    sql: `${head.sql} WHERE ${scope.sql} AND t.id = ? LIMIT 1`,
    args: [...head.args, ...scope.args, id],
  });
  const r = rows(rs)[0];
  return r ? mapTicket(r) : null;
}

export async function listTicketComments(
  db: Client,
  viewer: DeliveryViewer,
  ticketId: string,
): Promise<TicketComment[]> {
  const scope = ticketRowScope(viewer, "t");
  const rs = await db.execute({
    sql: `SELECT c.* FROM ticket_comments c
          JOIN support_tickets t ON t.id = c.ticket_id AND t.tenant_id = c.tenant_id
          WHERE ${scope.sql} AND c.ticket_id = ? AND ${commentScope(viewer, "c")}
          ORDER BY c.created_at, c.id
          LIMIT 1000`,
    args: [...scope.args, ticketId],
  });
  return rows(rs).map(mapComment);
}

// ---------------------------------------------------------------------------
// Lookups used by validation
// ---------------------------------------------------------------------------

export type ClientTenant = { id: string; name: string; slug: string | null };

/**
 * Client workspaces an OASIS project/ticket may belong to: every tenant except
 * OASIS itself and a retired business (lib/os/customers/retired.ts). OASIS's
 * desk only — no other desk links rows to a workspace.
 */
export async function listClientTenants(db: Client): Promise<ClientTenant[]> {
  const live = notRetiredTenantSql("id");
  const rs = await db.execute({
    sql: `SELECT id, name, slug FROM tenants WHERE id <> ? AND ${live.sql} ORDER BY name, id LIMIT 500`,
    args: [DELIVERY_TENANT_ID, ...live.args],
  });
  return rows(rs).map((r) => ({ id: String(r.id), name: String(r.name ?? r.slug ?? r.id), slug: s(r.slug) }));
}

/** May a project or ticket name this workspace as its client? Not OASIS itself, not a retired business, and it must exist. */
export async function clientTenantExists(db: Client, tenantId: string): Promise<boolean> {
  if (tenantId === DELIVERY_TENANT_ID || isRetiredClientRef({ client_tenant_id: tenantId })) return false;
  const rs = await db.execute({ sql: "SELECT 1 AS ok FROM tenants WHERE id = ? LIMIT 1", args: [tenantId] });
  return rs.rows.length > 0;
}

/** Is `leadId` a lead in THIS desk's own pipeline? */
export async function deskLeadExists(db: Client, tenantId: string, leadId: string): Promise<boolean> {
  const rs = await db.execute({
    sql: "SELECT 1 AS ok FROM tenant_records WHERE tenant_id = ? AND id = ? AND entity_type = 'lead' LIMIT 1",
    args: [requireTenant(tenantId), leadId],
  });
  return rs.rows.length > 0;
}

/**
 * Is `customerId` a client record of THIS desk's workspace that a ticket or
 * project may name? Not one linked to a retired business's workspace
 * (lib/os/customers/retired.ts). (Needs migration bravo__188.)
 */
export async function deskCustomerExists(db: Client, tenantId: string, customerId: string): Promise<boolean> {
  const rs = await readNotRetired("client_tenant_id", (guard) =>
    db.execute({
      sql: `SELECT 1 AS ok FROM customers WHERE tenant_id = ? AND id = ? AND ${guard.sql} LIMIT 1`,
      args: [requireTenant(tenantId), customerId, ...guard.args],
    }),
  );
  return rs.rows.length > 0;
}

/**
 * The client record a project belongs to, or null. A ticket on a project
 * belongs to the same client (Codex, PR #473): tickets inherit it, a different
 * one is refused, and changing the project's client moves its tickets. A
 * database without migration bravo__188 has no client records, so null.
 */
export async function projectCustomerId(db: Client, tenantId: string, projectId: string): Promise<string | null> {
  try {
    const r = rows(
      await db.execute({
        sql: "SELECT customer_id FROM delivery_projects WHERE tenant_id = ? AND id = ? LIMIT 1",
        args: [requireTenant(tenantId), projectId],
      }),
    )[0];
    return s(r?.customer_id);
  } catch (err) {
    if (/no such column: customer_id/i.test(err instanceof Error ? err.message : String(err))) return null;
    throw err;
  }
}

/** Name + email for a signed-in person, from their profile in the workspace they act in. */
export async function profileContact(
  db: Client,
  userId: string,
  tenantId: string,
): Promise<{ name: string; email: string | null }> {
  const rs = await db.execute({
    sql: `SELECT display_name, full_name, email FROM user_profiles
          WHERE lower(auth_user_id) = ? AND tenant_id = ?
          ORDER BY is_owner DESC, id LIMIT 1`,
    args: [userId.trim().toLowerCase(), tenantId],
  });
  const r = rows(rs)[0];
  const pick = [r?.display_name, r?.full_name].map((v) => String(v ?? "").trim()).find((v) => v && !v.includes("@"));
  const email = r?.email ? String(r.email).trim().toLowerCase() : null;
  return { name: pick || (email ? email.split("@")[0] : "Team member"), email };
}

// ---------------------------------------------------------------------------
// Projects — writes (founder only; routes check mayPerform first)
// ---------------------------------------------------------------------------

export type Author = { userId: string | null; name: string };

export type NewProject = {
  title: string;
  description: string | null;
  client_tenant_id: string | null;
  client_name: string | null;
  client_email: string | null;
  lead_id: string | null;
  stage: ProjectStage;
  priority: ProjectPriority;
  assigned_to: string | null;
  due_date: string | null;
  /** Written only when set (migration bravo__188). */
  customer_id?: string | null;
};

const STARTED_STAGES: readonly ProjectStage[] = ["building", "review", "live", "maintenance"];
const LAUNCHED_STAGES: readonly ProjectStage[] = ["live", "maintenance"];

function updateStatement(
  tenantId: string,
  projectId: string,
  author: Author,
  body: string,
  visibility: UpdateVisibility,
  at: string,
  id: string = randomUUID(),
): InStatement {
  return {
    sql: `INSERT INTO delivery_updates (id, project_id, tenant_id, author_user_id, author_name, body, visibility, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, projectId, tenantId, author.userId, author.name, body, visibility, at],
  };
}

export async function createProject(
  db: Client,
  tenantId: string,
  input: NewProject,
  author: Author,
  now: Date,
): Promise<string> {
  requireTenant(tenantId);
  const id = randomUUID();
  const at = now.toISOString();
  const cols = [
    "id", "tenant_id", "title", "description", "client_tenant_id", "client_name", "client_email", "lead_id",
    "stage", "priority", "assigned_to", "due_date", "started_at", "launched_at", "created_by", "created_at", "updated_at",
  ];
  const vals: Array<string | null> = [
    id,
    tenantId,
    input.title,
    input.description,
    input.client_tenant_id,
    input.client_name,
    input.client_email,
    input.lead_id,
    input.stage,
    input.priority,
    input.assigned_to,
    input.due_date,
    STARTED_STAGES.includes(input.stage) ? at : null,
    LAUNCHED_STAGES.includes(input.stage) ? at : null,
    author.userId,
    at,
    at,
  ];
  if (input.customer_id) {
    cols.push("customer_id");
    vals.push(input.customer_id);
  }
  await db.batch(
    [
      {
        sql: `INSERT INTO delivery_projects (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        args: vals,
      },
      updateStatement(tenantId, id, author, `Project created in the ${PROJECT_STAGE_LABELS[input.stage]} stage.`, "internal", at),
    ],
    "write",
  );
  return id;
}

export type ProjectChanges = Partial<{
  title: string;
  description: string | null;
  client_tenant_id: string | null;
  client_name: string | null;
  client_email: string | null;
  lead_id: string | null;
  customer_id: string | null;
  stage: ProjectStage;
  priority: ProjectPriority;
  assigned_to: string | null;
  due_date: string | null;
  archived: boolean;
}>;

const PROJECT_COLUMNS = [
  "title",
  "description",
  "client_tenant_id",
  "client_name",
  "client_email",
  "lead_id",
  "customer_id",
  "stage",
  "priority",
  "assigned_to",
  "due_date",
] as const;

/** Returns false when the project does not exist in the workspace. */
export async function updateProject(
  db: Client,
  tenantId: string,
  id: string,
  changes: ProjectChanges,
  author: Author,
  now: Date,
): Promise<boolean> {
  requireTenant(tenantId);
  const cur = rows(
    await db.execute({
      sql: "SELECT stage, started_at, launched_at, archived_at FROM delivery_projects WHERE tenant_id = ? AND id = ?",
      args: [tenantId, id],
    }),
  )[0];
  if (!cur) return false;
  const at = now.toISOString();
  const sets: string[] = [];
  const args: Array<string | null> = [];
  for (const col of PROJECT_COLUMNS) {
    if (!(col in changes)) continue;
    sets.push(`${col} = ?`);
    args.push((changes as Record<string, string | null>)[col] ?? null);
  }
  const timeline: InStatement[] = [];
  const fromStage = String(cur.stage) as ProjectStage;
  if (changes.stage && changes.stage !== fromStage) {
    if (!cur.started_at && STARTED_STAGES.includes(changes.stage)) {
      sets.push("started_at = ?");
      args.push(at);
    }
    if (!cur.launched_at && LAUNCHED_STAGES.includes(changes.stage)) {
      sets.push("launched_at = ?");
      args.push(at);
    }
    const fromLabel = isOneOf(PROJECT_STAGES, fromStage) ? PROJECT_STAGE_LABELS[fromStage] : fromStage;
    timeline.push(
      updateStatement(tenantId, id, author, `Stage moved from ${fromLabel} to ${PROJECT_STAGE_LABELS[changes.stage]}.`, "internal", at),
    );
  }
  if (changes.archived !== undefined && changes.archived !== Boolean(cur.archived_at)) {
    sets.push("archived_at = ?");
    args.push(changes.archived ? at : null);
    timeline.push(updateStatement(tenantId, id, author, changes.archived ? "Project archived." : "Project restored from the archive.", "internal", at));
  }
  if (sets.length === 0) return true;
  sets.push("updated_at = ?");
  args.push(at);
  // A project's tickets belong to its client: re-pointing the project moves
  // them in the same batch, so the client record and the project never
  // disagree about who a ticket is for.
  const ticketsFollow: InStatement[] =
    "customer_id" in changes
      ? [
          {
            sql: "UPDATE support_tickets SET customer_id = ?, updated_at = ? WHERE tenant_id = ? AND project_id = ?",
            args: [changes.customer_id ?? null, at, tenantId, id],
          },
        ]
      : [];
  await db.batch(
    [
      {
        sql: `UPDATE delivery_projects SET ${sets.join(", ")} WHERE tenant_id = ? AND id = ?`,
        args: [...args, tenantId, id],
      },
      ...ticketsFollow,
      ...timeline,
    ],
    "write",
  );
  return true;
}

export async function addProjectUpdate(
  db: Client,
  tenantId: string,
  projectId: string,
  input: { body: string; visibility: UpdateVisibility },
  author: Author,
  now: Date,
): Promise<string | null> {
  if (!(await projectExists(db, tenantId, projectId))) return null;
  const at = now.toISOString();
  const id = randomUUID();
  await db.batch(
    [
      updateStatement(tenantId, projectId, author, input.body, input.visibility, at, id),
      { sql: "UPDATE delivery_projects SET updated_at = ? WHERE tenant_id = ? AND id = ?", args: [at, tenantId, projectId] },
    ],
    "write",
  );
  return id;
}

export async function projectExists(db: Client, tenantId: string, projectId: string): Promise<boolean> {
  const rs = await db.execute({
    sql: "SELECT 1 AS ok FROM delivery_projects WHERE tenant_id = ? AND id = ? LIMIT 1",
    args: [requireTenant(tenantId), projectId],
  });
  return rs.rows.length > 0;
}

export async function createTask(
  db: Client,
  tenantId: string,
  projectId: string,
  input: { title: string; notes: string | null; due_date: string | null; assigned_to: string | null },
  now: Date,
): Promise<string | null> {
  if (!(await projectExists(db, tenantId, projectId))) return null;
  const id = randomUUID();
  const at = now.toISOString();
  await db.batch(
    [
      {
        sql: `INSERT INTO delivery_tasks (id, project_id, tenant_id, title, status, assigned_to, notes, due_date, sort_order, created_at, updated_at)
              SELECT ?, ?, ?, ?, 'todo', ?, ?, ?, COALESCE(MAX(sort_order), 0) + 1, ?, ?
              FROM delivery_tasks WHERE tenant_id = ? AND project_id = ?`,
        args: [id, projectId, tenantId, input.title, input.assigned_to, input.notes, input.due_date, at, at, tenantId, projectId],
      },
      { sql: "UPDATE delivery_projects SET updated_at = ? WHERE tenant_id = ? AND id = ?", args: [at, tenantId, projectId] },
    ],
    "write",
  );
  return id;
}

/** Returns false when the task does not exist on that project in the workspace. */
export async function updateTask(
  db: Client,
  tenantId: string,
  projectId: string,
  taskId: string,
  changes: Partial<{ title: string; notes: string | null; due_date: string | null; status: TaskStatus; sort_order: number; assigned_to: string | null }>,
  now: Date,
): Promise<boolean> {
  requireTenant(tenantId);
  const at = now.toISOString();
  const sets: string[] = [];
  const args: Array<string | number | null> = [];
  for (const col of ["title", "notes", "due_date", "status", "sort_order", "assigned_to"] as const) {
    if (!(col in changes)) continue;
    sets.push(`${col} = ?`);
    args.push((changes as Record<string, string | number | null>)[col] ?? null);
  }
  if (changes.status) {
    sets.push("completed_at = ?");
    args.push(changes.status === "done" ? at : null);
  }
  if (sets.length === 0) return true;
  sets.push("updated_at = ?");
  args.push(at);
  const results = await db.batch(
    [
      {
        sql: `UPDATE delivery_tasks SET ${sets.join(", ")} WHERE tenant_id = ? AND project_id = ? AND id = ?`,
        args: [...args, tenantId, projectId, taskId],
      },
      { sql: "UPDATE delivery_projects SET updated_at = ? WHERE tenant_id = ? AND id = ?", args: [at, tenantId, projectId] },
    ],
    "write",
  );
  return results[0].rowsAffected === 1;
}

// ---------------------------------------------------------------------------
// Ticket events for the Business Ledger (this module owns them)
// ---------------------------------------------------------------------------

export const DELIVERY_LEDGER_PRODUCER = "lib/delivery/store.ts";

type TicketEventKind = "opened" | "first_response" | "resolved" | "reopened";

const TICKET_EVENT_KEYS: Record<TicketEventKind, string> = {
  opened: "ticket.opened",
  first_response: "ticket.first_response",
  resolved: "ticket.resolved",
  reopened: "ticket.reopened",
};

function ticketEvent(
  kind: TicketEventKind,
  args: {
    tenantId: string;
    ticketId: string;
    customerId: string | null;
    actorUserId: string | null;
    /**
     * The last part of the catalog's key shape: the occurrence of this event on
     * this ticket (n), or for ticket.reopened the comment that reopened it, so
     * two reopenings racing each other never share a key.
     */
    n: number | string;
    payload: Record<string, unknown>;
    conditional: boolean;
  },
  now: Date,
): LedgerStatement {
  const input = {
    tenantId: args.tenantId,
    eventKey: TICKET_EVENT_KEYS[kind],
    eventVersion: 1,
    occurredAt: now,
    subject: { type: "ticket", id: args.ticketId },
    customerId: args.customerId,
    actor: args.actorUserId ? { type: "human" as const, id: args.actorUserId } : { type: "system" as const, id: null },
    source: "native" as const,
    idempotencyKey: `tkt:${args.ticketId}:${kind}:${args.n}`,
    confidence: "verified" as const,
    payload: args.payload,
    producer: DELIVERY_LEDGER_PRODUCER,
  };
  return args.conditional ? emitIfChanged(input, now) : emit(input, now);
}

/** A ledger id or null: a free-text actor (the support form's "system") is not an id. */
function actorId(userId: string | null | undefined): string | null {
  return userId && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(userId) && userId !== "system" ? userId : null;
}

// ---------------------------------------------------------------------------
// Tickets — writes
// ---------------------------------------------------------------------------

export type NewTicket = {
  /** Supplied by the support intake so the id can be recorded on the submission first. */
  id?: string;
  title: string;
  description: string | null;
  category: TicketCategory;
  severity: TicketSeverity;
  source: TicketSource;
  project_id: string | null;
  client_tenant_id: string | null;
  client_name: string | null;
  client_email: string | null;
  client_company: string | null;
  client_match: string | null;
  project_hint: string | null;
  reporter_user_id: string | null;
  assigned_to: string | null;
  attachments?: Attachment[];
  form_submission_id?: string | null;
  /** The client record the requester is. Written only when set (migration bravo__188). */
  customer_id?: string | null;
};

async function findTicketIdBySubmission(db: Client, tenantId: string, submissionId: string): Promise<string | null> {
  const rs = await db.execute({
    sql: "SELECT id FROM support_tickets WHERE tenant_id = ? AND form_submission_id = ? LIMIT 1",
    args: [tenantId, submissionId],
  });
  return rs.rows.length ? String(rows(rs)[0].id) : null;
}

/** Is `id` already a ticket on this desk? */
async function ticketExists(db: Client, tenantId: string, id: string): Promise<boolean> {
  const rs = await db.execute({ sql: "SELECT 1 AS ok FROM support_tickets WHERE tenant_id = ? AND id = ? LIMIT 1", args: [tenantId, id] });
  return rs.rows.length > 0;
}

/**
 * Create a ticket and allocate its number in the same statement.
 *
 * NUMBERING. `INSERT ... SELECT MAX(ticket_seq) + 1` is one statement, and
 * SQLite serialises writes, so two inserts cannot read the same MAX inside it.
 * The unique (tenant_id, ticket_seq) index is the backstop for anything that
 * ever breaks that assumption (a replica, a future batch path): a collision is
 * retried with a fresh MAX, never written twice.
 *
 * IDEMPOTENCY. A ticket from the support form carries its form_submissions id,
 * which is unique per tenant. Creating it a second time — the reconcile sweep
 * racing the live request, a retried after() callback — returns the ticket
 * that already exists with created:false instead of a duplicate.
 *
 * A SUPPLIED ID is a key too: the support inbox plans its ticket id before it
 * writes anything (email-intake.ts), so a retried or concurrent ingest of one
 * email asks for the same id and gets the ticket the first attempt made,
 * created:false, never a second ticket and never an error.
 *
 * Numbering and idempotency are both PER DESK: each workspace's tickets start
 * at T-0001, and a submission id only ever matches its own desk's ticket.
 */
export async function createTicket(
  db: Client,
  tenantId: string,
  input: NewTicket,
  now: Date,
): Promise<{ ticket: Ticket; created: boolean }> {
  requireTenant(tenantId);
  const reader = deskReader(tenantId);
  if (input.form_submission_id) {
    const existing = await findTicketIdBySubmission(db, tenantId, input.form_submission_id);
    if (existing) return { ticket: (await getTicket(db, reader, existing))!, created: false };
  }
  if (input.id && (await ticketExists(db, tenantId, input.id))) {
    return { ticket: (await getTicket(db, reader, input.id))!, created: false };
  }
  const id = input.id ?? randomUUID();
  const at = now.toISOString();
  const slaTarget = slaTargetFor(at, input.severity);
  // customer_id only when there is one, so a database without migration
  // bravo__188 still takes every ticket OASIS's desk files today.
  const customerCol = input.customer_id ? ", customer_id" : "";
  const customerVal = input.customer_id ? ", ?" : "";
  // ticket.opened rides in the same batch as the insert, conditional on it
  // (a lost numbering race writes neither). priority is the severity code,
  // channel the intake it came through.
  const opened = ticketEvent(
    "opened",
    {
      tenantId,
      ticketId: id,
      customerId: input.customer_id ?? null,
      actorUserId: actorId(input.reporter_user_id),
      n: 1,
      payload: { priority: input.severity, channel: input.source },
      conditional: true,
    },
    now,
  );
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await db.batch([{
        sql: `INSERT INTO support_tickets
                (id, tenant_id, ticket_seq, ticket_number, title, description, category, severity, status, source,
                 project_id, client_tenant_id, client_name, client_email, client_company, client_match, project_hint,
                 reporter_user_id, assigned_to, attachments, form_submission_id, sla_target, created_at, updated_at${customerCol})
              SELECT ?, ?, n.seq, 'T-' || printf('%04d', n.seq), ?, ?, ?, ?, 'open', ?,
                     ?, ?, ?, ?, ?, ?, ?,
                     ?, ?, ?, ?, ?, ?, ?${customerVal}
              FROM (SELECT COALESCE(MAX(ticket_seq), 0) + 1 AS seq FROM support_tickets WHERE tenant_id = ?) AS n`,
        args: [
          id,
          tenantId,
          input.title,
          input.description,
          input.category,
          input.severity,
          input.source,
          input.project_id,
          input.client_tenant_id,
          input.client_name,
          input.client_email,
          input.client_company,
          input.client_match,
          input.project_hint,
          input.reporter_user_id,
          input.assigned_to,
          JSON.stringify(input.attachments ?? []),
          input.form_submission_id ?? null,
          slaTarget,
          at,
          at,
          ...(input.customer_id ? [input.customer_id] : []),
          tenantId,
        ],
      }, opened], "write");
      return { ticket: (await getTicket(db, reader, id))!, created: true };
    } catch (err) {
      const e = err as { message?: string; code?: string };
      if (!isUniqueViolationError(e)) throw err;
      if (input.form_submission_id) {
        const existing = await findTicketIdBySubmission(db, tenantId, input.form_submission_id);
        if (existing) return { ticket: (await getTicket(db, reader, existing))!, created: false };
      }
      // A concurrent create with the same supplied id won the insert.
      if (input.id && (await ticketExists(db, tenantId, input.id))) {
        return { ticket: (await getTicket(db, reader, input.id))!, created: false };
      }
      if (attempt === 5) {
        throw new Error(`ticket_number_allocation_failed after ${attempt} attempts: ${e.message ?? String(err)}`);
      }
    }
  }
  throw new Error("ticket_number_allocation_failed");
}

export type TicketChanges = Partial<{
  title: string;
  description: string | null;
  status: TicketStatus;
  severity: TicketSeverity;
  category: TicketCategory;
  resolution: string | null;
  project_id: string | null;
  client_tenant_id: string | null;
  client_name: string | null;
  client_email: string | null;
  client_company: string | null;
  assigned_to: string | null;
  confirm_client_link: true;
  /** Link the ticket to a client record of this desk's workspace (null unlinks). */
  customer_id: string | null;
}>;

export type TicketUpdateResult =
  | { ok: true; changed: string[] }
  | {
      ok: false;
      status: 404 | 409;
      error:
        | "not_found"
        | "invalid_transition"
        | "project_belongs_to_another_client"
        | "project_not_found"
        | "no_inferred_client_link"
        | "customer_not_found"
        | "project_belongs_to_another_customer";
    };

/**
 * Apply a founder's edit. Status moves are checked against TICKET_TRANSITIONS
 * and land only on a ticket still in the status they were checked from (else
 * 409 invalid_transition, nothing written); a severity change on an
 * unanswered ticket re-targets its SLA; linking a project refuses a project
 * that belongs to a different client, and a ticket with no client inherits
 * the project's (the founder just said whose it is).
 * A ticket moved onto a project takes that project's client record; naming a
 * different one while it sits there is refused. A client record can only be
 * one of THIS desk's (tenant_id, id) pairs.
 * Every change leaves an internal system line in the thread.
 */
export async function updateTicket(
  db: Client,
  tenantId: string,
  id: string,
  changes: TicketChanges,
  author: Author,
  now: Date,
  names: { assignee?: (id: string | null) => string | null; customer?: (id: string | null) => string | null } = {},
): Promise<TicketUpdateResult> {
  requireTenant(tenantId);
  const cur = rows(
    await db.execute({
      sql: "SELECT * FROM support_tickets WHERE tenant_id = ? AND id = ?",
      args: [tenantId, id],
    }),
  )[0];
  if (!cur) return { ok: false, status: 404, error: "not_found" };
  const at = now.toISOString();
  const sets: string[] = [];
  const args: Array<string | null> = [];
  const notes: string[] = [];
  const set = (col: string, v: string | null) => {
    sets.push(`${col} = ?`);
    args.push(v);
  };

  for (const col of ["title", "description", "category", "resolution", "client_name", "client_email", "client_company"] as const) {
    if (col in changes && (changes[col] ?? null) !== (s(cur[col]) ?? null)) set(col, changes[col] ?? null);
  }

  const fromStatus = String(cur.status) as TicketStatus;
  if (changes.status && changes.status !== fromStatus) {
    if (!canTransitionTicket(fromStatus, changes.status)) return { ok: false, status: 409, error: "invalid_transition" };
    const stamps = statusTimestampsFor(changes.status, { resolved_at: s(cur.resolved_at) }, at);
    set("status", changes.status);
    set("resolved_at", stamps.resolved_at);
    set("closed_at", stamps.closed_at);
    notes.push(`Status: ${TICKET_STATUS_LABELS[fromStatus] ?? fromStatus} to ${TICKET_STATUS_LABELS[changes.status]}.`);
  }

  if (changes.severity && changes.severity !== cur.severity) {
    set("severity", changes.severity);
    const re = retargetForSeverity(
      { created_at: String(cur.created_at), first_response_at: s(cur.first_response_at) },
      changes.severity,
      now,
    );
    if (re) {
      set("sla_target", re.sla_target);
      if (re.clearBreach) {
        set("sla_breached_at", null);
        set("sla_breach_alert_at", null);
        set("sla_breach_alert_status", null);
      }
    }
    notes.push(`Severity: ${String(cur.severity)} to ${changes.severity}${re ? " (first-response target recalculated)" : ""}.`);
  }

  let clientTenant = s(cur.client_tenant_id);
  if (changes.confirm_client_link) {
    const inferred = cur.client_match === "email_project" || cur.client_match === "email_tenant";
    if (!inferred || !clientTenant) return { ok: false, status: 409, error: "no_inferred_client_link" };
    set("client_match", "manual");
    notes.push("Client link confirmed by a founder — the client can now see this ticket.");
  }
  if ("client_tenant_id" in changes && (changes.client_tenant_id ?? null) !== clientTenant) {
    clientTenant = changes.client_tenant_id ?? null;
    set("client_tenant_id", clientTenant);
    set("client_match", clientTenant ? "manual" : "none");
    notes.push(clientTenant ? "Linked to a client workspace." : "Unlinked from the client workspace.");
  }

  if ("project_id" in changes && (changes.project_id ?? null) !== s(cur.project_id)) {
    if (changes.project_id) {
      const p = rows(
        await db.execute({
          sql: "SELECT id, title, client_tenant_id FROM delivery_projects WHERE tenant_id = ? AND id = ?",
          args: [tenantId, changes.project_id],
        }),
      )[0];
      if (!p) return { ok: false, status: 409, error: "project_not_found" };
      const projectClient = s(p.client_tenant_id);
      if (projectClient && clientTenant && projectClient !== clientTenant) {
        return { ok: false, status: 409, error: "project_belongs_to_another_client" };
      }
      if (projectClient && !clientTenant) {
        clientTenant = projectClient;
        set("client_tenant_id", projectClient);
        set("client_match", "manual");
      }
      set("project_id", changes.project_id);
      notes.push(`Linked to project "${String(p.title)}".`);
    } else {
      set("project_id", null);
      notes.push("Unlinked from its project.");
    }
  } else if ("client_tenant_id" in changes && clientTenant && cur.project_id) {
    // Changing the client of a ticket that sits on another client's project
    // would leave it visible under the wrong workspace's project.
    const p = rows(
      await db.execute({
        sql: "SELECT client_tenant_id FROM delivery_projects WHERE tenant_id = ? AND id = ?",
        args: [tenantId, String(cur.project_id)],
      }),
    )[0];
    const projectClient = s(p?.client_tenant_id);
    if (projectClient && projectClient !== clientTenant) {
      return { ok: false, status: 409, error: "project_belongs_to_another_client" };
    }
  }

  // A ticket on a project belongs to the project's client record. Moving the
  // ticket onto a project takes that project's client (the editor saves one
  // field at a time, so the old client is not a contradiction); naming, or
  // clearing, a different client while it sits on one is refused. A project
  // with no client leaves the ticket's own.
  if ("project_id" in changes || "customer_id" in changes) {
    const projectId = "project_id" in changes ? changes.project_id ?? null : s(cur.project_id);
    const projectCustomer = projectId ? await projectCustomerId(db, tenantId, projectId) : null;
    const named = "customer_id" in changes ? changes.customer_id ?? null : undefined;
    if (projectCustomer && named !== undefined && named !== projectCustomer) {
      return { ok: false, status: 409, error: "project_belongs_to_another_customer" };
    }
    const next = projectCustomer ?? (named === undefined ? s(cur.customer_id) : named);
    if (next !== s(cur.customer_id)) {
      if (next && !projectCustomer && !(await deskCustomerExists(db, tenantId, next))) {
        return { ok: false, status: 409, error: "customer_not_found" };
      }
      set("customer_id", next);
      const who = names.customer?.(next);
      notes.push(
        next
          ? `Linked to client ${who ? `"${who}"` : "record"}${named === undefined ? ", the project's client" : ""}.`
          : "Unlinked from its client record.",
      );
    }
  }

  if ("assigned_to" in changes && (changes.assigned_to ?? null) !== s(cur.assigned_to)) {
    set("assigned_to", changes.assigned_to ?? null);
    const who = names.assignee?.(changes.assigned_to ?? null);
    notes.push(changes.assigned_to ? `Assigned to ${who ?? "a teammate"}.` : "Unassigned.");
  }

  if (sets.length === 0) return { ok: true, changed: [] };
  set("updated_at", at);
  // A status move was checked from the status read above, so it lands only if
  // the ticket still has it (compare-and-swap). Two founders resolving at once
  // resolve it once: the late one changes no row, so its thread line and its
  // ledger row below (each conditional on the statement before it) are not
  // written, and it is told the status moved.
  const movesStatus = sets.includes("status = ?");
  const stmts: InStatement[] = [
    {
      sql: `UPDATE support_tickets SET ${sets.join(", ")} WHERE tenant_id = ? AND id = ?${movesStatus ? " AND status = ?" : ""}`,
      args: [...args, tenantId, id, ...(movesStatus ? [fromStatus] : [])],
    },
  ];
  if (notes.length) {
    stmts.push({
      sql: `INSERT INTO ticket_comments (id, ticket_id, tenant_id, author_type, author_user_id, author_name, body, is_internal, created_at)
            SELECT ?, ?, ?, 'system', ?, ?, ?, 1, ? WHERE changes() = 1`,
      args: [randomUUID(), id, tenantId, author.userId, author.name, notes.join(" "), at],
    });
  }
  if (changes.status === "resolved" && fromStatus !== "resolved") {
    // The n-th resolution of this ticket (a reopened ticket resolves again).
    const prior = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM outcome_events
            WHERE tenant_id = ? AND subject_type = 'ticket' AND subject_id = ? AND event_key = ?`,
      args: [tenantId, id, TICKET_EVENT_KEYS.resolved],
    });
    const customerAfter = sets.includes("customer_id = ?") ? args[sets.indexOf("customer_id = ?")] : s(cur.customer_id);
    stmts.push(
      ticketEvent(
        "resolved",
        {
          tenantId,
          ticketId: id,
          customerId: customerAfter ?? null,
          actorUserId: actorId(author.userId),
          n: Number(rows(prior)[0]?.n ?? 0) + 1,
          payload: {},
          conditional: true,
        },
        now,
      ),
    );
  }
  const results = await db.batch(stmts, "write");
  if (movesStatus && results[0].rowsAffected !== 1) return { ok: false, status: 409, error: "invalid_transition" };
  return { ok: true, changed: sets.map((x) => x.split(" = ")[0]).filter((c) => c !== "updated_at") };
}

export type CommentResult =
  | { ok: true; comment: TicketComment; firstResponse: boolean; reopened: boolean; existing?: true }
  | { ok: false; status: 404 | 409; error: "not_found" | "ticket_closed" | "superseded" };

/** How a comment reached the desk (ticket_comments.channel, migration bravo__200). */
export const COMMENT_CHANNELS = ["email", "portal", "form"] as const;
export type CommentChannel = (typeof COMMENT_CHANNELS)[number];

/**
 * Add to the thread.
 *
 * FIRST RESPONSE is the first PUBLIC TEAM reply — the moment the client heard
 * from a human. An internal note, a status change or an assignment does not
 * stop the SLA clock, because none of them reaches the client.
 *
 * A client writing on a ticket that is waiting on them, or already resolved,
 * moves it back to open: the ball is in the team's court again, and the
 * ledger records ticket.reopened (in the same batch, only from the write
 * that inserted the comment). A closed ticket takes no more client comments;
 * they open a new one.
 *
 * A SUPPLIED `id` makes the call idempotent: when a comment with that id is
 * already on this ticket nothing is written and it is returned with
 * existing:true (the support inbox plans its ids before it writes, so a
 * retried email is filed once). `channel` is written only when given, so a
 * database without migration bravo__200 keeps taking every other comment.
 *
 * ONE TRANSACTION, EACH STEP ON THE ONE BEFORE. The ticket's state is checked
 * in the insert itself, not only in the read above it: a client's comment is
 * inserted only while the ticket is not closed. The ticket is then touched
 * (updated_at) only if THIS call inserted the comment, reopened only if that
 * happened and it is waiting on the client or resolved at that moment, and
 * ticket.reopened / ticket.first_response are recorded only by the write that
 * made that change. So a ticket closed, resolved or answered between the read
 * and the write is never moved by a comment that did not land.
 *
 * A `guard` (an SQL condition and its arguments) is checked in the insert the
 * same way. When it no longer holds, nothing is written and the answer is
 * `superseded`. The support inbox guards a client's email on its claim still
 * holding the plan that chose this ticket.
 */
export async function addTicketComment(
  db: Client,
  tenantId: string,
  ticketId: string,
  input: {
    body: string;
    is_internal: boolean;
    author_type: "client" | "team";
    author: Author;
    id?: string;
    channel?: CommentChannel;
    guard?: { sql: string; args: InValue[] };
  },
  now: Date,
): Promise<CommentResult> {
  requireTenant(tenantId);
  // SELECT * so customer_id is simply absent before migration bravo__188.
  const cur = rows(
    await db.execute({
      sql: "SELECT * FROM support_tickets WHERE tenant_id = ? AND id = ?",
      args: [tenantId, ticketId],
    }),
  )[0];
  if (!cur) return { ok: false, status: 404, error: "not_found" };
  if (input.id) {
    const prior = rows(
      await db.execute({
        sql: "SELECT * FROM ticket_comments WHERE tenant_id = ? AND ticket_id = ? AND id = ? LIMIT 1",
        args: [tenantId, ticketId, input.id],
      }),
    )[0];
    if (prior) return { ok: true, comment: mapComment(prior), firstResponse: false, reopened: false, existing: true };
  }
  const status = String(cur.status) as TicketStatus;
  if (input.author_type === "client" && status === "closed") return { ok: false, status: 409, error: "ticket_closed" };
  const at = now.toISOString();
  const id = input.id ?? randomUUID();
  const isInternal = input.author_type === "client" ? false : input.is_internal;
  const channelCol = input.channel ? ", channel" : "";
  const values: InValue[] = [
    id,
    ticketId,
    tenantId,
    input.author_type,
    input.author.userId,
    input.author.name,
    input.body,
    isInternal ? 1 : 0,
    at,
    ...(input.channel ? [input.channel] : []),
  ];
  const isClient = input.author_type === "client";
  // The insert's own conditions: the ticket is here (and, for a client, not
  // closed) at the moment of the write, and the caller's guard holds.
  const conditions = [
    `EXISTS (SELECT 1 FROM support_tickets WHERE tenant_id = ? AND id = ?${isClient ? " AND status <> 'closed'" : ""})`,
    ...(input.guard ? [input.guard.sql] : []),
  ];
  const stmts: InStatement[] = [
    {
      // ON CONFLICT (id): a concurrent call with the same supplied id inserted
      // first; this one changes nothing, and nothing after it is written.
      sql: `INSERT INTO ticket_comments (id, ticket_id, tenant_id, author_type, author_user_id, author_name, body, is_internal, created_at${channelCol})
            SELECT ${values.map(() => "?").join(", ")} WHERE ${conditions.join(" AND ")}
            ON CONFLICT (id) DO NOTHING`,
      args: [...values, tenantId, ticketId, ...(input.guard ? input.guard.args : [])],
    },
    // Touched only by the call that inserted the comment.
    {
      sql: "UPDATE support_tickets SET updated_at = ? WHERE tenant_id = ? AND id = ? AND changes() = 1",
      args: [at, tenantId, ticketId],
    },
  ];
  let reopenAt = -1;
  let firstResponseAt = -1;
  if (isClient) {
    // A client writing on a ticket waiting on them, or resolved AT THIS
    // MOMENT, reopens it; the reopening is recorded only by that write, keyed
    // by this comment (a count read before the batch could hand two racing
    // reopenings the same key, and the second would be dropped).
    reopenAt =
      stmts.push({
        sql: `UPDATE support_tickets SET status = 'open', resolved_at = NULL, closed_at = NULL
              WHERE tenant_id = ? AND id = ? AND status IN ('waiting_on_client', 'resolved') AND changes() = 1`,
        args: [tenantId, ticketId],
      }) - 1;
    stmts.push(
      ticketEvent(
        "reopened",
        {
          tenantId,
          ticketId,
          customerId: s(cur.customer_id),
          actorUserId: actorId(input.author.userId),
          n: id,
          payload: {},
          conditional: true,
        },
        now,
      ),
    );
  } else if (!isInternal) {
    // Set once: only the public reply that finds it still empty sets it, even
    // if two race, and only that reply records ticket.first_response.
    firstResponseAt =
      stmts.push({
        sql: "UPDATE support_tickets SET first_response_at = ? WHERE tenant_id = ? AND id = ? AND first_response_at IS NULL AND changes() = 1",
        args: [at, tenantId, ticketId],
      }) - 1;
    const opened = Date.parse(String(cur.created_at ?? ""));
    stmts.push(
      ticketEvent(
        "first_response",
        {
          tenantId,
          ticketId,
          customerId: s(cur.customer_id),
          actorUserId: actorId(input.author.userId),
          n: 1,
          payload: Number.isNaN(opened) ? {} : { response_minutes: Math.max(0, Math.round((now.getTime() - opened) / 60_000)) },
          conditional: true,
        },
        now,
      ),
    );
  }
  const results = await db.batch(stmts, "write");
  if (results[0].rowsAffected !== 1) {
    // Nothing written. A concurrent call with this id wrote it first (then it
    // is this comment, already on the ticket); or, since the read above, the
    // ticket closed or went, or the caller's guard stopped holding.
    const written = rows(
      await db.execute({
        sql: "SELECT * FROM ticket_comments WHERE tenant_id = ? AND ticket_id = ? AND id = ? LIMIT 1",
        args: [tenantId, ticketId, id],
      }),
    )[0];
    if (written) return { ok: true, comment: mapComment(written), firstResponse: false, reopened: false, existing: true };
    const ticketNow = rows(
      await db.execute({ sql: "SELECT status FROM support_tickets WHERE tenant_id = ? AND id = ?", args: [tenantId, ticketId] }),
    )[0];
    if (!ticketNow) return { ok: false, status: 404, error: "not_found" };
    if (isClient && String(ticketNow.status) === "closed") return { ok: false, status: 409, error: "ticket_closed" };
    if (input.guard) return { ok: false, status: 409, error: "superseded" };
    throw new Error(`addTicketComment: comment ${id} was not written on ticket ${ticketId} and nothing explains why`);
  }
  const firstResponse = firstResponseAt >= 0 && results[firstResponseAt].rowsAffected === 1;
  const reopened = reopenAt >= 0 && results[reopenAt].rowsAffected === 1;
  return {
    ok: true,
    comment: {
      id,
      ticket_id: ticketId,
      author_type: input.author_type,
      author_user_id: input.author.userId,
      author_name: input.author.name,
      body: input.body,
      is_internal: isInternal,
      email_status: null,
      created_at: at,
      channel: input.channel ?? null,
    },
    firstResponse,
    reopened,
  };
}

/**
 * An internal system line on a ticket's thread, as ONE statement for the
 * caller's own batch: the support inbox's routing note ("sender not
 * verified", "follow-up to T-0042", a bounce). Idempotent on its id, so a
 * retried ingest never writes the line twice. Never client-visible
 * (is_internal 1), never a first response.
 */
export function systemNoteStatement(
  tenantId: string,
  ticketId: string,
  note: { id: string; body: string; at: string },
): InStatement {
  return {
    sql: `INSERT INTO ticket_comments (id, ticket_id, tenant_id, author_type, author_user_id, author_name, body, is_internal, created_at)
          VALUES (?, ?, ?, 'system', NULL, 'Support inbox', ?, 1, ?)
          ON CONFLICT (id) DO NOTHING`,
    args: [note.id, ticketId, requireTenant(tenantId), note.body.slice(0, LIMITS_COMMENT_BODY), note.at],
  };
}

const LIMITS_COMMENT_BODY = 10_000;

export async function setCommentEmailStatus(db: Client, tenantId: string, commentId: string, status: string): Promise<void> {
  await db.execute({
    sql: "UPDATE ticket_comments SET email_status = ? WHERE tenant_id = ? AND id = ?",
    args: [status.slice(0, 300), requireTenant(tenantId), commentId],
  });
}

// ---------------------------------------------------------------------------
// Notification claims (at-most-once) and the SLA sweep
// ---------------------------------------------------------------------------

export type ClaimColumn = "founder_alert_at" | "client_ack_at" | "sla_breach_alert_at";
const STATUS_COLUMN: Record<ClaimColumn, string> = {
  founder_alert_at: "founder_alert_status",
  client_ack_at: "client_ack_status",
  sla_breach_alert_at: "sla_breach_alert_status",
};

/**
 * Claim the right to send one notification for a ticket. Exactly one caller
 * wins (conditional UPDATE); every other caller — a retry, a second cron run,
 * the reconcile sweep — gets false and sends nothing. The claim is written
 * BEFORE sending, so a crash mid-send loses that one message rather than
 * repeating it; the status column then stays empty, which the ticket page
 * shows as "claimed, no outcome recorded".
 */
export async function claimNotification(
  db: Client,
  tenantId: string,
  ticketId: string,
  column: ClaimColumn,
  now: Date,
): Promise<boolean> {
  const rs = await db.execute({
    sql: `UPDATE support_tickets SET ${column} = ? WHERE tenant_id = ? AND id = ? AND ${column} IS NULL`,
    args: [now.toISOString(), requireTenant(tenantId), ticketId],
  });
  return rs.rowsAffected === 1;
}

export async function recordNotification(
  db: Client,
  tenantId: string,
  ticketId: string,
  column: ClaimColumn,
  status: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE support_tickets SET ${STATUS_COLUMN[column]} = ? WHERE tenant_id = ? AND id = ?`,
    args: [status.slice(0, 500), requireTenant(tenantId), ticketId],
  });
}

/**
 * Flag every unanswered, still-open ticket on one desk whose first-response
 * target has passed. Idempotent: an already-flagged ticket is not flagged again.
 */
export async function flagSlaBreaches(db: Client, tenantId: string, now: Date): Promise<string[]> {
  const at = now.toISOString();
  const rs = await db.execute({
    sql: `UPDATE support_tickets SET sla_breached_at = ?, updated_at = ?
          WHERE tenant_id = ? AND first_response_at IS NULL AND sla_breached_at IS NULL
            AND status IN (${OPEN_STATUS_SQL}) AND sla_target < ?
          RETURNING id`,
    args: [at, at, requireTenant(tenantId), at],
  });
  return rows(rs).map((r) => String(r.id));
}

/**
 * Claim the breach alert for every flagged ticket that has not alerted yet and
 * is STILL unanswered and open (a ticket answered or closed between the flag
 * and the alert needs no alert). One statement, so two concurrent cron runs
 * split the tickets between them rather than both alerting on each.
 */
export async function claimBreachAlerts(db: Client, tenantId: string, now: Date, limit = 50): Promise<string[]> {
  requireTenant(tenantId);
  const at = now.toISOString();
  const rs = await db.execute({
    sql: `UPDATE support_tickets SET sla_breach_alert_at = ?
          WHERE tenant_id = ? AND sla_breach_alert_at IS NULL AND id IN (
            SELECT id FROM support_tickets
            WHERE tenant_id = ? AND sla_breached_at IS NOT NULL AND sla_breach_alert_at IS NULL
              AND first_response_at IS NULL AND status IN (${OPEN_STATUS_SQL})
            ORDER BY sla_target, id
            LIMIT ?
          )
          RETURNING id`,
    args: [at, tenantId, tenantId, limit],
  });
  return rows(rs).map((r) => String(r.id));
}

/** Prefix on sla_breach_alert_status while a retry of a FAILED breach alert is sending. */
export const BREACH_ALERT_RETRYING = "retrying; last attempt: ";

/**
 * How long a retry in flight is left alone. Far longer than one pass takes (at
 * most 50 alerts, two sends each) and shorter than the 15 minutes between
 * passes, so the pass after one that died picks its retry up again.
 */
export const BREACH_RETRY_LEASE_MS = 10 * 60_000;

/**
 * Take back the breach alerts whose last send FAILED on a lane, so a mailbox or
 * Telegram outage costs the founders a delay, not the alert. Same conditions as
 * the first claim (still breached, unanswered, open), and only claims from an
 * EARLIER pass, so a pass never retries its own failure.
 *
 * Compare-and-set per ticket on the claim stamp AND the status the candidate
 * query read: of two overlapping passes exactly one wins each ticket. The winner
 * gets the failed status back, so it re-sends only the failed lanes.
 *
 * The winner MARKS the status (BREACH_ALERT_RETRYING + the failed outcome), it
 * does not blank it. The failure stays readable on the ticket while the retry
 * sends, and a pass that dies before recording the outcome (a write error, the
 * Worker killed mid-loop) leaves the FAILED text, and so the retry, in place.
 * A marked retry is skipped for BREACH_RETRY_LEASE_MS so an overlapping pass
 * cannot send it twice; after that it is a pass that died, and is retried.
 */
export async function reclaimFailedBreachAlerts(
  db: Client,
  tenantId: string,
  now: Date,
  limit = 50,
): Promise<Array<{ id: string; previous_status: string }>> {
  requireTenant(tenantId);
  const at = now.toISOString();
  const leaseExpired = new Date(now.getTime() - BREACH_RETRY_LEASE_MS).toISOString();
  const candidates = rows(
    await db.execute({
      sql: `SELECT id, sla_breach_alert_at, sla_breach_alert_status FROM support_tickets
            WHERE tenant_id = ? AND sla_breached_at IS NOT NULL
              AND instr(sla_breach_alert_status, 'FAILED') > 0
              AND sla_breach_alert_at < CASE WHEN substr(sla_breach_alert_status, 1, ?) = ? THEN ? ELSE ? END
              AND first_response_at IS NULL AND status IN (${OPEN_STATUS_SQL})
            ORDER BY sla_target, id
            LIMIT ?`,
      args: [tenantId, BREACH_ALERT_RETRYING.length, BREACH_ALERT_RETRYING, leaseExpired, at, limit],
    }),
  );
  const won: Array<{ id: string; previous_status: string }> = [];
  for (const c of candidates) {
    const read = String(c.sla_breach_alert_status);
    const failed = read.startsWith(BREACH_ALERT_RETRYING) ? read.slice(BREACH_ALERT_RETRYING.length) : read;
    const rs = await db.execute({
      sql: `UPDATE support_tickets SET sla_breach_alert_at = ?, sla_breach_alert_status = ?
            WHERE tenant_id = ? AND id = ? AND sla_breach_alert_at = ? AND sla_breach_alert_status = ?
              AND first_response_at IS NULL AND status IN (${OPEN_STATUS_SQL})`,
      args: [at, BREACH_ALERT_RETRYING + failed, tenantId, String(c.id), String(c.sla_breach_alert_at), read],
    });
    if (rs.rowsAffected === 1) won.push({ id: String(c.id), previous_status: failed });
  }
  return won;
}

/**
 * Tickets whose intake notifications never ran (their after() was torn down):
 * no founder alert claimed, or no client acknowledgement claimed for a ticket
 * that has an address. Email tickets are included: their acknowledgement is
 * decided once, at ingest, and acknowledgeClient re-reads that decision
 * (email-ack.ts), so the retry can only send an ack that was meant to go.
 */
export async function listPendingIntakeNotifications(
  db: Client,
  tenantId: string,
  olderThan: Date,
  limit = 25,
): Promise<string[]> {
  const rs = await db.execute({
    sql: `SELECT id FROM support_tickets
          WHERE tenant_id = ? AND source IN ('form', 'portal', 'email') AND created_at < ?
            AND (founder_alert_at IS NULL OR (client_ack_at IS NULL AND client_email IS NOT NULL))
          ORDER BY created_at, id LIMIT ?`,
    args: [requireTenant(tenantId), olderThan.toISOString(), limit],
  });
  return rows(rs).map((r) => String(r.id));
}

// ---------------------------------------------------------------------------
// Support intake helpers
// ---------------------------------------------------------------------------

export type ClientMatch = {
  client_tenant_id: string | null;
  project_id: string | null;
  client_match: "email_project" | "email_tenant" | "none";
};

/**
 * Who is this submitter? Resolved SERVER-SIDE from their email, and never
 * echoed back to the public form, so the form cannot be used to discover
 * another client's projects.
 *
 *   1. Their email is the client email on exactly one active project -> that
 *      project (and its client workspace). With several projects, the free-text
 *      project hint picks one when it matches exactly one title.
 *   2. Otherwise, their email belongs to portal users of exactly ONE client
 *      workspace -> that workspace, no project. A retired business's
 *      workspace is not a client (lib/os/customers/retired.ts), so its users
 *      are not counted.
 *   3. Otherwise nothing. Ambiguity is never guessed through.
 *
 * The public form's email is UNVERIFIED. client_match records that the link was
 * inferred, so the ticket page can say so.
 *
 * OASIS's desk only: it is the one desk whose rows name client WORKSPACES.
 * Every other desk matches its own projects with matchDeskProjectByEmail.
 */
export async function matchClientByEmail(
  db: Client,
  email: string,
  projectHint: string | null,
): Promise<ClientMatch> {
  const projects = rows(
    await db.execute({
      sql: `SELECT id, title, client_tenant_id FROM delivery_projects
            WHERE tenant_id = ? AND client_email = ? AND archived_at IS NULL
            ORDER BY updated_at DESC, id LIMIT 20`,
      args: [DELIVERY_TENANT_ID, email],
    }),
  );
  let project: Row | undefined;
  if (projects.length === 1) project = projects[0];
  else if (projects.length > 1 && projectHint) {
    const hint = projectHint.trim().toLowerCase();
    const exact = projects.filter((p) => String(p.title).trim().toLowerCase() === hint);
    const partial = projects.filter((p) => String(p.title).toLowerCase().includes(hint) || hint.includes(String(p.title).toLowerCase()));
    project = exact.length === 1 ? exact[0] : partial.length === 1 ? partial[0] : undefined;
  }
  if (project) {
    return { client_tenant_id: s(project.client_tenant_id), project_id: String(project.id), client_match: "email_project" };
  }
  const projectTenants = [...new Set(projects.map((p) => s(p.client_tenant_id)).filter((x): x is string => !!x))];
  if (projects.length > 1 && projectTenants.length === 1) {
    return { client_tenant_id: projectTenants[0], project_id: null, client_match: "email_project" };
  }
  // An OASIS teammate is not a client. CC and Adon also hold profiles in client
  // workspaces they operate, so without this a founder testing the form would
  // file a ticket into that client's portal.
  const teammate = await db.execute({
    sql: "SELECT 1 AS ok FROM user_profiles WHERE lower(email) = ? AND tenant_id = ? LIMIT 1",
    args: [email, DELIVERY_TENANT_ID],
  });
  if (teammate.rows.length > 0) return { client_tenant_id: null, project_id: null, client_match: "none" };
  const live = notRetiredTenantSql("tenant_id");
  const tenants = rows(
    await db.execute({
      sql: `SELECT DISTINCT tenant_id FROM user_profiles
            WHERE lower(email) = ? AND tenant_id IS NOT NULL AND tenant_id <> ? AND ${live.sql}
            LIMIT 3`,
      args: [email, DELIVERY_TENANT_ID, ...live.args],
    }),
  );
  if (tenants.length === 1) {
    return { client_tenant_id: String(tenants[0].tenant_id), project_id: null, client_match: "email_tenant" };
  }
  return { client_tenant_id: null, project_id: null, client_match: "none" };
}

/**
 * A submitter's project on ANY desk other than OASIS's: their email is the
 * client email on exactly one of this desk's active projects (or the hint
 * names one of several). Same rule as step 1 of matchClientByEmail, pinned to
 * the desk's own tenant, and with no client-workspace step: only OASIS's rows
 * name workspaces.
 */
export async function matchDeskProjectByEmail(
  db: Client,
  tenantId: string,
  email: string,
  projectHint: string | null,
): Promise<string | null> {
  const projects = rows(
    await db.execute({
      sql: `SELECT id, title FROM delivery_projects
            WHERE tenant_id = ? AND client_email = ? AND archived_at IS NULL
            ORDER BY updated_at DESC, id LIMIT 20`,
      args: [requireTenant(tenantId), email],
    }),
  );
  if (projects.length === 1) return String(projects[0].id);
  if (projects.length > 1 && projectHint) {
    const hint = projectHint.trim().toLowerCase();
    const exact = projects.filter((p) => String(p.title).trim().toLowerCase() === hint);
    const partial = projects.filter((p) => String(p.title).toLowerCase().includes(hint) || hint.includes(String(p.title).toLowerCase()));
    const one = exact.length === 1 ? exact[0] : partial.length === 1 ? partial[0] : undefined;
    return one ? String(one.id) : null;
  }
  return null;
}

/**
 * Support-form submissions on one desk that have no ticket: the live request
 * crashed after recording the submission. The SLA cron re-drives them through
 * the same idempotent createTicket, keyed on the submission id.
 */
export async function listUnticketedSupportSubmissions(
  db: Client,
  tenantId: string,
  formSlug: string,
  olderThan: Date,
  newerThan: Date,
  limit = 25,
): Promise<Array<{ id: string; lead_id: string; payload: string; submitted_at: string }>> {
  requireTenant(tenantId);
  const rs = await db.execute({
    sql: `SELECT fs.id, fs.lead_id, fs.payload, fs.submitted_at
          FROM form_submissions fs
          JOIN forms f ON f.id = fs.form_id AND f.tenant_id = fs.tenant_id
          LEFT JOIN support_tickets st ON st.tenant_id = fs.tenant_id AND st.form_submission_id = fs.id
          WHERE fs.tenant_id = ? AND f.slug = ? AND st.id IS NULL
            AND fs.submitted_at < ? AND fs.submitted_at > ?
          ORDER BY fs.submitted_at, fs.id
          LIMIT ?`,
    args: [tenantId, formSlug, olderThan.toISOString(), newerThan.toISOString(), limit],
  });
  return rows(rs).map((r) => ({
    id: String(r.id),
    lead_id: String(r.lead_id ?? ""),
    payload: String(r.payload ?? "{}"),
    submitted_at: String(r.submitted_at ?? ""),
  }));
}
