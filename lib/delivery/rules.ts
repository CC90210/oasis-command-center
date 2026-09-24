/**
 * lib/delivery/rules.ts — every rule the Projects + Tickets modules follow.
 *
 * PURE: no database, no session, no env, no next/* import. The API routes, the
 * pages, the support-form intake and the SLA cron all ask THIS module what a
 * valid stage is, when a ticket breaches, what a ticket number looks like and
 * what a client may see — so tests/delivery-rules.test.ts can pin all of it in a
 * bare node process.
 *
 * The allowed values here are the only copy. Migration 183 deliberately has no
 * CHECK constraints on these columns (see its header), so a value that is not
 * in these lists must never reach an INSERT: every write goes through a
 * validate* function below first.
 */
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/tenant";

/** Every delivery/support row belongs to the OASIS workspace (slug oasis-ai-cc). */
export const DELIVERY_TENANT_ID = WEBDEV_TENANT_ID;

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const PROJECT_STAGES = ["discovery", "building", "review", "live", "maintenance", "paused"] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];
export const PROJECT_STAGE_LABELS: Record<ProjectStage, string> = {
  discovery: "Discovery",
  building: "Building",
  review: "Client review",
  live: "Live",
  maintenance: "Maintenance",
  paused: "Paused",
};
/** Work in flight: counted as "active" on the board. */
export const ACTIVE_PROJECT_STAGES: readonly ProjectStage[] = ["discovery", "building", "review"];

export const PROJECT_PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export type ProjectPriority = (typeof PROJECT_PRIORITIES)[number];

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

export const UPDATE_VISIBILITIES = ["internal", "client"] as const;
export type UpdateVisibility = (typeof UPDATE_VISIBILITIES)[number];

export const TICKET_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type TicketSeverity = (typeof TICKET_SEVERITIES)[number];
export const TICKET_SEVERITY_LABELS: Record<TicketSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const TICKET_CATEGORIES = ["bug", "change_request", "question", "billing", "other"] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export const TICKET_CATEGORY_LABELS: Record<TicketCategory, string> = {
  bug: "Bug",
  change_request: "Change request",
  question: "Question",
  billing: "Billing",
  other: "Other",
};

export const TICKET_SOURCES = ["form", "portal", "internal"] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

export const TICKET_STATUSES = ["open", "in_progress", "waiting_on_client", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting_on_client: "Waiting on client",
  resolved: "Resolved",
  closed: "Closed",
};
/** Statuses that still need the team. The SLA cron and "open" counts use these. */
export const OPEN_TICKET_STATUSES: readonly TicketStatus[] = ["open", "in_progress", "waiting_on_client"];

export function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Ticket status transitions
// ---------------------------------------------------------------------------

/**
 * Which status may follow which. A closed ticket can only be reopened; every
 * other move is allowed between the working states. A same-status "move" is
 * not a transition and is refused so a PATCH cannot rewrite timestamps.
 */
export const TICKET_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  open: ["in_progress", "waiting_on_client", "resolved", "closed"],
  in_progress: ["open", "waiting_on_client", "resolved", "closed"],
  waiting_on_client: ["open", "in_progress", "resolved", "closed"],
  resolved: ["open", "in_progress", "closed"],
  closed: ["open"],
};

export function canTransitionTicket(from: TicketStatus, to: TicketStatus): boolean {
  return from !== to && TICKET_TRANSITIONS[from].includes(to);
}

/**
 * Timestamp side effects of a status move. Resolving stamps resolved_at;
 * closing stamps closed_at (and resolved_at if the ticket skipped resolved);
 * moving back to a working state clears both, because a reopened ticket is not
 * resolved and must not keep reporting that it was.
 */
export function statusTimestampsFor(
  to: TicketStatus,
  current: { resolved_at: string | null },
  nowIso: string,
): { resolved_at: string | null; closed_at: string | null } {
  if (to === "resolved") return { resolved_at: nowIso, closed_at: null };
  if (to === "closed") return { resolved_at: current.resolved_at ?? nowIso, closed_at: nowIso };
  return { resolved_at: null, closed_at: null };
}

// ---------------------------------------------------------------------------
// SLA — first response
// ---------------------------------------------------------------------------

/** First-response targets in minutes. Critical 1h, high 4h, medium 24h, low 72h. */
export const SLA_FIRST_RESPONSE_MINUTES: Record<TicketSeverity, number> = {
  critical: 60,
  high: 240,
  medium: 1440,
  low: 4320,
};

/** Human wording of the target, for the client confirmation email. */
export function slaTargetPhrase(severity: TicketSeverity): string {
  const m = SLA_FIRST_RESPONSE_MINUTES[severity];
  if (m % 60 !== 0) return `${m} minutes`;
  const h = m / 60;
  return `${h} hour${h === 1 ? "" : "s"}`;
}

/** The first-response due time for a ticket created at `createdAtIso`. */
export function slaTargetFor(createdAtIso: string, severity: TicketSeverity): string {
  const created = Date.parse(createdAtIso);
  if (!Number.isFinite(created)) throw new Error(`slaTargetFor: invalid createdAt ${createdAtIso}`);
  return new Date(created + SLA_FIRST_RESPONSE_MINUTES[severity] * 60_000).toISOString();
}

export type SlaState =
  /** A public team reply landed on time. */
  | "responded"
  /** A public team reply landed, after the target. */
  | "responded_late"
  /** Resolved/closed without a public reply: the clock no longer applies. */
  | "closed"
  /** Unanswered and past the target. */
  | "breached"
  /** Unanswered, inside the last quarter of the window. */
  | "at_risk"
  | "on_track";

export type SlaView = { state: SlaState; minutesRemaining: number | null };

/** Fraction of the window left at which a ticket counts as at risk. */
export const SLA_AT_RISK_FRACTION = 0.25;

export function slaStatus(
  t: {
    sla_target: string;
    first_response_at: string | null;
    status: string;
    severity: string;
    created_at?: string | null;
  },
  now: Date,
): SlaView {
  const target = Date.parse(t.sla_target);
  if (t.first_response_at) {
    const responded = Date.parse(t.first_response_at);
    return { state: responded <= target ? "responded" : "responded_late", minutesRemaining: null };
  }
  if (t.status === "resolved" || t.status === "closed") return { state: "closed", minutesRemaining: null };
  const remainingMs = target - now.getTime();
  const minutesRemaining = Math.floor(remainingMs / 60_000);
  if (remainingMs < 0) return { state: "breached", minutesRemaining };
  const severity = isOneOf(TICKET_SEVERITIES, t.severity) ? t.severity : "medium";
  const created = t.created_at ? Date.parse(t.created_at) : NaN;
  const windowMs = Number.isFinite(created) && target > created
    ? target - created
    : SLA_FIRST_RESPONSE_MINUTES[severity] * 60_000;
  if (remainingMs <= windowMs * SLA_AT_RISK_FRACTION) return { state: "at_risk", minutesRemaining };
  return { state: "on_track", minutesRemaining };
}

/**
 * Severity changed on a ticket nobody has answered yet: the target follows the
 * new severity, measured from creation. If that moves the target back into the
 * future, the earlier breach no longer stands, so its flag AND its alert claim
 * are cleared — a later breach under the new target is a new breach and must
 * alert again. Returns null when the ticket was already answered (the SLA is
 * settled and must not be rewritten after the fact).
 */
export function retargetForSeverity(
  t: { created_at: string; first_response_at: string | null },
  severity: TicketSeverity,
  now: Date,
): { sla_target: string; clearBreach: boolean } | null {
  if (t.first_response_at) return null;
  const sla_target = slaTargetFor(t.created_at, severity);
  return { sla_target, clearBreach: Date.parse(sla_target) > now.getTime() };
}

/** "3h 20m", "45m", "2d 4h" — for the SLA clock. */
export function formatDuration(minutes: number): string {
  const m = Math.abs(Math.trunc(minutes));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return `${d}d${h ? ` ${h}h` : ""}`;
}

// ---------------------------------------------------------------------------
// Ticket numbers
// ---------------------------------------------------------------------------

/**
 * T-0001. The store allocates the sequence inside its INSERT with
 * `'T-' || printf('%04d', seq)`; this is the TypeScript twin, and the test pins
 * that the two agree (including past T-9999, where the width simply grows).
 */
export function formatTicketNumber(seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) throw new Error(`formatTicketNumber: invalid sequence ${seq}`);
  return `T-${String(seq).padStart(4, "0")}`;
}

export function parseTicketNumber(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^T-(\d{4,})$/i.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export type RosterMember = {
  auth_user_id: string | null;
  email?: string | null;
  full_name?: string | null;
  display_name?: string | null;
  deactivated_at?: string | null;
};

/**
 * Is `raw` a person this work may be assigned to?
 *
 * The roster is lib/team.ts getOasisPipelineAssignmentRoster (founders + active
 * reps). It already drops deactivated teammates; this checks `deactivated_at`
 * again anyway, so a caller that ever passes a history roster
 * (includeInactive) still cannot hand work to someone who has left.
 *
 * null / "" means unassign and is always allowed. Anything else must match an
 * ACTIVE roster member's auth user id exactly (trimmed, lowercased).
 */
export function validateAssignee(
  raw: unknown,
  roster: readonly RosterMember[],
): { ok: true; value: string | null } | { ok: false; error: "assignee_invalid" | "assignee_not_on_roster" } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "assignee_invalid" };
  const id = raw.trim().toLowerCase();
  if (!id) return { ok: true, value: null };
  const member = roster.find((m) => (m.auth_user_id || "").trim().toLowerCase() === id);
  if (!member || member.deactivated_at) return { ok: false, error: "assignee_not_on_roster" };
  return { ok: true, value: id };
}

/** A person's name for display. Unknown ids (a former teammate) say so. */
export function memberDisplayName(
  id: string | null | undefined,
  members: readonly RosterMember[],
): string | null {
  if (!id) return null;
  const key = id.trim().toLowerCase();
  const m = members.find((x) => (x.auth_user_id || "").trim().toLowerCase() === key);
  if (!m) return "Former teammate";
  return (m.display_name || m.full_name || m.email || "Teammate").trim();
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

export type Invalid = { ok: false; error: string; field?: string };
export type Valid<T> = { ok: true; value: T };
export type Validation<T> = Valid<T> | Invalid;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const LIMITS = {
  title: 200,
  description: 10_000,
  clientName: 160,
  clientEmail: 254,
  company: 160,
  commentBody: 10_000,
  updateBody: 5_000,
  taskTitle: 200,
  taskNotes: 5_000,
  resolution: 5_000,
  id: 64,
} as const;

function invalid(error: string, field?: string): Invalid {
  return field ? { ok: false, error, field } : { ok: false, error };
}

/** Trimmed string within `max`, or an error. `required` rejects blank. */
function text(
  body: Record<string, unknown>,
  key: string,
  max: number,
  required: boolean,
): Validation<string | null> {
  const v = body[key];
  if (v === undefined || v === null) {
    return required ? invalid(`${key}_required`, key) : { ok: true, value: null };
  }
  if (typeof v !== "string") return invalid(`${key}_invalid`, key);
  const t = v.trim();
  if (!t) return required ? invalid(`${key}_required`, key) : { ok: true, value: null };
  if (t.length > max) return invalid(`${key}_too_long`, key);
  return { ok: true, value: t };
}

export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return t && t.length <= LIMITS.clientEmail && EMAIL_RE.test(t) ? t : null;
}

function email(body: Record<string, unknown>, key: string, required: boolean): Validation<string | null> {
  const v = body[key];
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
    return required ? invalid(`${key}_required`, key) : { ok: true, value: null };
  }
  const n = normalizeEmail(v);
  return n ? { ok: true, value: n } : invalid(`${key}_invalid`, key);
}

/** YYYY-MM-DD that is a real calendar date. */
export function isCalendarDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

function date(body: Record<string, unknown>, key: string): Validation<string | null> {
  const v = body[key];
  if (v === undefined || v === null || v === "") return { ok: true, value: null };
  return isCalendarDate(v) ? { ok: true, value: v } : invalid(`${key}_invalid`, key);
}

function id(body: Record<string, unknown>, key: string): Validation<string | null> {
  const v = body[key];
  if (v === undefined || v === null || v === "") return { ok: true, value: null };
  if (typeof v !== "string" || !v.trim() || v.trim().length > LIMITS.id || !/^[A-Za-z0-9-]+$/.test(v.trim())) {
    return invalid(`${key}_invalid`, key);
  }
  return { ok: true, value: v.trim() };
}

function enumOf<T extends string>(
  body: Record<string, unknown>,
  key: string,
  list: readonly T[],
  fallback: T | null,
): Validation<T | null> {
  const v = body[key];
  if (v === undefined || v === null || v === "") return { ok: true, value: fallback };
  return isOneOf(list, v) ? { ok: true, value: v } : invalid(`${key}_invalid`, key);
}

function asRecord(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/** Run field validators in order; the first failure wins. */
function collect<T>(entries: Array<[keyof T & string, Validation<unknown>]>): Validation<T> {
  const out: Record<string, unknown> = {};
  for (const [key, r] of entries) {
    if (!r.ok) return r;
    out[key] = r.value;
  }
  return { ok: true, value: out as T };
}

export type ProjectCreateInput = {
  title: string;
  description: string | null;
  client_tenant_id: string | null;
  client_name: string | null;
  client_email: string | null;
  lead_id: string | null;
  stage: ProjectStage;
  priority: ProjectPriority;
  assigned_to: unknown;
  due_date: string | null;
};

export function validateProjectCreate(raw: unknown): Validation<ProjectCreateInput> {
  const b = asRecord(raw);
  if (!b) return invalid("body_invalid");
  const r = collect<Omit<ProjectCreateInput, "assigned_to">>([
    ["title", text(b, "title", LIMITS.title, true)],
    ["description", text(b, "description", LIMITS.description, false)],
    ["client_tenant_id", id(b, "client_tenant_id")],
    ["client_name", text(b, "client_name", LIMITS.clientName, false)],
    ["client_email", email(b, "client_email", false)],
    ["lead_id", id(b, "lead_id")],
    ["stage", enumOf(b, "stage", PROJECT_STAGES, "discovery")],
    ["priority", enumOf(b, "priority", PROJECT_PRIORITIES, "medium")],
    ["due_date", date(b, "due_date")],
  ]);
  if (!r.ok) return r;
  // assigned_to is validated against the live roster by the caller.
  return { ok: true, value: { ...r.value, assigned_to: b.assigned_to } };
}

export type ProjectPatch = Partial<{
  title: string;
  description: string | null;
  client_tenant_id: string | null;
  client_name: string | null;
  client_email: string | null;
  lead_id: string | null;
  stage: ProjectStage;
  priority: ProjectPriority;
  assigned_to: unknown;
  due_date: string | null;
  archived: boolean;
}>;

/** Only the keys present are validated and returned; at least one is required. */
export function validateProjectPatch(raw: unknown): Validation<ProjectPatch> {
  const b = asRecord(raw);
  if (!b) return invalid("body_invalid");
  const out: ProjectPatch = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  const steps: Array<[string, () => Validation<unknown>]> = [
    ["title", () => text(b, "title", LIMITS.title, true)],
    ["description", () => text(b, "description", LIMITS.description, false)],
    ["client_tenant_id", () => id(b, "client_tenant_id")],
    ["client_name", () => text(b, "client_name", LIMITS.clientName, false)],
    ["client_email", () => email(b, "client_email", false)],
    ["lead_id", () => id(b, "lead_id")],
    ["stage", () => (b.stage === null || b.stage === "" ? invalid("stage_invalid", "stage") : enumOf(b, "stage", PROJECT_STAGES, null))],
    ["priority", () => (b.priority === null || b.priority === "" ? invalid("priority_invalid", "priority") : enumOf(b, "priority", PROJECT_PRIORITIES, null))],
    ["due_date", () => date(b, "due_date")],
    ["archived", () => (typeof b.archived === "boolean" ? { ok: true, value: b.archived } : invalid("archived_invalid", "archived"))],
  ];
  for (const [key, run] of steps) {
    if (!has(key)) continue;
    const r = run();
    if (!r.ok) return r;
    (out as Record<string, unknown>)[key] = r.value;
  }
  if (has("assigned_to")) out.assigned_to = b.assigned_to;
  if (Object.keys(out).length === 0) return invalid("no_changes");
  return { ok: true, value: out };
}

export type TaskCreateInput = {
  title: string;
  notes: string | null;
  due_date: string | null;
  assigned_to: unknown;
};

export function validateTaskCreate(raw: unknown): Validation<TaskCreateInput> {
  const b = asRecord(raw);
  if (!b) return invalid("body_invalid");
  const r = collect<Omit<TaskCreateInput, "assigned_to">>([
    ["title", text(b, "title", LIMITS.taskTitle, true)],
    ["notes", text(b, "notes", LIMITS.taskNotes, false)],
    ["due_date", date(b, "due_date")],
  ]);
  if (!r.ok) return r;
  return { ok: true, value: { ...r.value, assigned_to: b.assigned_to } };
}

export type TaskPatch = Partial<{
  title: string;
  notes: string | null;
  due_date: string | null;
  status: TaskStatus;
  sort_order: number;
  assigned_to: unknown;
}>;

export function validateTaskPatch(raw: unknown): Validation<TaskPatch> {
  const b = asRecord(raw);
  if (!b) return invalid("body_invalid");
  const out: TaskPatch = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  if (has("title")) {
    const r = text(b, "title", LIMITS.taskTitle, true);
    if (!r.ok) return r;
    out.title = r.value as string;
  }
  if (has("notes")) {
    const r = text(b, "notes", LIMITS.taskNotes, false);
    if (!r.ok) return r;
    out.notes = r.value;
  }
  if (has("due_date")) {
    const r = date(b, "due_date");
    if (!r.ok) return r;
    out.due_date = r.value;
  }
  if (has("status")) {
    if (!isOneOf(TASK_STATUSES, b.status)) return invalid("status_invalid", "status");
    out.status = b.status;
  }
  if (has("sort_order")) {
    if (typeof b.sort_order !== "number" || !Number.isInteger(b.sort_order) || Math.abs(b.sort_order) > 1_000_000) {
      return invalid("sort_order_invalid", "sort_order");
    }
    out.sort_order = b.sort_order;
  }
  if (has("assigned_to")) out.assigned_to = b.assigned_to;
  if (Object.keys(out).length === 0) return invalid("no_changes");
  return { ok: true, value: out };
}

export function validateUpdateCreate(raw: unknown): Validation<{ body: string; visibility: UpdateVisibility }> {
  const b = asRecord(raw);
  if (!b) return invalid("body_invalid");
  const body = text(b, "body", LIMITS.updateBody, true);
  if (!body.ok) return body;
  // No default to "client": sharing with the client must be a deliberate choice.
  const vis = enumOf(b, "visibility", UPDATE_VISIBILITIES, "internal");
  if (!vis.ok) return vis;
  return { ok: true, value: { body: body.value as string, visibility: vis.value as UpdateVisibility } };
}

export type TicketCreateInput = {
  title: string;
  description: string | null;
  category: TicketCategory;
  severity: TicketSeverity;
  project_id: string | null;
  client_tenant_id: string | null;
  client_name: string | null;
  client_email: string | null;
  client_company: string | null;
  assigned_to: unknown;
};

/**
 * A ticket raised inside the dashboard. For a client viewer the caller
 * overrides every client_* field from the session and ignores assignment and
 * project — a client cannot file a ticket against someone else's workspace.
 */
export function validateTicketCreate(raw: unknown): Validation<TicketCreateInput> {
  const b = asRecord(raw);
  if (!b) return invalid("body_invalid");
  const r = collect<Omit<TicketCreateInput, "assigned_to">>([
    ["title", text(b, "title", LIMITS.title, true)],
    ["description", text(b, "description", LIMITS.description, false)],
    ["category", enumOf(b, "category", TICKET_CATEGORIES, "other")],
    ["severity", enumOf(b, "severity", TICKET_SEVERITIES, "medium")],
    ["project_id", id(b, "project_id")],
    ["client_tenant_id", id(b, "client_tenant_id")],
    ["client_name", text(b, "client_name", LIMITS.clientName, false)],
    ["client_email", email(b, "client_email", false)],
    ["client_company", text(b, "client_company", LIMITS.company, false)],
  ]);
  if (!r.ok) return r;
  return { ok: true, value: { ...r.value, assigned_to: b.assigned_to } };
}

export type TicketPatch = Partial<{
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
  assigned_to: unknown;
  confirm_client_link: true;
}>;

export function validateTicketPatch(raw: unknown): Validation<TicketPatch> {
  const b = asRecord(raw);
  if (!b) return invalid("body_invalid");
  const out: TicketPatch = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  const steps: Array<[string, () => Validation<unknown>]> = [
    ["title", () => text(b, "title", LIMITS.title, true)],
    ["description", () => text(b, "description", LIMITS.description, false)],
    ["status", () => (isOneOf(TICKET_STATUSES, b.status) ? { ok: true, value: b.status } : invalid("status_invalid", "status"))],
    ["severity", () => (isOneOf(TICKET_SEVERITIES, b.severity) ? { ok: true, value: b.severity } : invalid("severity_invalid", "severity"))],
    ["category", () => (isOneOf(TICKET_CATEGORIES, b.category) ? { ok: true, value: b.category } : invalid("category_invalid", "category"))],
    ["resolution", () => text(b, "resolution", LIMITS.resolution, false)],
    ["project_id", () => id(b, "project_id")],
    ["client_tenant_id", () => id(b, "client_tenant_id")],
    ["client_name", () => text(b, "client_name", LIMITS.clientName, false)],
    ["client_email", () => email(b, "client_email", false)],
    ["client_company", () => text(b, "client_company", LIMITS.company, false)],
    // A founder vouches for a client link that was only inferred from the
    // public form's unverified email; until then the client cannot see it.
    ["confirm_client_link", () => (b.confirm_client_link === true ? { ok: true, value: true } : invalid("confirm_client_link_invalid", "confirm_client_link"))],
  ];
  for (const [key, run] of steps) {
    if (!has(key)) continue;
    const r = run();
    if (!r.ok) return r;
    (out as Record<string, unknown>)[key] = r.value;
  }
  if (has("assigned_to")) out.assigned_to = b.assigned_to;
  if (Object.keys(out).length === 0) return invalid("no_changes");
  return { ok: true, value: out };
}

/**
 * A comment. `is_internal` is only honoured for the team; a client comment is
 * ALWAYS public — a client cannot write a note the client cannot see, and a
 * client flag in the body cannot make their reply invisible to the team's
 * "last client reply" either.
 */
export function validateCommentCreate(
  raw: unknown,
  authorType: "team" | "client",
): Validation<{ body: string; is_internal: boolean }> {
  const b = asRecord(raw);
  if (!b) return invalid("body_invalid");
  const body = text(b, "body", LIMITS.commentBody, true);
  if (!body.ok) return body;
  if (authorType === "client") return { ok: true, value: { body: body.value as string, is_internal: false } };
  if (b.is_internal !== undefined && typeof b.is_internal !== "boolean") return invalid("is_internal_invalid", "is_internal");
  // Team default is INTERNAL: emailing a client must be a deliberate choice.
  return { ok: true, value: { body: body.value as string, is_internal: b.is_internal !== false } };
}

// ---------------------------------------------------------------------------
// The public support form
// ---------------------------------------------------------------------------

export type SupportSubmission = {
  name: string;
  email: string;
  company: string | null;
  project_hint: string | null;
  category: TicketCategory;
  severity: TicketSeverity;
  description: string;
  title: string;
};

/**
 * Parse a Client Support Ticket form payload. Required: name, email,
 * description. An unknown category/priority value (an operator edited the
 * options in the builder) degrades to other/medium rather than refusing a
 * client's support request over a label.
 */
export function parseSupportSubmission(payload: Record<string, unknown>): Validation<SupportSubmission> {
  const name = text(payload, "name", 120, true);
  if (!name.ok) return name;
  const mail = email(payload, "email", true);
  if (!mail.ok) return mail;
  const company = text(payload, "company", LIMITS.company, false);
  if (!company.ok) return company;
  const project = text(payload, "project", 160, false);
  if (!project.ok) return project;
  const description = text(payload, "description", 5000, true);
  if (!description.ok) return description;
  const category = isOneOf(TICKET_CATEGORIES, payload.category) ? payload.category : "other";
  const severity = isOneOf(TICKET_SEVERITIES, payload.priority) ? payload.priority : "medium";
  return {
    ok: true,
    value: {
      name: name.value as string,
      email: mail.value as string,
      company: company.value,
      project_hint: project.value,
      category,
      severity,
      description: description.value as string,
      title: deriveTicketTitle(category, description.value as string),
    },
  };
}

/** "Bug: The contact form on /pricing returns a 500" — first line, 90 chars. */
export function deriveTicketTitle(category: TicketCategory, description: string): string {
  const firstLine = description.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "Support request";
  const clipped = firstLine.length > 90 ? `${firstLine.slice(0, 87).trimEnd()}...` : firstLine;
  return `${TICKET_CATEGORY_LABELS[category]}: ${clipped}`;
}

/**
 * The greeting name for an email to an UNVERIFIED address. The public form
 * lets anyone type any email, so everything we echo back is attacker-shaped:
 * a "name" of "Click https://evil.example" would ride out inside an OASIS
 * email. Only the first word, only letters/apostrophes/hyphens, 30 chars max.
 */
export function safeGreetingName(name: string | null | undefined): string {
  const first = String(name || "").trim().split(/\s+/)[0] || "";
  const cleaned = first.replace(/[^\p{L}'-]/gu, "").slice(0, 30);
  return cleaned || "there";
}

// ---------------------------------------------------------------------------
// What a client may see
// ---------------------------------------------------------------------------

/** Allowlist, not a denylist: a column added later stays internal by default. */
export const CLIENT_TICKET_FIELDS = [
  "id",
  "ticket_number",
  "title",
  "description",
  "category",
  "severity",
  "status",
  "project_id",
  "project_title",
  "first_response_at",
  "resolved_at",
  "closed_at",
  "created_at",
  "updated_at",
  "last_public_reply_at",
  "last_public_reply_body",
  "comment_count",
] as const;

export const CLIENT_PROJECT_FIELDS = [
  "id",
  "title",
  "description",
  "stage",
  "due_date",
  "started_at",
  "launched_at",
  "created_at",
  "updated_at",
  "last_client_update_at",
  "last_client_update_body",
  "open_ticket_count",
] as const;

function pick<K extends string>(row: Record<string, unknown>, keys: readonly K[]): Record<K, unknown> {
  const out = {} as Record<K, unknown>;
  for (const k of keys) out[k] = row[k] ?? null;
  return out;
}

export function toClientTicket(row: Record<string, unknown>) {
  return pick(row, CLIENT_TICKET_FIELDS);
}

export function toClientProject(row: Record<string, unknown>) {
  return pick(row, CLIENT_PROJECT_FIELDS);
}

/** A comment is client-visible only when it was explicitly written public. */
export function isClientVisibleComment(c: { is_internal: unknown }): boolean {
  return c.is_internal === 0 || c.is_internal === false || c.is_internal === "0";
}

export function isClientVisibleUpdate(u: { visibility: unknown }): boolean {
  return u.visibility === "client";
}
