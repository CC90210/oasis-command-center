/**
 * lib/delivery/store.ts — every read and write for Projects + Tickets.
 *
 * Raw SQL on the libSQL client, because these tables exist only in Turso and a
 * query this shape (scoped subqueries, INSERT ... SELECT numbering) is clearer
 * here than through the PostgREST adapter.
 *
 * TWO RULES EVERY FUNCTION FOLLOWS
 *   1. Every statement is pinned to the OASIS workspace (tenant_id), and every
 *      READ takes a DeliveryViewer and builds its WHERE from access.ts. Child
 *      rows (tasks, updates, comments, a project's tickets) are read THROUGH a
 *      join to their scoped parent, so a caller that forgot to check the parent
 *      first still cannot read another client's rows.
 *   2. Nothing is swallowed. A failed statement throws; the route turns it into
 *      a loud 500. An empty list here means the query ran and matched nothing.
 *
 * Writes take already-validated input (lib/delivery/rules.ts) and a clock, so
 * tests drive them against a local libSQL file with a fixed `now`.
 */
import { randomUUID } from "node:crypto";
import type { Client, InStatement, ResultSet } from "@libsql/client";
import { isUniqueViolationError } from "@/lib/api-helpers";
import {
  commentScope,
  rowScope,
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
};

function projectSelect(viewer: DeliveryViewer): { sql: string; args: string[] } {
  // A client's open-ticket count only counts THEIR tickets on the project.
  const clientTickets = viewer.kind === "client" ? " AND s.client_tenant_id = ?" : "";
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
  /** "open" (default) = the working statuses; "closed" = resolved + closed; "all"; or one status. */
  status?: string | null;
  severity?: string | null;
  project_id?: string | null;
  /** An auth user id, or "unassigned". */
  assignee?: string | null;
  q?: string | null;
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
  const scope = rowScope(viewer, "t");
  const where = [scope.sql];
  const args: string[] = [...head.args, ...scope.args];
  const status = filters.status || "open";
  if (status === "open") where.push(`t.status IN (${OPEN_STATUS_SQL})`);
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
  const scope = rowScope(viewer, "t");
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
  const scope = rowScope(viewer, "t");
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

/** Workspaces a project/ticket may belong to: every tenant except OASIS itself. */
export async function listClientTenants(db: Client): Promise<ClientTenant[]> {
  const rs = await db.execute({
    sql: "SELECT id, name, slug FROM tenants WHERE id <> ? ORDER BY name, id LIMIT 500",
    args: [DELIVERY_TENANT_ID],
  });
  return rows(rs).map((r) => ({ id: String(r.id), name: String(r.name ?? r.slug ?? r.id), slug: s(r.slug) }));
}

export async function clientTenantExists(db: Client, tenantId: string): Promise<boolean> {
  if (tenantId === DELIVERY_TENANT_ID) return false;
  const rs = await db.execute({ sql: "SELECT 1 AS ok FROM tenants WHERE id = ? LIMIT 1", args: [tenantId] });
  return rs.rows.length > 0;
}

export async function oasisLeadExists(db: Client, leadId: string): Promise<boolean> {
  const rs = await db.execute({
    sql: "SELECT 1 AS ok FROM tenant_records WHERE tenant_id = ? AND id = ? AND entity_type = 'lead' LIMIT 1",
    args: [DELIVERY_TENANT_ID, leadId],
  });
  return rs.rows.length > 0;
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
};

const STARTED_STAGES: readonly ProjectStage[] = ["building", "review", "live", "maintenance"];
const LAUNCHED_STAGES: readonly ProjectStage[] = ["live", "maintenance"];

function updateStatement(
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
    args: [id, projectId, DELIVERY_TENANT_ID, author.userId, author.name, body, visibility, at],
  };
}

export async function createProject(db: Client, input: NewProject, author: Author, now: Date): Promise<string> {
  const id = randomUUID();
  const at = now.toISOString();
  await db.batch(
    [
      {
        sql: `INSERT INTO delivery_projects
                (id, tenant_id, title, description, client_tenant_id, client_name, client_email, lead_id,
                 stage, priority, assigned_to, due_date, started_at, launched_at, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          DELIVERY_TENANT_ID,
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
        ],
      },
      updateStatement(id, author, `Project created in the ${PROJECT_STAGE_LABELS[input.stage]} stage.`, "internal", at),
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
  "stage",
  "priority",
  "assigned_to",
  "due_date",
] as const;

/** Returns false when the project does not exist in the workspace. */
export async function updateProject(
  db: Client,
  id: string,
  changes: ProjectChanges,
  author: Author,
  now: Date,
): Promise<boolean> {
  const cur = rows(
    await db.execute({
      sql: "SELECT stage, started_at, launched_at, archived_at FROM delivery_projects WHERE tenant_id = ? AND id = ?",
      args: [DELIVERY_TENANT_ID, id],
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
      updateStatement(id, author, `Stage moved from ${fromLabel} to ${PROJECT_STAGE_LABELS[changes.stage]}.`, "internal", at),
    );
  }
  if (changes.archived !== undefined && changes.archived !== Boolean(cur.archived_at)) {
    sets.push("archived_at = ?");
    args.push(changes.archived ? at : null);
    timeline.push(updateStatement(id, author, changes.archived ? "Project archived." : "Project restored from the archive.", "internal", at));
  }
  if (sets.length === 0) return true;
  sets.push("updated_at = ?");
  args.push(at);
  await db.batch(
    [
      {
        sql: `UPDATE delivery_projects SET ${sets.join(", ")} WHERE tenant_id = ? AND id = ?`,
        args: [...args, DELIVERY_TENANT_ID, id],
      },
      ...timeline,
    ],
    "write",
  );
  return true;
}

export async function addProjectUpdate(
  db: Client,
  projectId: string,
  input: { body: string; visibility: UpdateVisibility },
  author: Author,
  now: Date,
): Promise<string | null> {
  if (!(await projectExists(db, projectId))) return null;
  const at = now.toISOString();
  const id = randomUUID();
  await db.batch(
    [
      updateStatement(projectId, author, input.body, input.visibility, at, id),
      { sql: "UPDATE delivery_projects SET updated_at = ? WHERE tenant_id = ? AND id = ?", args: [at, DELIVERY_TENANT_ID, projectId] },
    ],
    "write",
  );
  return id;
}

export async function projectExists(db: Client, projectId: string): Promise<boolean> {
  const rs = await db.execute({
    sql: "SELECT 1 AS ok FROM delivery_projects WHERE tenant_id = ? AND id = ? LIMIT 1",
    args: [DELIVERY_TENANT_ID, projectId],
  });
  return rs.rows.length > 0;
}

export async function createTask(
  db: Client,
  projectId: string,
  input: { title: string; notes: string | null; due_date: string | null; assigned_to: string | null },
  now: Date,
): Promise<string | null> {
  if (!(await projectExists(db, projectId))) return null;
  const id = randomUUID();
  const at = now.toISOString();
  await db.batch(
    [
      {
        sql: `INSERT INTO delivery_tasks (id, project_id, tenant_id, title, status, assigned_to, notes, due_date, sort_order, created_at, updated_at)
              SELECT ?, ?, ?, ?, 'todo', ?, ?, ?, COALESCE(MAX(sort_order), 0) + 1, ?, ?
              FROM delivery_tasks WHERE tenant_id = ? AND project_id = ?`,
        args: [id, projectId, DELIVERY_TENANT_ID, input.title, input.assigned_to, input.notes, input.due_date, at, at, DELIVERY_TENANT_ID, projectId],
      },
      { sql: "UPDATE delivery_projects SET updated_at = ? WHERE tenant_id = ? AND id = ?", args: [at, DELIVERY_TENANT_ID, projectId] },
    ],
    "write",
  );
  return id;
}

/** Returns false when the task does not exist on that project in the workspace. */
export async function updateTask(
  db: Client,
  projectId: string,
  taskId: string,
  changes: Partial<{ title: string; notes: string | null; due_date: string | null; status: TaskStatus; sort_order: number; assigned_to: string | null }>,
  now: Date,
): Promise<boolean> {
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
        args: [...args, DELIVERY_TENANT_ID, projectId, taskId],
      },
      { sql: "UPDATE delivery_projects SET updated_at = ? WHERE tenant_id = ? AND id = ?", args: [at, DELIVERY_TENANT_ID, projectId] },
    ],
    "write",
  );
  return results[0].rowsAffected === 1;
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
};

async function findTicketIdBySubmission(db: Client, submissionId: string): Promise<string | null> {
  const rs = await db.execute({
    sql: "SELECT id FROM support_tickets WHERE tenant_id = ? AND form_submission_id = ? LIMIT 1",
    args: [DELIVERY_TENANT_ID, submissionId],
  });
  return rs.rows.length ? String(rows(rs)[0].id) : null;
}

const FOUNDER_READ: DeliveryViewer = { kind: "founder", userId: "system", canAct: false };

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
 */
export async function createTicket(
  db: Client,
  input: NewTicket,
  now: Date,
): Promise<{ ticket: Ticket; created: boolean }> {
  if (input.form_submission_id) {
    const existing = await findTicketIdBySubmission(db, input.form_submission_id);
    if (existing) return { ticket: (await getTicket(db, FOUNDER_READ, existing))!, created: false };
  }
  const id = input.id ?? randomUUID();
  const at = now.toISOString();
  const slaTarget = slaTargetFor(at, input.severity);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await db.execute({
        sql: `INSERT INTO support_tickets
                (id, tenant_id, ticket_seq, ticket_number, title, description, category, severity, status, source,
                 project_id, client_tenant_id, client_name, client_email, client_company, client_match, project_hint,
                 reporter_user_id, assigned_to, attachments, form_submission_id, sla_target, created_at, updated_at)
              SELECT ?, ?, n.seq, 'T-' || printf('%04d', n.seq), ?, ?, ?, ?, 'open', ?,
                     ?, ?, ?, ?, ?, ?, ?,
                     ?, ?, ?, ?, ?, ?, ?
              FROM (SELECT COALESCE(MAX(ticket_seq), 0) + 1 AS seq FROM support_tickets WHERE tenant_id = ?) AS n`,
        args: [
          id,
          DELIVERY_TENANT_ID,
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
          DELIVERY_TENANT_ID,
        ],
      });
      return { ticket: (await getTicket(db, FOUNDER_READ, id))!, created: true };
    } catch (err) {
      const e = err as { message?: string; code?: string };
      if (!isUniqueViolationError(e)) throw err;
      if (input.form_submission_id) {
        const existing = await findTicketIdBySubmission(db, input.form_submission_id);
        if (existing) return { ticket: (await getTicket(db, FOUNDER_READ, existing))!, created: false };
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
}>;

export type TicketUpdateResult =
  | { ok: true; changed: string[] }
  | { ok: false; status: 404 | 409; error: "not_found" | "invalid_transition" | "project_belongs_to_another_client" | "project_not_found" };

/**
 * Apply a founder's edit. Status moves are checked against TICKET_TRANSITIONS;
 * a severity change on an unanswered ticket re-targets its SLA; linking a
 * project refuses a project that belongs to a different client, and a ticket
 * with no client inherits the project's (the founder just said whose it is).
 * Every change leaves an internal system line in the thread.
 */
export async function updateTicket(
  db: Client,
  id: string,
  changes: TicketChanges,
  author: Author,
  now: Date,
  names: { assignee?: (id: string | null) => string | null } = {},
): Promise<TicketUpdateResult> {
  const cur = rows(
    await db.execute({
      sql: "SELECT * FROM support_tickets WHERE tenant_id = ? AND id = ?",
      args: [DELIVERY_TENANT_ID, id],
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
          args: [DELIVERY_TENANT_ID, changes.project_id],
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
        args: [DELIVERY_TENANT_ID, String(cur.project_id)],
      }),
    )[0];
    const projectClient = s(p?.client_tenant_id);
    if (projectClient && projectClient !== clientTenant) {
      return { ok: false, status: 409, error: "project_belongs_to_another_client" };
    }
  }

  if ("assigned_to" in changes && (changes.assigned_to ?? null) !== s(cur.assigned_to)) {
    set("assigned_to", changes.assigned_to ?? null);
    const who = names.assignee?.(changes.assigned_to ?? null);
    notes.push(changes.assigned_to ? `Assigned to ${who ?? "a teammate"}.` : "Unassigned.");
  }

  if (sets.length === 0) return { ok: true, changed: [] };
  set("updated_at", at);
  const stmts: InStatement[] = [
    { sql: `UPDATE support_tickets SET ${sets.join(", ")} WHERE tenant_id = ? AND id = ?`, args: [...args, DELIVERY_TENANT_ID, id] },
  ];
  if (notes.length) {
    stmts.push({
      sql: `INSERT INTO ticket_comments (id, ticket_id, tenant_id, author_type, author_user_id, author_name, body, is_internal, created_at)
            VALUES (?, ?, ?, 'system', ?, ?, ?, 1, ?)`,
      args: [randomUUID(), id, DELIVERY_TENANT_ID, author.userId, author.name, notes.join(" "), at],
    });
  }
  await db.batch(stmts, "write");
  return { ok: true, changed: sets.map((x) => x.split(" = ")[0]).filter((c) => c !== "updated_at") };
}

export type CommentResult =
  | { ok: true; comment: TicketComment; firstResponse: boolean; reopened: boolean }
  | { ok: false; status: 404 | 409; error: "not_found" | "ticket_closed" };

/**
 * Add to the thread.
 *
 * FIRST RESPONSE is the first PUBLIC TEAM reply — the moment the client heard
 * from a human. An internal note, a status change or an assignment does not
 * stop the SLA clock, because none of them reaches the client.
 *
 * A client writing on a ticket that is waiting on them, or already resolved,
 * moves it back to open: the ball is in the team's court again. A closed
 * ticket takes no more client comments; they open a new one.
 */
export async function addTicketComment(
  db: Client,
  ticketId: string,
  input: { body: string; is_internal: boolean; author_type: "client" | "team"; author: Author },
  now: Date,
): Promise<CommentResult> {
  const cur = rows(
    await db.execute({
      sql: "SELECT status, first_response_at FROM support_tickets WHERE tenant_id = ? AND id = ?",
      args: [DELIVERY_TENANT_ID, ticketId],
    }),
  )[0];
  if (!cur) return { ok: false, status: 404, error: "not_found" };
  const status = String(cur.status) as TicketStatus;
  if (input.author_type === "client" && status === "closed") return { ok: false, status: 409, error: "ticket_closed" };
  const at = now.toISOString();
  const id = randomUUID();
  const isInternal = input.author_type === "client" ? false : input.is_internal;
  const stmts: InStatement[] = [
    {
      sql: `INSERT INTO ticket_comments (id, ticket_id, tenant_id, author_type, author_user_id, author_name, body, is_internal, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, ticketId, DELIVERY_TENANT_ID, input.author_type, input.author.userId, input.author.name, input.body, isInternal ? 1 : 0, at],
    },
  ];
  const firstResponse = input.author_type === "team" && !isInternal && !cur.first_response_at;
  const reopened = input.author_type === "client" && (status === "waiting_on_client" || status === "resolved");
  const sets = ["updated_at = ?"];
  const args: Array<string | null> = [at];
  if (firstResponse) {
    // COALESCE: set once, even if two public replies race.
    sets.push("first_response_at = COALESCE(first_response_at, ?)");
    args.push(at);
  }
  if (reopened) {
    sets.push("status = 'open'", "resolved_at = NULL", "closed_at = NULL");
  }
  stmts.push({
    sql: `UPDATE support_tickets SET ${sets.join(", ")} WHERE tenant_id = ? AND id = ?`,
    args: [...args, DELIVERY_TENANT_ID, ticketId],
  });
  await db.batch(stmts, "write");
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
    },
    firstResponse,
    reopened,
  };
}

export async function setCommentEmailStatus(db: Client, commentId: string, status: string): Promise<void> {
  await db.execute({
    sql: "UPDATE ticket_comments SET email_status = ? WHERE tenant_id = ? AND id = ?",
    args: [status.slice(0, 300), DELIVERY_TENANT_ID, commentId],
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
export async function claimNotification(db: Client, ticketId: string, column: ClaimColumn, now: Date): Promise<boolean> {
  const rs = await db.execute({
    sql: `UPDATE support_tickets SET ${column} = ? WHERE tenant_id = ? AND id = ? AND ${column} IS NULL`,
    args: [now.toISOString(), DELIVERY_TENANT_ID, ticketId],
  });
  return rs.rowsAffected === 1;
}

export async function recordNotification(db: Client, ticketId: string, column: ClaimColumn, status: string): Promise<void> {
  await db.execute({
    sql: `UPDATE support_tickets SET ${STATUS_COLUMN[column]} = ? WHERE tenant_id = ? AND id = ?`,
    args: [status.slice(0, 500), DELIVERY_TENANT_ID, ticketId],
  });
}

/**
 * Flag every unanswered, still-open ticket whose first-response target has
 * passed. Idempotent: an already-flagged ticket is not flagged again.
 */
export async function flagSlaBreaches(db: Client, now: Date): Promise<string[]> {
  const at = now.toISOString();
  const rs = await db.execute({
    sql: `UPDATE support_tickets SET sla_breached_at = ?, updated_at = ?
          WHERE tenant_id = ? AND first_response_at IS NULL AND sla_breached_at IS NULL
            AND status IN (${OPEN_STATUS_SQL}) AND sla_target < ?
          RETURNING id`,
    args: [at, at, DELIVERY_TENANT_ID, at],
  });
  return rows(rs).map((r) => String(r.id));
}

/**
 * Claim the breach alert for every flagged ticket that has not alerted yet and
 * is STILL unanswered and open (a ticket answered or closed between the flag
 * and the alert needs no alert). One statement, so two concurrent cron runs
 * split the tickets between them rather than both alerting on each.
 */
export async function claimBreachAlerts(db: Client, now: Date, limit = 50): Promise<string[]> {
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
    args: [at, DELIVERY_TENANT_ID, DELIVERY_TENANT_ID, limit],
  });
  return rows(rs).map((r) => String(r.id));
}

/** Tickets that claimed a founder alert or client ack but never recorded it being sent. */
export async function listPendingIntakeNotifications(db: Client, olderThan: Date, limit = 25): Promise<string[]> {
  const rs = await db.execute({
    sql: `SELECT id FROM support_tickets
          WHERE tenant_id = ? AND source IN ('form', 'portal') AND created_at < ?
            AND (founder_alert_at IS NULL OR (client_ack_at IS NULL AND client_email IS NOT NULL))
          ORDER BY created_at, id LIMIT ?`,
    args: [DELIVERY_TENANT_ID, olderThan.toISOString(), limit],
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
 *      workspace -> that workspace, no project.
 *   3. Otherwise nothing. Ambiguity is never guessed through.
 *
 * The public form's email is UNVERIFIED. client_match records that the link was
 * inferred, so the ticket page can say so.
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
  const tenants = rows(
    await db.execute({
      sql: `SELECT DISTINCT tenant_id FROM user_profiles
            WHERE lower(email) = ? AND tenant_id IS NOT NULL AND tenant_id <> ?
            LIMIT 3`,
      args: [email, DELIVERY_TENANT_ID],
    }),
  );
  if (tenants.length === 1) {
    return { client_tenant_id: String(tenants[0].tenant_id), project_id: null, client_match: "email_tenant" };
  }
  return { client_tenant_id: null, project_id: null, client_match: "none" };
}

/**
 * Support-form submissions that have no ticket: the live request crashed after
 * recording the submission. The SLA cron re-drives them through the same
 * idempotent createTicket, keyed on the submission id.
 */
export async function listUnticketedSupportSubmissions(
  db: Client,
  formSlug: string,
  olderThan: Date,
  newerThan: Date,
  limit = 25,
): Promise<Array<{ id: string; lead_id: string; payload: string; submitted_at: string }>> {
  const rs = await db.execute({
    sql: `SELECT fs.id, fs.lead_id, fs.payload, fs.submitted_at
          FROM form_submissions fs
          JOIN forms f ON f.id = fs.form_id AND f.tenant_id = fs.tenant_id
          LEFT JOIN support_tickets st ON st.tenant_id = fs.tenant_id AND st.form_submission_id = fs.id
          WHERE fs.tenant_id = ? AND f.slug = ? AND st.id IS NULL
            AND fs.submitted_at < ? AND fs.submitted_at > ?
          ORDER BY fs.submitted_at, fs.id
          LIMIT ?`,
    args: [DELIVERY_TENANT_ID, formSlug, olderThan.toISOString(), newerThan.toISOString(), limit],
  });
  return rows(rs).map((r) => ({
    id: String(r.id),
    lead_id: String(r.lead_id ?? ""),
    payload: String(r.payload ?? "{}"),
    submitted_at: String(r.submitted_at ?? ""),
  }));
}
