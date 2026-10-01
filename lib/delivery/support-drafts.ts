/**
 * lib/delivery/support-drafts.ts - the support inbox's reply drafts.
 *
 *   POST /api/internal/support/pending-drafts  the reader asks which emails
 *        want a draft (listPendingDrafts), with what it needs to write one.
 *   POST /api/internal/support/draft           the reader files a draft, or
 *        reports that it could not write one (fileSupportDraft).
 *
 * A draft becomes ONE approval in Client Success (action kind reply_ticket,
 * requested by the customer-support agent), keyed support-draft:<message
 * record id>, expiring after 72 hours. A newer client message's draft
 * replaces the ticket's pending one (supersedes), so a ticket has one live
 * draft. Nothing is sent from here: a person approves, and
 * lib/os/approvals/executors.ts reply_ticket posts and emails it.
 *
 * IDEMPOTENT. The reader may post one record twice (its answer lost, a later
 * pass redrafts): the same words are the same approval (200); other words
 * for an already filed record are refused (409, final). A repeated failure
 * report answers 200. An email listed as wanting a draft is never listed again
 * once a draft or a failure report is filed for it.
 *
 * The tenant comes from the message record (which the receiving mailbox
 * decided at ingest), never from the body; only a registered support inbox's
 * desk is served.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import type { Client, ResultSet } from "@libsql/client";
import { createApproval } from "@/lib/os/approvals/store";
import { departmentForAgent } from "@/lib/os/approvals/rules";
import { escapeTelegramHtml } from "@/lib/notify/telegram-format";
import { supportInboxForDesk } from "@/lib/email/support-mailbox";
import { TICKET_CATEGORY_LABELS, TICKET_SEVERITY_LABELS, safeGreetingName } from "@/lib/delivery/rules";
import { deskReader, getTicket, listTicketComments, type Ticket } from "@/lib/delivery/store";
import { emailThreadSubject } from "@/lib/delivery/messages";
import { loadTicketThread } from "@/lib/delivery/email-thread";
import { defaultNotifyDeps, scheduleAfterResponse, ticketUrl, type NotifyDeps } from "@/lib/delivery/notify";
import { deskForMailbox } from "@/lib/delivery/email-intake";
import { authenticateSupportRequest, refuse, supportInboxInstalled, supportJson } from "@/lib/delivery/support-ingest-auth";

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

const s = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

/** The agent a support draft is filed as (Client Success: lib/os/approvals/rules.ts AGENT_HOME_DEPARTMENT). */
export const SUPPORT_DRAFT_AGENT = "customer-support";
/** A draft nobody decided on in this long is not what anyone means to send. */
export const SUPPORT_DRAFT_TTL_HOURS = 72;
/** At most this many drafts per ask; the reader asks for 2. */
export const PENDING_DRAFTS_MAX = 10;
/** The most recent public comments the drafter reads. */
export const DRAFT_CONTEXT_COMMENTS = 6;

export function supportDraftKey(messageRecordId: string): string {
  return `support-draft:${messageRecordId}`;
}

export type SupportRouteDeps = {
  db: Client;
  env: Record<string, string | undefined>;
  now: Date;
  notify?: NotifyDeps;
  schedule?: (task: () => Promise<void>) => void;
};

// ---------------------------------------------------------------------------
// /pending-drafts
// ---------------------------------------------------------------------------

export type PendingDraft = {
  message_record_id: string;
  ticket: { id: string; number: string; category: string; severity: string; title: string; status: string };
  facet: string | null;
  urgency: string | null;
  subject: string;
  client_first_name: string | null;
  project_title: string | null;
  latest_message: string;
  recent_public_comments: Array<{ author: "client" | "team"; body: string }>;
  opt_out: boolean;
  fallback: boolean;
};

/**
 * The emails that want a draft and have neither a draft nor a failure report
 * filed: completed, on a ticket that is not closed, and the newest email on
 * that ticket (a draft for an older one would be stale before anyone read it).
 * Oldest first.
 */
export async function listPendingDrafts(db: Client, tenantId: string, limit: number): Promise<PendingDraft[]> {
  const candidates = rows(
    await db.execute({
      sql: `SELECT m.id, m.ticket_id, m.comment_id, m.facet, m.urgency, m.subject, m.opt_out, m.fallback
            FROM support_email_messages m
            JOIN support_tickets t ON t.tenant_id = m.tenant_id AND t.id = m.ticket_id
            WHERE m.tenant_id = ? AND m.direction = 'inbound' AND m.draft_wanted = 1 AND m.draft_status IS NULL
              AND m.completed_at IS NOT NULL AND t.status <> 'closed'
              AND NOT EXISTS (
                SELECT 1 FROM support_email_messages n
                WHERE n.tenant_id = m.tenant_id AND n.ticket_id = m.ticket_id AND n.direction = 'inbound'
                  AND n.disposition IN ('new_ticket', 'appended', 'follow_up')
                  AND (n.received_at > m.received_at OR (n.received_at = m.received_at AND n.id > m.id))
              )
            ORDER BY m.received_at, m.id
            LIMIT ?`,
      args: [tenantId, limit],
    }),
  );
  const out: PendingDraft[] = [];
  const reader = deskReader(tenantId);
  for (const c of candidates) {
    const ticket = await getTicket(db, reader, String(c.ticket_id));
    if (!ticket) continue;
    const comments = await listTicketComments(db, reader, ticket.id);
    const commentId = s(c.comment_id);
    const latest = commentId ? comments.find((x) => x.id === commentId)?.body ?? null : ticket.description;
    const recent = comments
      .filter((x) => !x.is_internal && x.id !== commentId && (x.author_type === "client" || x.author_type === "team"))
      .slice(-DRAFT_CONTEXT_COMMENTS)
      .map((x) => ({ author: x.author_type === "client" ? ("client" as const) : ("team" as const), body: x.body.slice(0, 1500) }));
    const first = safeGreetingName(ticket.client_name);
    out.push({
      message_record_id: String(c.id),
      ticket: {
        id: ticket.id,
        number: ticket.ticket_number,
        category: ticket.category,
        severity: ticket.severity,
        title: ticket.title,
        status: ticket.status,
      },
      facet: s(c.facet),
      urgency: s(c.urgency),
      subject: String(c.subject ?? ""),
      client_first_name: ticket.client_name && first !== "there" ? first : null,
      project_title: ticket.project_title,
      latest_message: (latest ?? "").slice(0, 6000),
      recent_public_comments: recent,
      opt_out: Number(c.opt_out) === 1,
      fallback: Number(c.fallback) === 1,
    });
  }
  return out;
}

export async function handlePendingDrafts(req: Request, deps: SupportRouteDeps): Promise<Response> {
  const auth = await authenticateSupportRequest(req, deps.env, deps.now);
  if (!auth.ok) return auth.response;
  const b = auth.body as Record<string, unknown>;
  const desk = typeof b.mailbox === "string" ? deskForMailbox(b.mailbox) : null;
  if (!desk) return refuse(422, "unknown_mailbox");
  const limit = b.limit === undefined ? 2 : b.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) return refuse(422, "invalid_payload", { field: "limit" });
  if (!(await supportInboxInstalled(deps.db))) return refuse(503, "not_installed", { detail: "migration bravo__200 is not applied" });
  const drafts = await listPendingDrafts(deps.db, desk.tenantId, Math.min(limit, PENDING_DRAFTS_MAX));
  return supportJson(200, { ok: true, drafts });
}

// ---------------------------------------------------------------------------
// /draft
// ---------------------------------------------------------------------------

export type DraftInput =
  | { kind: "draft"; messageRecordId: string; ticketId: string; body: string; critic: unknown; modelRef: string }
  | { kind: "failure"; messageRecordId: string; ticketId: string; reason: string; attempts: number; modelRef: string };

export type DraftCheck = { ok: true; value: DraftInput } | { ok: false; field: string };

const RECORD_ID = /^[A-Za-z0-9-]{1,64}$/;

/** The reader's /draft body: a draft, or a failure report (BEA scripts/support/drafter.py). */
export function validateDraftBody(raw: unknown): DraftCheck {
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!b) return { ok: false, field: "body" };
  const messageRecordId = typeof b.message_record_id === "string" ? b.message_record_id.trim() : "";
  if (!RECORD_ID.test(messageRecordId)) return { ok: false, field: "message_record_id" };
  const ticketId = typeof b.ticket_id === "string" ? b.ticket_id.trim() : "";
  if (!RECORD_ID.test(ticketId)) return { ok: false, field: "ticket_id" };
  const modelRef = typeof b.model_ref === "string" ? b.model_ref.trim() : "";
  if (!modelRef || modelRef.length > 64) return { ok: false, field: "model_ref" };
  if (b.failure !== undefined && b.failure !== null) {
    if (b.failure !== "draft_failed" || b.body !== null) return { ok: false, field: "failure" };
    const reason = typeof b.reason === "string" ? b.reason.trim() : "";
    if (!/^[A-Za-z0-9_.:+-]{1,120}$/.test(reason)) return { ok: false, field: "reason" };
    const attempts = b.attempts;
    if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 0 || attempts > 1000) return { ok: false, field: "attempts" };
    return { ok: true, value: { kind: "failure", messageRecordId, ticketId, reason, attempts, modelRef } };
  }
  if (typeof b.body !== "string") return { ok: false, field: "body" };
  const body = b.body.replace(/\r\n/g, "\n").trim();
  if (body.length < 20 || body.length > 4000) return { ok: false, field: "body" };
  if (!b.critic || typeof b.critic !== "object" || Array.isArray(b.critic)) return { ok: false, field: "critic" };
  return { ok: true, value: { kind: "draft", messageRecordId, ticketId, body, critic: b.critic, modelRef } };
}

type Record_ = {
  id: string;
  tenant_id: string;
  ticket_id: string | null;
  subject: string | null;
  draft_wanted: boolean;
  draft_status: string | null;
  draft_approval_id: string | null;
  completed_at: string | null;
};

async function readRecord(db: Client, id: string): Promise<Record_ | null> {
  const r = rows(
    await db.execute({
      sql: `SELECT id, tenant_id, ticket_id, subject, draft_wanted, draft_status, draft_approval_id, completed_at
            FROM support_email_messages WHERE id = ? AND direction = 'inbound' LIMIT 1`,
      args: [id],
    }),
  )[0];
  if (!r) return null;
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    ticket_id: s(r.ticket_id),
    subject: s(r.subject),
    draft_wanted: Number(r.draft_wanted) === 1,
    draft_status: s(r.draft_status),
    draft_approval_id: s(r.draft_approval_id),
    completed_at: s(r.completed_at),
  };
}

export type DraftOutcome = { status: number; body: Record<string, unknown> };

/** Is there an email on this ticket newer than the record (the same rule listPendingDrafts applies)? */
async function newerMessageOnTicket(db: Client, tenantId: string, ticketId: string, recordId: string): Promise<boolean> {
  const rs = await db.execute({
    sql: `SELECT 1 AS ok FROM support_email_messages m, support_email_messages n
          WHERE m.tenant_id = ? AND m.id = ? AND n.tenant_id = m.tenant_id AND n.ticket_id = ? AND n.direction = 'inbound'
            AND n.disposition IN ('new_ticket', 'appended', 'follow_up')
            AND (n.received_at > m.received_at OR (n.received_at = m.received_at AND n.id > m.id))
          LIMIT 1`,
    args: [tenantId, recordId, ticketId],
  });
  return rs.rows.length > 0;
}

/** The ticket's pending reply draft from an EARLIER message, which a newer draft replaces. */
async function pendingDraftToReplace(db: Client, tenantId: string, ticketId: string, key: string): Promise<string | null> {
  const r = rows(
    await db.execute({
      sql: `SELECT id FROM approvals
            WHERE tenant_id = ? AND action_kind = 'reply_ticket' AND target_ref = ? AND status = 'pending' AND idempotency_key <> ?
            ORDER BY created_at DESC, id DESC LIMIT 1`,
      args: [tenantId, `ticket:${ticketId}`, key],
    }),
  )[0];
  return s(r?.id);
}

/**
 * File one draft (or one failure report). Refusals are final 4xx codes the
 * reader stops on; a draft for a record that already has one with other words
 * is 409.
 */
export async function fileSupportDraft(deps: SupportRouteDeps, input: DraftInput): Promise<DraftOutcome> {
  const { db, now } = deps;
  const record = await readRecord(db, input.messageRecordId);
  // Only a registered support inbox's desk; any other record reads as unknown.
  if (!record || !supportInboxForDesk(record.tenant_id)) return { status: 422, body: { ok: false, error: "unknown_message_record" } };
  if (record.ticket_id !== input.ticketId) return { status: 422, body: { ok: false, error: "ticket_mismatch" } };
  if (!record.completed_at) return { status: 422, body: { ok: false, error: "message_not_filed" } };
  if (!record.draft_wanted) return { status: 422, body: { ok: false, error: "draft_not_wanted" } };
  const tenantId = record.tenant_id;
  const at = now.toISOString();

  if (input.kind === "failure") {
    if (record.draft_status === "filed") return { status: 200, body: { ok: true, status: "already_filed", approval_id: record.draft_approval_id } };
    if (record.draft_status === "failed") return { status: 200, body: { ok: true, status: "already_reported" } };
    // The failure is recorded once; the ticket's note is written only by the
    // write that recorded it (changes() = 1), so a repeat adds nothing.
    await db.batch(
      [
        {
          sql: `UPDATE support_email_messages SET draft_status = 'failed', draft_failure = ?, updated_at = ?
                WHERE tenant_id = ? AND id = ? AND draft_status IS NULL`,
          args: [`${input.reason} (${input.attempts} attempts)`.slice(0, 200), at, tenantId, record.id],
        },
        {
          sql: `INSERT INTO ticket_comments (id, ticket_id, tenant_id, author_type, author_user_id, author_name, body, is_internal, created_at)
                SELECT ?, ?, ?, 'system', NULL, 'Support inbox', ?, 1, ? WHERE changes() = 1`,
          args: [
            randomUUID(),
            input.ticketId,
            tenantId,
            `No AI draft for the client's latest email: the drafter could not write one (${input.reason}, after ${input.attempts} attempts). Reply by hand from this ticket.`,
            at,
          ],
        },
      ],
      "write",
    );
    return { status: 200, body: { ok: true, status: "reported" } };
  }

  if (record.draft_status === "failed") return { status: 409, body: { ok: false, error: "draft_failure_reported" } };
  const ticket = await getTicket(db, deskReader(tenantId), input.ticketId);
  if (!ticket) return { status: 422, body: { ok: false, error: "unknown_ticket" } };
  if (ticket.status === "closed") return { status: 409, body: { ok: false, error: "ticket_closed" } };
  if (!ticket.client_email) return { status: 422, body: { ok: false, error: "ticket_has_no_client_email" } };
  // The client wrote again since: this draft answers a message that is no
  // longer their latest, and the newer one is offered for a draft of its own.
  if (await newerMessageOnTicket(db, tenantId, ticket.id, record.id)) {
    return { status: 409, body: { ok: false, error: "superseded_by_newer_message" } };
  }

  const thread = await loadTicketThread(db, tenantId, ticket.id);
  const key = supportDraftKey(record.id);
  const payload = {
    ticket_id: ticket.id,
    ticket_number: ticket.ticket_number,
    message_record_id: record.id,
    to: ticket.client_email.trim().toLowerCase(),
    subject: emailThreadSubject(thread?.rootSubject ?? record.subject ?? "", ticket.ticket_number),
    body: input.body,
    critic: input.critic,
    model_ref: input.modelRef,
  };
  const file = (supersedesId: string | null) =>
    createApproval(
      db,
      {
        tenantId,
        departmentKey: departmentForAgent(SUPPORT_DRAFT_AGENT),
        requestedBy: { type: "agent", id: SUPPORT_DRAFT_AGENT },
        actionKind: "reply_ticket",
        title: draftTitle(ticket, payload.subject),
        targetRef: `ticket:${ticket.id}`,
        payload,
        idempotencyKey: key,
        expiresAt: new Date(now.getTime() + SUPPORT_DRAFT_TTL_HOURS * 3_600_000).toISOString(),
        supersedesId,
      },
      now,
    );
  const replacing = await pendingDraftToReplace(db, tenantId, ticket.id, key);
  let made = await file(replacing);
  // The draft it meant to replace was decided in between: file it on its own.
  if (!made.ok && replacing && (made.error === "already_revised" || made.error === "supersedes_not_revisable")) made = await file(null);
  if (!made.ok) {
    if (made.error === "idempotency_key_reused") return { status: 409, body: { ok: false, error: "draft_already_filed" } };
    return { status: 422, body: { ok: false, error: made.error, ...(made.field ? { field: made.field } : {}) } };
  }
  await db.execute({
    sql: `UPDATE support_email_messages SET draft_status = 'filed', draft_approval_id = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND (draft_status IS NULL OR draft_status = 'filed')`,
    args: [made.approval.id, at, tenantId, record.id],
  });
  if (made.created && (ticket.severity === "high" || ticket.severity === "critical")) {
    const schedule = deps.schedule ?? scheduleAfterResponse;
    schedule(async () => {
      const n = deps.notify ?? defaultNotifyDeps();
      const e = escapeTelegramHtml;
      const r = await n.telegram(
        `<b>Draft ready on ${e(ticket.ticket_number)}</b> (${e(TICKET_SEVERITY_LABELS[ticket.severity])})\n${e(ticket.title)}\nApprove it in Client Success: ${e(ticketUrl(n, ticket.id))}`,
      );
      if (!r.ok) console.error("[support-drafts.draft_ready]", { ticket: ticket.ticket_number, reason: r.reason });
    });
  }
  return { status: 200, body: { ok: true, status: made.created ? "filed" : "already_filed", approval_id: made.approval.id } };
}

/** "Reply to T-0042 (Bug, High): Login page shows a 500". */
export function draftTitle(ticket: Pick<Ticket, "ticket_number" | "category" | "severity">, subject: string): string {
  const what = subject.replace(/^Re:\s*/i, "").replace(/\s*\[T-\d{4,9}\]\s*$/i, "").trim();
  const title = `Reply to ${ticket.ticket_number} (${TICKET_CATEGORY_LABELS[ticket.category]}, ${TICKET_SEVERITY_LABELS[ticket.severity]}): ${what}`;
  return title.length > 200 ? `${title.slice(0, 197).trimEnd()}...` : title;
}

export async function handleSupportDraft(req: Request, deps: SupportRouteDeps): Promise<Response> {
  const auth = await authenticateSupportRequest(req, deps.env, deps.now);
  if (!auth.ok) return auth.response;
  const v = validateDraftBody(auth.body);
  if (!v.ok) return refuse(422, "invalid_payload", { field: v.field });
  if (!(await supportInboxInstalled(deps.db))) return refuse(503, "not_installed", { detail: "migration bravo__200 is not applied" });
  const out = await fileSupportDraft(deps, v.value);
  return supportJson(out.status, out.body);
}
