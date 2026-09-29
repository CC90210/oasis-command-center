/**
 * lib/os/approvals/rules.ts — every rule the approvals backbone follows.
 *
 * PURE: no database, no session, no env, no node:* import. The store, the
 * executor, the API routes, the ApprovalCard (a client component) and the agent
 * tool all ask THIS module what a valid status is, what a valid payload is,
 * which transitions exist and who may decide — so tests/os-approvals.test.ts
 * pins all of it in a bare node process.
 *
 * The allowed values here are the only copy. Migration bravo__186 has no CHECK
 * constraints on these columns on purpose (SQLite cannot alter a CHECK without
 * rebuilding the table), so a value that is not in these lists must never
 * reach an INSERT: every write goes through a validate* function below first.
 *
 * Design: docs/os-revamp/02 §3.3 (DDL + execution rules), 01 §(c) Feed and
 * §(f) approval-gated wrapper, 03 "approvals contract".
 */

import type { Persona } from "@/lib/role-surfaces";
import type { DepartmentKey } from "@/lib/os/types";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { PUBLISH_CHANNELS } from "@/lib/founders/publish-targets";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * pending    waiting on a person.
 * approved   a person said yes; the executor has not claimed it yet.
 * sent_back  a person said "not like this" with a note. Terminal for THIS row:
 *            the requester revises by creating a new row (revision + 1).
 * expired    nobody decided before expires_at.
 * executing  claimed by the executor (compare-and-swap from approved).
 * executed   the executor finished and recorded what happened.
 * failed     the executor refused or the provider refused; the reason is kept.
 * cancelled  withdrawn, or replaced by a newer revision while still pending.
 */
export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "sent_back",
  "expired",
  "executing",
  "executed",
  "failed",
  "cancelled",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** No further change happens to a row in one of these. */
export const TERMINAL_STATUSES: readonly ApprovalStatus[] = ["sent_back", "expired", "executed", "failed", "cancelled"];

/**
 * The only moves a row can make. The store's compare-and-swap statements each
 * implement exactly one of these edges; tests pin that no other edge exists.
 */
export const APPROVAL_TRANSITIONS: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> = {
  pending: ["approved", "sent_back", "expired", "cancelled"],
  approved: ["executing"],
  executing: ["executed", "failed"],
  sent_back: [],
  expired: [],
  executed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: ApprovalStatus, to: ApprovalStatus): boolean {
  return APPROVAL_TRANSITIONS[from].includes(to);
}

/**
 * What a department may propose. An executor exists only for the kinds that
 * have a sanctioned send path in this app (lib/os/approvals/execute.ts
 * EXECUTORS); approving any other kind records a loud failure, never a success.
 */
export const APPROVAL_ACTION_KINDS = [
  "send_email",
  "send_sms",
  "publish_post",
  "create_ad_paused",
  "book_meeting",
  "send_invoice",
  "share_deliverable",
] as const;
export type ApprovalActionKind = (typeof APPROVAL_ACTION_KINDS)[number];

export const ACTION_KIND_LABELS: Record<ApprovalActionKind, string> = {
  send_email: "Email",
  send_sms: "Text message",
  publish_post: "Social post",
  create_ad_paused: "Ad (paused)",
  book_meeting: "Meeting",
  send_invoice: "Invoice",
  share_deliverable: "Deliverable",
};

export const REQUESTER_TYPES = ["agent", "routine", "human"] as const;
export type RequesterType = (typeof REQUESTER_TYPES)[number];

export const RISK_LEVELS = ["normal", "outbound", "spend", "data"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Everything on the list today leaves the business; an invoice also moves money. */
export const DEFAULT_RISK: Record<ApprovalActionKind, RiskLevel> = {
  send_email: "outbound",
  send_sms: "outbound",
  publish_post: "outbound",
  create_ad_paused: "spend",
  book_meeting: "outbound",
  send_invoice: "spend",
  share_deliverable: "data",
};

/** Where a decision was made. v1 decides in the app only. */
export const DECIDED_VIA = ["app", "slack", "discord", "telegram"] as const;
export type DecidedVia = (typeof DECIDED_VIA)[number];

export const APPROVAL_EVENTS = [
  "created",
  "approved",
  "sent_back",
  "commented",
  "cancelled",
  "superseded",
  "expired",
  "execution_started",
  "executed",
  "failed",
] as const;
export type ApprovalEvent = (typeof APPROVAL_EVENTS)[number];

export const ACTOR_TYPES = ["user", "agent", "routine", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** A pending approval nobody decides on in this long expires. A week-old draft is not what anyone meant to send today. */
export const DEFAULT_APPROVAL_TTL_DAYS = 7;
/** How far back "Recently decided" looks. */
export const RECENT_DECISIONS_DAYS = 7;

export const TITLE_MAX = 200;
export const NOTE_MAX = 2000;
export const COMMENT_MAX = 2000;
export const EMAIL_SUBJECT_MAX = 200;
export const EMAIL_BODY_MAX = 20_000;
export const EMAIL_CC_MAX = 10;
export const POST_NOTE_MAX = 500;
/** A payload for a kind with no dedicated validator is capped, not trusted. */
export const GENERIC_PAYLOAD_MAX_BYTES = 32_000;

export function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

export const DEPARTMENT_KEYS: readonly DepartmentKey[] = OS_DEPARTMENTS.map((d) => d.key);

export function departmentLabel(key: DepartmentKey | null | undefined): string | null {
  return OS_DEPARTMENTS.find((d) => d.key === key)?.label ?? null;
}

/**
 * The department an agent proposes for when it does not say. Mirrors the OASIS
 * bindings in components/os/department/config.ts (Chief of Staff → bravo,
 * Sales → sdr, Marketing → maven, Client Success → customer-support,
 * Finance → atlas); bravo also answers Operations but proposes as Chief of
 * Staff. tests/os-approvals.test.ts checks every binding resolves here.
 */
export const AGENT_HOME_DEPARTMENT: Readonly<Record<string, DepartmentKey>> = {
  bravo: "chief_of_staff",
  sdr: "sales",
  maven: "marketing",
  "customer-support": "client_success",
  atlas: "finance",
};

export function departmentForAgent(agentKey: string | null | undefined): DepartmentKey | null {
  const k = String(agentKey ?? "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(AGENT_HOME_DEPARTMENT, k) ? AGENT_HOME_DEPARTMENT[k] : null;
}

// ---------------------------------------------------------------------------
// Canonical payloads
// ---------------------------------------------------------------------------

/**
 * JSON with object keys sorted at every depth, so the same payload always
 * serializes to the same bytes and therefore the same payload_hash, whatever
 * order its keys were written in. Arrays keep their order (order is meaning).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Payload validation, per kind
// ---------------------------------------------------------------------------

export type Valid<T> = { ok: true; value: T } | { ok: false; error: string; field?: string };

export type SendEmailPayload = {
  to: string;
  cc?: string[];
  subject: string;
  body: string;
  /** The OASIS lead this is for, when there is one. Provenance only. */
  lead_id?: string;
};

export type PublishPostPayload = {
  asset_id: string;
  /** Channel ids from lib/founders/publish-targets.ts PUBLISH_CHANNELS. */
  platforms: string[];
  note?: string;
};

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
/** A header value may not carry a line break: that is header injection. */
const HEADER_UNSAFE = /[\r\n]/;

export function isEmail(v: unknown): v is string {
  return typeof v === "string" && v.length <= 254 && EMAIL_RE.test(v.trim());
}

function plainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function validateSendEmailPayload(raw: unknown): Valid<SendEmailPayload> {
  if (!plainObject(raw)) return { ok: false, error: "payload_invalid" };
  const to = typeof raw.to === "string" ? raw.to.trim().toLowerCase() : "";
  if (!to) return { ok: false, error: "to_required", field: "to" };
  if (!isEmail(to)) return { ok: false, error: "to_invalid", field: "to" };

  let cc: string[] | undefined;
  if (raw.cc !== undefined && raw.cc !== null) {
    const list = Array.isArray(raw.cc) ? raw.cc : typeof raw.cc === "string" ? raw.cc.split(",") : null;
    if (!list) return { ok: false, error: "cc_invalid", field: "cc" };
    const cleaned = [...new Set(list.map((c) => String(c ?? "").trim().toLowerCase()).filter(Boolean))];
    if (cleaned.length > EMAIL_CC_MAX) return { ok: false, error: "cc_too_long", field: "cc" };
    if (cleaned.some((c) => !isEmail(c))) return { ok: false, error: "cc_invalid", field: "cc" };
    const withoutTo = cleaned.filter((c) => c !== to);
    if (withoutTo.length) cc = withoutTo;
  }

  const subject = typeof raw.subject === "string" ? raw.subject.trim() : "";
  if (!subject) return { ok: false, error: "subject_required", field: "subject" };
  if (subject.length > EMAIL_SUBJECT_MAX) return { ok: false, error: "subject_too_long", field: "subject" };
  if (HEADER_UNSAFE.test(subject)) return { ok: false, error: "subject_invalid", field: "subject" };

  const body = typeof raw.body === "string" ? raw.body.replace(/\r\n/g, "\n").trim() : "";
  if (!body) return { ok: false, error: "body_required", field: "body" };
  if (body.length > EMAIL_BODY_MAX) return { ok: false, error: "body_too_long", field: "body" };

  let lead_id: string | undefined;
  if (raw.lead_id !== undefined && raw.lead_id !== null && raw.lead_id !== "") {
    const l = String(raw.lead_id).trim();
    if (!l || l.length > 64 || HEADER_UNSAFE.test(l)) return { ok: false, error: "lead_id_invalid", field: "lead_id" };
    lead_id = l;
  }

  return { ok: true, value: { to, subject, body, ...(cc ? { cc } : {}), ...(lead_id ? { lead_id } : {}) } };
}

/** The channel ids the social publisher can reach (the Post panel's own list). */
export const PUBLISHABLE_PLATFORMS: readonly string[] = PUBLISH_CHANNELS.map((c) => c.id);

export function validatePublishPostPayload(raw: unknown): Valid<PublishPostPayload> {
  if (!plainObject(raw)) return { ok: false, error: "payload_invalid" };
  const asset_id = typeof raw.asset_id === "string" ? raw.asset_id.trim() : "";
  if (!asset_id) return { ok: false, error: "asset_id_required", field: "asset_id" };
  if (asset_id.length > 64) return { ok: false, error: "asset_id_invalid", field: "asset_id" };
  if (!Array.isArray(raw.platforms) || raw.platforms.length === 0) {
    return { ok: false, error: "platforms_required", field: "platforms" };
  }
  const asked = [...new Set(raw.platforms.map((p) => String(p ?? "").trim().toLowerCase()))];
  // Refuse the whole payload rather than quietly posting to fewer surfaces than
  // were asked for — the Post panel's rule (publish/route.ts).
  const unknown = asked.filter((p) => !PUBLISHABLE_PLATFORMS.includes(p));
  if (unknown.length) return { ok: false, error: "platforms_invalid", field: "platforms" };
  let note: string | undefined;
  if (typeof raw.note === "string" && raw.note.trim()) {
    if (raw.note.length > POST_NOTE_MAX) return { ok: false, error: "note_too_long", field: "note" };
    note = raw.note.trim();
  }
  return { ok: true, value: { asset_id, platforms: asked, ...(note ? { note } : {}) } };
}

/** A kind with no dedicated validator still has to be a bounded plain object. */
export function validateGenericPayload(raw: unknown): Valid<Record<string, unknown>> {
  if (!plainObject(raw)) return { ok: false, error: "payload_invalid" };
  if (canonicalJson(raw).length > GENERIC_PAYLOAD_MAX_BYTES) return { ok: false, error: "payload_too_large" };
  return { ok: true, value: raw };
}

export function validatePayload(kind: ApprovalActionKind, raw: unknown): Valid<Record<string, unknown>> {
  switch (kind) {
    case "send_email":
      return validateSendEmailPayload(raw) as Valid<Record<string, unknown>>;
    case "publish_post":
      return validatePublishPostPayload(raw) as Valid<Record<string, unknown>>;
    default:
      return validateGenericPayload(raw);
  }
}

/** The one-paragraph preview the card shows before anyone expands the payload. */
export function previewFor(kind: ApprovalActionKind, payload: Record<string, unknown>): string {
  if (kind === "send_email") {
    const body = typeof payload.body === "string" ? payload.body : "";
    return body.length > 280 ? `${body.slice(0, 279).trimEnd()}…` : body;
  }
  if (kind === "publish_post") {
    const labels = (Array.isArray(payload.platforms) ? payload.platforms : [])
      .map((p) => PUBLISH_CHANNELS.find((c) => c.id === p)?.label ?? String(p));
    const note = typeof payload.note === "string" && payload.note ? ` — ${payload.note}` : "";
    return `Post to ${labels.join(", ")}${note}`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Creation input
// ---------------------------------------------------------------------------

export type NewApprovalInput = {
  tenantId: string;
  departmentKey: DepartmentKey | null;
  requestedBy: { type: RequesterType; id: string | null };
  routineRunId?: string | null;
  actionKind: ApprovalActionKind;
  title: string;
  targetRef?: string | null;
  payload: Record<string, unknown>;
  riskLevel?: RiskLevel;
  /** Minted by the caller when it has a natural key (a retry must reuse it). */
  idempotencyKey?: string | null;
  /** Default: now + DEFAULT_APPROVAL_TTL_DAYS. */
  expiresAt?: string | null;
  /** The row this one revises (an edit after a send-back). */
  supersedesId?: string | null;
};

export type ValidNewApproval = Omit<NewApprovalInput, "payload" | "riskLevel"> & {
  payload: Record<string, unknown>;
  riskLevel: RiskLevel;
  title: string;
};

export function validateNewApproval(input: unknown): Valid<ValidNewApproval> {
  if (!plainObject(input)) return { ok: false, error: "input_invalid" };
  const i = input as Partial<NewApprovalInput>;
  const tenantId = typeof i.tenantId === "string" ? i.tenantId.trim() : "";
  // An empty tenant must never reach an INSERT as "no tenant".
  if (!tenantId) return { ok: false, error: "tenant_required" };
  if (!isOneOf(APPROVAL_ACTION_KINDS, i.actionKind)) return { ok: false, error: "action_kind_invalid", field: "action_kind" };
  const kind = i.actionKind;
  if (i.departmentKey !== null && i.departmentKey !== undefined && !isOneOf(DEPARTMENT_KEYS, i.departmentKey)) {
    return { ok: false, error: "department_invalid", field: "department" };
  }
  const rb = i.requestedBy;
  if (!rb || !isOneOf(REQUESTER_TYPES, rb.type)) return { ok: false, error: "requested_by_invalid" };
  const title = typeof i.title === "string" ? i.title.replace(/\s+/g, " ").trim() : "";
  if (!title) return { ok: false, error: "title_required", field: "title" };
  if (title.length > TITLE_MAX) return { ok: false, error: "title_too_long", field: "title" };
  if (i.riskLevel !== undefined && !isOneOf(RISK_LEVELS, i.riskLevel)) return { ok: false, error: "risk_invalid" };
  const payload = validatePayload(kind, i.payload);
  if (!payload.ok) return payload;
  const idem = typeof i.idempotencyKey === "string" ? i.idempotencyKey.trim() : "";
  if (idem.length > 200) return { ok: false, error: "idempotency_key_too_long" };
  if (i.expiresAt !== undefined && i.expiresAt !== null && Number.isNaN(Date.parse(i.expiresAt))) {
    return { ok: false, error: "expires_at_invalid" };
  }
  return {
    ok: true,
    value: {
      tenantId,
      departmentKey: i.departmentKey ?? null,
      requestedBy: { type: rb.type, id: rb.id ? String(rb.id).slice(0, 200) : null },
      routineRunId: i.routineRunId ?? null,
      actionKind: kind,
      title,
      targetRef: i.targetRef ?? null,
      payload: payload.value,
      riskLevel: i.riskLevel ?? DEFAULT_RISK[kind],
      idempotencyKey: idem || null,
      expiresAt: i.expiresAt ?? null,
      supersedesId: i.supersedesId ? String(i.supersedesId).trim() : null,
    },
  };
}

/** Send back: a note is REQUIRED — it is what the requester revises against. */
export function validateSendBackNote(raw: unknown): Valid<string> {
  const note = typeof raw === "string" ? raw.trim() : "";
  if (!note) return { ok: false, error: "note_required", field: "note" };
  if (note.length > NOTE_MAX) return { ok: false, error: "note_too_long", field: "note" };
  return { ok: true, value: note };
}

export function validateComment(raw: unknown): Valid<string> {
  const body = typeof raw === "string" ? raw.trim() : "";
  if (!body) return { ok: false, error: "comment_required", field: "body" };
  if (body.length > COMMENT_MAX) return { ok: false, error: "comment_too_long", field: "body" };
  return { ok: true, value: body };
}

/** A payload hash as the store writes it: 64 lowercase hex characters. */
export function isPayloadHash(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}

export function isExpired(expiresAt: string | null | undefined, nowIso: string): boolean {
  return !!expiresAt && expiresAt <= nowIso;
}

// ---------------------------------------------------------------------------
// Who may see and decide
// ---------------------------------------------------------------------------

/**
 * The departments each persona is SEATED in. Owners and admins (persona
 * `founder`) decide for every department, including unattributed approvals.
 * Everyone else decides only for their own department, and only while the rail
 * would open that department for them (scope.ts intersects this with
 * mayOpenOsHref), so a builder inside OASIS — where Client Success is
 * founder-only — decides nothing there.
 *
 *   manager / sales  Sales (their book is the sales pipeline)
 *   marketing        Marketing
 *   builder          Client Success (delivery) and Marketing (canSeeMarketing)
 *   worker           Client Success (canSeeDeliveryQueues)
 *   readonly         Client Success, to SEE; canAct is false, so never decide
 *   legacy           nothing: SunBiz's grandfathered roles have no OS seat
 */
export const DEPARTMENT_SEATS: Readonly<Record<Persona, readonly DepartmentKey[]>> = {
  founder: DEPARTMENT_KEYS,
  manager: ["sales"],
  sales: ["sales"],
  marketing: ["marketing"],
  builder: ["client_success", "marketing"],
  worker: ["client_success"],
  readonly: ["client_success"],
  legacy: [],
};

/**
 * Who is looking, as the store needs it. Built ONLY from the resolved session
 * (lib/os/approvals/scope.ts); a request body never contributes to it.
 */
export type ApprovalScope = {
  tenantId: string;
  /** The session's auth user id: the decider identity. */
  userId: string;
  persona: Persona;
  canAct: boolean;
  /** True for owners/admins: every department, and unattributed approvals. */
  allDepartments: boolean;
  /** The departments this viewer may see approvals for (ignored when allDepartments). */
  departments: readonly DepartmentKey[];
};

export function approvalScopeFor(input: {
  tenantId: string;
  userId: string;
  persona: Persona;
  canAct: boolean;
  /** The departments the viewer's rail opens (mayOpenOsHref over OS_DEPARTMENTS). */
  openDepartments: ReadonlySet<DepartmentKey>;
}): ApprovalScope {
  const all = input.persona === "founder";
  const seats = DEPARTMENT_SEATS[input.persona] ?? [];
  return {
    tenantId: input.tenantId,
    userId: input.userId,
    persona: input.persona,
    canAct: input.canAct,
    allDepartments: all,
    departments: all ? DEPARTMENT_KEYS : seats.filter((d) => input.openDepartments.has(d)),
  };
}

/**
 * A read-only scope over one whole workspace, for server-side callers that are
 * not a person looking at a screen (an agent reading back its own proposals).
 * It sees every department and can decide nothing.
 */
export function workspaceReadScope(tenantId: string, userId: string): ApprovalScope {
  return {
    tenantId,
    userId,
    persona: "readonly",
    canAct: false,
    allDepartments: true,
    departments: DEPARTMENT_KEYS,
  };
}

/**
 * What an agent tool may read back for the member it is working for. The chat
 * tool runner knows the session's tenant and whether the member is an
 * owner/admin (ToolContext.isAdmin), not their persona, so it cannot rebuild
 * the rail. Owners/admins read every department. Anyone else reads only the
 * departments a non-owner can be seated in (DEPARTMENT_SEATS without
 * `founder`) and never an unattributed row, so a Chief of Staff, Finance or
 * Operations card stays owner-only through an agent exactly as it does on
 * every screen. Decides nothing either way.
 */
export function agentReadScope(tenantId: string, userId: string, isAdmin: boolean): ApprovalScope {
  if (isAdmin) return workspaceReadScope(tenantId, userId);
  const seated = new Set<DepartmentKey>();
  for (const [persona, seats] of Object.entries(DEPARTMENT_SEATS) as Array<[Persona, readonly DepartmentKey[]]>) {
    if (persona !== "founder") for (const d of seats) seated.add(d);
  }
  return {
    tenantId,
    userId,
    persona: "readonly",
    canAct: false,
    allDepartments: false,
    departments: DEPARTMENT_KEYS.filter((d) => seated.has(d)),
  };
}

/** May this viewer SEE an approval attributed to `department`? */
export function mayViewApproval(scope: ApprovalScope, department: DepartmentKey | null): boolean {
  if (scope.allDepartments) return true;
  return department !== null && scope.departments.includes(department);
}

/** May this viewer approve / send back / comment on it? */
export function mayDecideApproval(scope: ApprovalScope, department: DepartmentKey | null): boolean {
  return scope.canAct && mayViewApproval(scope, department);
}

/** True when the viewer can see no approvals at all, so no query needs to run. */
export function scopeSeesNothing(scope: ApprovalScope): boolean {
  return !scope.allDepartments && scope.departments.length === 0;
}

// ---------------------------------------------------------------------------
// What the UI receives
// ---------------------------------------------------------------------------

/**
 * What an executor wrote into execution_result. `outcome` is the executor's own
 * word for what happened; the card renders it and never infers success.
 */
export type ExecutionResult =
  | { outcome: "sent"; provider: string; message_id?: string | null; from?: string | null }
  | { outcome: "dry_run"; provider: string; would_send?: Record<string, unknown> }
  | { outcome: "queued"; provider: string; intent_id?: string | null; platforms?: string[] }
  | { outcome: "failed"; reason: string; message: string; provider?: string | null };

export type ApprovalComment = {
  id: string;
  body: string;
  author_id: string | null;
  author_name: string | null;
  created_at: string;
};

/** One approval as every surface renders it. Plain data: crosses the RSC boundary. */
export type ApprovalView = {
  id: string;
  department_key: DepartmentKey | null;
  department_label: string | null;
  action_kind: ApprovalActionKind;
  action_label: string;
  title: string;
  preview_text: string | null;
  payload: Record<string, unknown>;
  payload_hash: string;
  revision: number;
  supersedes_id: string | null;
  requested_by_type: RequesterType;
  requested_by_id: string | null;
  status: ApprovalStatus;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  decided_at: string | null;
  decided_by_name: string | null;
  decision_note: string | null;
  executing_at: string | null;
  executed_at: string | null;
  execution_result: ExecutionResult | null;
  comments: ApprovalComment[];
  /** May THIS viewer approve / send back (only while pending). */
  can_decide: boolean;
  /** May THIS viewer comment (any status). */
  can_comment: boolean;
  /**
   * Approved, but nothing has started carrying it out (the approving request
   * died first). This viewer may start it; the executor's claim keeps it once.
   */
  can_resume: boolean;
  /**
   * Whether this workspace has a sanctioned way to carry the action out. When
   * false, `readiness_note` says why, and approving records a failure.
   */
  executable: boolean;
  readiness_note: string | null;
};

/** How many approvals are waiting, for a count or a badge. */
export type ApprovalsBlock = { items: ApprovalView[]; total: number };
