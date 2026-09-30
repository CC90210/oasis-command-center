/**
 * lib/os/customers/conversations.ts — a client's conversation, in one thread,
 * and the composer's send, from the tables the business already keeps.
 *
 * NO PARALLEL MESSAGE STORE. The client's thread is read from:
 *   lead_interactions     THE message ledger (email and SMS), every row in
 *                         this workspace that is about the client: on the
 *                         deal it came from (lead_id = source_lead_id), to or
 *                         from one of its addresses (primary email, contacts'
 *                         emails and phones), or stamped with its id
 *                         (metadata.customer_id, what the composer writes).
 *   conversation_events   Slack, mirrored by the Slack connection (T8) as rows
 *                         whose metadata carries channel "slack" and this
 *                         client's id (the channel is mapped to the client).
 *                         Read, never written, here.
 *   approvals             the client's email drafts from agents (send_email,
 *                         target_ref customer:<id>): pending ones are listed
 *                         for a decision, executed sends join the thread.
 *
 * THE COMPOSER (sendClientEmail). One rule decides the mailbox, and it is the
 * support desk's (lib/delivery/notify.ts): OASIS's workspace sends from the
 * OASIS mailbox; any other workspace sends only from a mailbox it connected
 * itself (the signed-in teammate's own Gmail in that workspace), never from
 * OASIS's. A workspace with none is refused in a sentence, and nothing is
 * sent. The message a person typed is sent only with confirmed: true (the
 * page asks first). An agent's draft is never sent from here: it becomes ONE
 * send_email approval (proposeClientEmail), decided in Feed.
 *
 * A sent message is written to lead_interactions (so it is in the thread and
 * on the deal) and its conversation_threads row is created or advanced (Turso
 * has no thread-maintenance trigger), in one batch.
 *
 * Tenant from the caller (the session's); bound into every statement.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Client, InStatement, ResultSet } from "@libsql/client";
import { messageSource, normalizePhoneE164, type ConversationMessage } from "@/lib/conversation-threading";
import type { BrandKey } from "@/lib/email/brands";
import { defaultExecutorDeps, executorReadiness } from "@/lib/os/approvals/executors";
import { createApproval, type CreateApprovalResult } from "@/lib/os/approvals/store";
import { normalizeEmail } from "@/lib/os/customers/rules";

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

function requireTenant(tenantId: string): string {
  if (typeof tenantId !== "string" || !tenantId.trim()) throw new Error("customers.conversations: a tenant id is required");
  return tenantId;
}

function parseJson(v: unknown): Record<string, unknown> {
  if (typeof v !== "string" || !v.trim()) return {};
  try {
    const p = JSON.parse(v);
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  } catch {
    console.error("[customers.conversations] unparseable metadata column");
    return {};
  }
}

// ---------------------------------------------------------------------------
// Who the client is, as addresses
// ---------------------------------------------------------------------------

export type ConversationCustomer = {
  id: string;
  display_name: string;
  primary_email: string | null;
  primary_phone: string | null;
  source_lead_id: string | null;
};

export type ConversationContact = { name: string | null; email: string | null; phone: string | null };

export type ClientAddresses = {
  emails: string[];
  phones: string[];
  /** Addresses the composer may write to, primary first, labelled. */
  recipients: Array<{ email: string; label: string }>;
};

export function clientAddresses(customer: ConversationCustomer, contacts: readonly ConversationContact[]): ClientAddresses {
  const emails: string[] = [];
  const recipients: ClientAddresses["recipients"] = [];
  const addEmail = (raw: string | null, label: string) => {
    const e = normalizeEmail(raw);
    if (!e || emails.includes(e)) return;
    emails.push(e);
    recipients.push({ email: e, label });
  };
  addEmail(customer.primary_email, `${customer.display_name} (main address)`);
  for (const c of contacts) addEmail(c.email, c.name ? c.name : "Contact");
  const phones = [customer.primary_phone, ...contacts.map((c) => c.phone)]
    .map((p) => normalizePhoneE164(p))
    .filter((p): p is string => Boolean(p))
    .filter((p, i, all) => all.indexOf(p) === i);
  return { emails, phones, recipients };
}

// ---------------------------------------------------------------------------
// Reading the thread
// ---------------------------------------------------------------------------

export const CONVERSATION_LIMIT = 300;

export type ClientDraft = {
  id: string;
  status: string;
  title: string;
  to: string | null;
  subject: string | null;
  created_at: string;
  decided_at: string | null;
  /** What happened when it was executed, in words; null while undecided. */
  outcome: string | null;
};

export type ClientConversation = {
  messages: ConversationMessage[];
  drafts: ClientDraft[];
  /** A read stopped at CONVERSATION_LIMIT: older messages are not shown. */
  truncated: boolean;
};

function interactionMessage(r: Row): ConversationMessage | null {
  const at = s(r.sent_at) ?? s(r.created_at);
  if (!at) return null;
  const meta = parseJson(r.metadata);
  const channel = s(r.channel) ?? "email";
  return {
    id: String(r.id),
    channel,
    source: messageSource({ channel, agent_source: s(r.agent_source), metadata: meta }),
    direction: s(r.direction) ?? "outbound",
    type: s(r.type),
    subject: s(r.subject),
    preview: s(r.content_preview) ?? s(r.content) ?? s(r.subject) ?? "",
    at,
    recording_url: null,
    transcript_url: null,
    disposition: null,
    call_outcome: null,
    call_duration_sec: null,
  };
}

function slackMessage(r: Row): ConversationMessage | null {
  const meta = parseJson(r.metadata);
  const at = s(r.created_at);
  const text = typeof meta.text === "string" ? meta.text : null;
  if (!at || text === null) return null;
  const author = typeof meta.author_name === "string" && meta.author_name.trim() ? meta.author_name.trim() : null;
  return {
    id: `slack:${String(r.id)}`,
    channel: "slack",
    source: "other",
    direction: meta.direction === "outbound" ? "outbound" : "inbound",
    type: "slack_message",
    subject: author ? `Slack · ${author}` : "Slack",
    preview: text,
    at,
    recording_url: null,
    transcript_url: null,
    disposition: null,
    call_outcome: null,
    call_duration_sec: null,
  };
}

function executionOutcome(v: unknown): string | null {
  const r = parseJson(v);
  if (r.outcome === "sent") return "Sent";
  if (r.outcome === "dry_run") return "Approved, but not sent: this deployment is in dry-run mode";
  if (r.outcome === "failed") return `Not sent: ${typeof r.message === "string" ? r.message : "the send failed"}`;
  return null;
}

/**
 * The client's messages (chronological, oldest first, as the thread reads) and
 * the agents' drafts for it. Email and SMS from the message ledger, Slack from
 * the mirrored events, sent approvals as outbound email.
 */
export async function loadClientConversation(
  db: Client,
  tenantId: string,
  customer: ConversationCustomer,
  contacts: readonly ConversationContact[],
): Promise<ClientConversation> {
  requireTenant(tenantId);
  const { emails, phones } = clientAddresses(customer, contacts);
  const match: string[] = ["(CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.customer_id') END) = ?"];
  const args: Array<string> = [customer.id];
  if (customer.source_lead_id) {
    match.push("lead_id = ?");
    args.push(customer.source_lead_id);
  }
  if (emails.length) {
    const marks = emails.map(() => "?").join(", ");
    match.push(`lower(to_email) IN (${marks})`, `lower(from_email) IN (${marks})`);
    args.push(...emails, ...emails);
  }
  if (phones.length) {
    const marks = phones.map(() => "?").join(", ");
    match.push(`to_phone IN (${marks})`, `from_phone IN (${marks})`);
    args.push(...phones, ...phones);
  }
  const [ledger, slack, approvals] = await Promise.all([
    db.execute({
      sql: `SELECT id, channel, direction, type, subject, content_preview, content, created_at, sent_at, agent_source, metadata
            FROM lead_interactions
            WHERE tenant_id = ? AND channel IN ('email', 'sms') AND (${match.join(" OR ")})
            ORDER BY COALESCE(sent_at, created_at) DESC, id DESC
            LIMIT ${CONVERSATION_LIMIT + 1}`,
      args: [tenantId, ...args],
    }),
    db.execute({
      sql: `SELECT id, metadata, created_at FROM conversation_events
            WHERE tenant_id = ?
              AND (CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.channel') END) = 'slack'
              AND (CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.customer_id') END) = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ${CONVERSATION_LIMIT + 1}`,
      args: [tenantId, customer.id],
    }),
    db.execute({
      sql: `SELECT id, status, title, payload_json, created_at, decided_at, executed_at, execution_result
            FROM approvals
            WHERE tenant_id = ? AND action_kind = 'send_email' AND target_ref = ?
            ORDER BY created_at DESC, id DESC
            LIMIT 100`,
      args: [tenantId, `customer:${customer.id}`],
    }),
  ]);
  const ledgerRows = rows(ledger);
  const slackRows = rows(slack);
  const approvalRows = rows(approvals);

  const drafts: ClientDraft[] = [];
  const approvedSends: ConversationMessage[] = [];
  for (const a of approvalRows) {
    const payload = parseJson(a.payload_json);
    const outcome = executionOutcome(a.execution_result);
    const executedAt = s(a.executed_at);
    if (a.status === "executed" && outcome === "Sent" && executedAt) {
      approvedSends.push({
        id: `approval:${String(a.id)}`,
        channel: "email",
        source: "email",
        direction: "outbound",
        type: "email_sent_on_approval",
        subject: typeof payload.subject === "string" ? payload.subject : null,
        preview: typeof payload.body === "string" ? payload.body : "",
        at: executedAt,
        recording_url: null,
        transcript_url: null,
        disposition: null,
        call_outcome: null,
        call_duration_sec: null,
      });
      continue;
    }
    drafts.push({
      id: String(a.id),
      status: String(a.status ?? ""),
      title: String(a.title ?? ""),
      to: typeof payload.to === "string" ? payload.to : null,
      subject: typeof payload.subject === "string" ? payload.subject : null,
      created_at: String(a.created_at ?? ""),
      decided_at: s(a.decided_at),
      outcome,
    });
  }

  const messages = [
    ...ledgerRows.slice(0, CONVERSATION_LIMIT).map(interactionMessage),
    ...slackRows.slice(0, CONVERSATION_LIMIT).map(slackMessage),
    ...approvedSends,
  ].filter((m): m is ConversationMessage => m !== null);
  messages.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
  return {
    messages,
    drafts,
    truncated: ledgerRows.length > CONVERSATION_LIMIT || slackRows.length > CONVERSATION_LIMIT,
  };
}

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

export const REPLY_SUBJECT_MAX = 200;
export const REPLY_BODY_MAX = 20_000;

export type ClientReply = {
  to: string;
  subject: string;
  body: string;
  /** The person saw "Send this email to <to>?" and said yes. */
  confirmed: boolean;
  /** "person" (typed here) or "agent" (a department agent's draft). */
  draftedBy: "person" | "agent";
  /** The agent or department that drafted it, when an agent did. */
  draftedByAgent: string | null;
};

export type ReplyValidation = { ok: true; value: ClientReply } | { ok: false; error: string; field?: string };

/**
 * The composer's body. `to` must be one of the client's own addresses (the
 * main one when omitted): this composer writes to THIS client, never to an
 * address typed in.
 */
export function validateClientReply(raw: unknown, addresses: ClientAddresses): ReplyValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "body_invalid" };
  const b = raw as Record<string, unknown>;
  const channel = b.channel === undefined ? "email" : b.channel;
  if (channel !== "email") return { ok: false, error: "channel_not_supported", field: "channel" };
  const asked = b.to === undefined || b.to === null || b.to === "" ? addresses.emails[0] ?? null : normalizeEmail(b.to);
  if (!asked) return { ok: false, error: addresses.emails.length ? "to_invalid" : "client_has_no_email", field: "to" };
  if (!addresses.emails.includes(asked)) return { ok: false, error: "to_not_this_client", field: "to" };
  const subject = typeof b.subject === "string" ? b.subject.replace(/\s+/g, " ").trim() : "";
  if (!subject) return { ok: false, error: "subject_required", field: "subject" };
  if (subject.length > REPLY_SUBJECT_MAX) return { ok: false, error: "subject_too_long", field: "subject" };
  const body = typeof b.body === "string" ? b.body.replace(/\r\n/g, "\n").trim() : "";
  if (!body) return { ok: false, error: "body_required", field: "body" };
  if (body.length > REPLY_BODY_MAX) return { ok: false, error: "body_too_long", field: "body" };
  const draftedBy = b.drafted_by === "agent" ? "agent" : "person";
  const agentRaw = typeof b.drafted_by_agent === "string" ? b.drafted_by_agent.trim() : "";
  if (draftedBy === "agent" && !/^[a-z][a-z0-9_-]{0,63}$/.test(agentRaw)) {
    return { ok: false, error: "drafted_by_agent_required", field: "drafted_by_agent" };
  }
  return {
    ok: true,
    value: {
      to: asked,
      subject,
      body,
      confirmed: b.confirmed === true,
      draftedBy,
      draftedByAgent: draftedBy === "agent" ? agentRaw : null,
    },
  };
}

export type SendOutcome = {
  ok: boolean;
  provider: string;
  reason?: string;
  error?: string;
  from_address?: string;
  gmail_message_id?: string;
};

/** Everything the send touches outside the database, injected (tests pass fakes). */
export type MailboxDeps = {
  /** OASIS's own workspace id (lib/delivery/rules DELIVERY_TENANT_ID). */
  oasisTenantId: string;
  /** The hard kill switch (BRAVO_FORCE_DRY_RUN=1): nothing leaves. */
  killSwitch: () => boolean;
  /** The OASIS mailbox's From, or null when it is not configured here. */
  oasisMailboxFrom: (tenantId: string) => Promise<string | null>;
  sendOasis: (args: {
    tenantId: string;
    to: string;
    cc: string[];
    subject: string;
    body: string;
    signer: unknown;
    idempotencyKey: string;
  }) => Promise<SendOutcome>;
  /** Which of the signed-in teammate's own mailboxes in this workspace is connected, if any. */
  operatorMailbox: (tenantId: string, userId: string) => Promise<"app_password" | "oauth" | null>;
  sendAsOperator: (
    kind: "app_password" | "oauth",
    args: { tenantId: string; userId: string; to: string; subject: string; body: string; brand: BrandKey; idempotencyKey: string; signer: unknown },
  ) => Promise<SendOutcome>;
  /** The legal identity this workspace's mail carries (lib/email/brand-for-tenant.ts, fail-closed). */
  brandFor: (tenantId: string) => Promise<BrandKey | null>;
  signerFor: (email: string | null, brand: BrandKey) => unknown;
};

export type MailboxChoice =
  | { ok: true; kind: "oasis_shared"; from: string; brand: "oasis" }
  | { ok: true; kind: "operator"; mailbox: "app_password" | "oauth"; brand: BrandKey }
  | { ok: false; error: "oasis_mailbox_not_configured" | "no_sender_identity" | "no_mailbox" };

/**
 * The ONE mailbox rule. OASIS's workspace: the OASIS mailbox. Any other
 * workspace: the teammate's own mailbox connected IN that workspace, and only
 * when the workspace has a legal identity to sign with. Never the OASIS
 * mailbox for another workspace.
 *
 * The identity is checked FIRST and refused under its own code: a workspace
 * with no registered sender identity (brandForTenant fails closed for every
 * workspace not in its map) cannot send whatever mailbox is connected, so
 * telling that teammate to "connect a mailbox" would send them to a fix that
 * does not work.
 */
export async function resolveClientMailbox(tenantId: string, userId: string, deps: MailboxDeps): Promise<MailboxChoice> {
  if (tenantId === deps.oasisTenantId) {
    const from = await deps.oasisMailboxFrom(tenantId);
    return from ? { ok: true, kind: "oasis_shared", from, brand: "oasis" } : { ok: false, error: "oasis_mailbox_not_configured" };
  }
  const brand = await deps.brandFor(tenantId);
  if (!brand) return { ok: false, error: "no_sender_identity" };
  const mailbox = await deps.operatorMailbox(tenantId, userId);
  if (!mailbox) return { ok: false, error: "no_mailbox" };
  return { ok: true, kind: "operator", mailbox, brand };
}

export type SendClientEmailResult =
  | { ok: true; status: "sent"; interactionId: string; from: string | null; trackingWarning: string | null }
  | { ok: true; status: "dry_run"; wouldSend: { to: string; subject: string; mailbox: string } }
  | { ok: true; status: "delivery_unknown"; interactionId: string | null; message: string }
  | { ok: false; status: 400 | 409 | 502 | 503; error: string; message?: string };

const SEND_FAILURES: Record<string, string> = {
  suppressed: "The client has opted out of email, so nothing was sent.",
  suppression_error: "The opt-out list could not be checked, so nothing was sent (it never guesses consent).",
  not_configured: "The OASIS mailbox is not configured on this deployment, so nothing was sent.",
  not_connected: "Your mailbox for this workspace is no longer connected, so nothing was sent. Reconnect it in Settings.",
  refresh_failed: "Your mailbox connection has expired, so nothing was sent. Reconnect it in Settings.",
  brand_mismatch: "The sending mailbox does not belong to this business, so nothing was sent.",
  sender_mismatch: "The connected mailbox is not the address on file, so nothing was sent.",
};

/** The thread key this message belongs to: the deal's when the client came from one, else the address. */
export function threadKeyFor(customer: ConversationCustomer, to: string): string {
  return customer.source_lead_id ? `lead:${customer.source_lead_id}` : `email:${to}`;
}

function messageStatements(args: {
  tenantId: string;
  customer: ConversationCustomer;
  reply: ClientReply;
  actor: string;
  at: string;
  status: "sent" | "delivery_unknown";
  provider: string;
  from: string | null;
  providerMessageId: string | null;
  idempotencyKey: string;
}): { id: string; stmts: InStatement[] } {
  const id = randomUUID();
  const { tenantId, customer, reply, at } = args;
  const preview = reply.body.slice(0, 1024);
  const metadata = {
    customer_id: customer.id,
    status: args.status,
    sent_via: args.provider,
    idempotency_key: args.idempotencyKey,
    ...(args.from ? { from_address: args.from } : {}),
    ...(args.providerMessageId ? { gmail_message_id: args.providerMessageId } : {}),
    ...(args.status === "delivery_unknown" ? { needs_operator_review: true } : {}),
  };
  const key = threadKeyFor(customer, reply.to);
  return {
    id,
    stmts: [
      {
        sql: `INSERT INTO lead_interactions
                (id, tenant_id, lead_id, type, channel, direction, agent_source, subject, content, content_preview,
                 to_email, from_email, sent_at, actor_user_id, provider, provider_message_id, metadata, created_at)
              VALUES (?, ?, ?, ?, 'email', 'outbound', 'client_record', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          tenantId,
          customer.source_lead_id,
          args.status === "sent" ? "email_sent" : "email_delivery_unknown",
          reply.subject,
          reply.body,
          preview,
          reply.to,
          args.from,
          args.status === "sent" ? at : null,
          args.actor,
          args.providerMessageId ? args.provider : null,
          args.providerMessageId,
          JSON.stringify(metadata),
          at,
        ],
      },
      {
        // Resolve or create the client's thread. Turso has no thread trigger
        // (database/112's is Postgres only), so the writer keeps the spine.
        sql: `INSERT INTO conversation_threads
                (id, tenant_id, thread_key, lead_id, contact_email, contact_label, status, last_message_at,
                 last_outbound_at, last_direction, last_preview, unread_count, channel_summary, sources, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, 'outbound', ?, 0, '{"email":true}', '["email"]', ?, ?)
              ON CONFLICT (tenant_id, thread_key) DO UPDATE SET
                last_message_at = CASE WHEN last_message_at IS NULL OR excluded.last_message_at > last_message_at
                                       THEN excluded.last_message_at ELSE last_message_at END,
                last_outbound_at = excluded.last_outbound_at,
                last_direction = CASE WHEN last_message_at IS NULL OR excluded.last_message_at >= last_message_at
                                      THEN 'outbound' ELSE last_direction END,
                last_preview = CASE WHEN last_message_at IS NULL OR excluded.last_message_at >= last_message_at
                                    THEN excluded.last_preview ELSE last_preview END,
                status = CASE WHEN status = 'needs_reply' THEN 'waiting_on_client' ELSE status END,
                contact_email = COALESCE(contact_email, excluded.contact_email),
                updated_at = excluded.updated_at`,
        args: [randomUUID(), tenantId, key, customer.source_lead_id, reply.to, customer.display_name, at, at, preview.slice(0, 280), at, at],
      },
    ],
  };
}

/**
 * Send a person's confirmed email to the client through the workspace's own
 * mailbox, then record it in the client's thread. Refusals come BEFORE any
 * provider call and say why; nothing is recorded for a message that did not
 * leave. A send the provider could not confirm is recorded as "delivery
 * unknown" (so nobody resends blind) and says so.
 */
export async function sendClientEmail(
  db: Client,
  deps: MailboxDeps,
  input: {
    tenantId: string;
    userId: string;
    userEmail: string | null;
    customer: ConversationCustomer;
    reply: ClientReply;
    now: Date;
  },
): Promise<SendClientEmailResult> {
  const { tenantId, userId, customer, reply, now } = input;
  requireTenant(tenantId);
  if (reply.draftedBy !== "person") return { ok: false, status: 400, error: "agent_drafts_need_approval" };
  if (!reply.confirmed) return { ok: false, status: 400, error: "confirmation_required" };
  const mailbox = await resolveClientMailbox(tenantId, userId, deps);
  if (!mailbox.ok) return { ok: false, status: 409, error: mailbox.error };
  const mailboxLabel = mailbox.kind === "oasis_shared" ? `the OASIS mailbox (${mailbox.from})` : "your connected mailbox";
  if (deps.killSwitch()) {
    return { ok: true, status: "dry_run", wouldSend: { to: reply.to, subject: reply.subject, mailbox: mailboxLabel } };
  }
  const idempotencyKey = `client-email:${randomUUID()}`;
  const signer = deps.signerFor(input.userEmail, mailbox.brand);
  const sent =
    mailbox.kind === "oasis_shared"
      ? await deps.sendOasis({
          tenantId,
          to: reply.to,
          // The sender is copied: from a shared mailbox nobody's own Sent
          // folder holds the message (the 2026-09-08 incident).
          cc: input.userEmail ? [input.userEmail.toLowerCase()] : [],
          subject: reply.subject,
          body: reply.body,
          signer,
          idempotencyKey,
        })
      : await deps.sendAsOperator(mailbox.mailbox, {
          tenantId,
          userId,
          to: reply.to,
          subject: reply.subject,
          body: reply.body,
          brand: mailbox.brand,
          idempotencyKey,
          signer,
        });
  const at = now.toISOString();
  if (!sent.ok && sent.reason !== "delivery_unknown") {
    const message = SEND_FAILURES[sent.reason ?? ""] ?? `The mail server refused it: ${sent.error ?? sent.reason ?? "unknown error"}`;
    return { ok: false, status: sent.reason === "suppressed" ? 409 : 502, error: sent.reason ?? "send_failed", message };
  }
  const status = sent.ok ? "sent" : "delivery_unknown";
  const record = messageStatements({
    tenantId,
    customer,
    reply,
    actor: userId,
    at,
    status,
    provider: sent.provider,
    from: sent.from_address ?? (mailbox.kind === "oasis_shared" ? mailbox.from : null),
    providerMessageId: sent.gmail_message_id ?? null,
    idempotencyKey,
  });
  let trackingWarning: string | null = null;
  try {
    await db.batch(record.stmts, "write");
  } catch (err) {
    // The email LEFT; only the record of it failed. Say both, loudly, so
    // nobody resends a message the client already has.
    console.error("[customers.conversations] sent but not recorded", err instanceof Error ? err.stack : err);
    trackingWarning = "The email was sent, but it could not be added to this client's conversation. Do not send it again.";
  }
  if (status === "delivery_unknown") {
    return {
      ok: true,
      status: "delivery_unknown",
      interactionId: trackingWarning ? null : record.id,
      message: "The mail server stopped answering mid-send. It may have gone out: check the Sent folder before sending again.",
    };
  }
  return { ok: true, status: "sent", interactionId: record.id, from: sent.from_address ?? null, trackingWarning };
}

/**
 * An agent's draft to the client becomes ONE send_email approval (the existing
 * kind; lib/os/approvals is not changed). The same draft proposed twice is the
 * same approval: the key is the client, the address and the words.
 *
 * SERVER-SIDE CALLERS ONLY: the agent runtime, with the agent's own key. No
 * HTTP route takes an "agent" draft from a person's session (that would let
 * anyone on the desk file an approval as an agent that never drafted it).
 *
 * A workspace whose send_email executor cannot run (lib/os/approvals/executors
 * readiness: no sender identity, or one with no sender inside the app) gets no
 * approval at all: a card that can never be carried out is not proposed.
 */
export async function proposeClientEmail(
  db: Client,
  input: { tenantId: string; tenantSlug: string | null; customer: ConversationCustomer; reply: ClientReply; now: Date },
): Promise<CreateApprovalResult | { ok: false; error: "workspace_cannot_send_email"; message: string }> {
  const { tenantId, customer, reply, now } = input;
  requireTenant(tenantId);
  if (reply.draftedBy !== "agent" || !reply.draftedByAgent) throw new Error("customers.conversations: only an agent's draft is proposed");
  const ready = executorReadiness("send_email", { id: tenantId, slug: input.tenantSlug }, defaultExecutorDeps());
  if (!ready.executable) {
    return { ok: false, error: "workspace_cannot_send_email", message: ready.note ?? "This workspace cannot send an approved email." };
  }
  const digest = createHash("sha256").update(`${reply.to}\n${reply.subject}\n${reply.body}`, "utf8").digest("hex").slice(0, 32);
  return createApproval(
    db,
    {
      tenantId,
      departmentKey: "client_success",
      requestedBy: { type: "agent", id: reply.draftedByAgent },
      actionKind: "send_email",
      title: `Email ${customer.display_name}: ${reply.subject}`.slice(0, 200),
      targetRef: `customer:${customer.id}`,
      payload: {
        to: reply.to,
        subject: reply.subject,
        body: reply.body,
        ...(customer.source_lead_id ? { lead_id: customer.source_lead_id } : {}),
      },
      idempotencyKey: `client-email:${customer.id}:${digest}`,
    },
    now,
  );
}
