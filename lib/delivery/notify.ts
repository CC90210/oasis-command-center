/**
 * lib/delivery/notify.ts — send the support notifications, exactly once each.
 *
 * Reuses the existing channels, no new providers:
 *   Telegram  lib/notify/telegram.ts, lane "operator" (CC's OASIS lane, the
 *             same one the OASIS funnels alert on).
 *   Email     lib/integrations/oasis-shared-gmail-send.ts as SUPPORT mail —
 *             from support@oasisai.work once SUPPORT_GMAIL_USER +
 *             SUPPORT_GMAIL_APP_PASSWORD are set, else the OASIS mailbox
 *             (OASIS_MAIL_FROM + OASIS_MAIL_APP_PASSWORD, or the oasis_gmail
 *             tenant credential) with one log line saying so. Replies always
 *             go to support@, which is where "reply to this email" in
 *             messages.ts leads. It carries the suppression check, the brand
 *             guard and the support footer; this module adds none of its own.
 *
 * EXACTLY ONCE. Each notification is claimed on the ticket row before it is
 * sent (store.claimNotification) and its outcome recorded after. A retry, a
 * duplicate after() or the cron re-driving a stuck ticket all find the claim
 * and send nothing. The outcome string is shown on the ticket page, so "the
 * email never went" is visible where the ticket is, not only in a log. A
 * breach alert that FAILED on a lane is the one that tries again: the next SLA
 * pass takes it back and re-sends that lane only (store.reclaimFailedBreachAlerts),
 * and the FAILED text stays on the ticket until a send records otherwise.
 *
 * THESE ARE OASIS'S CHANNELS, SO ONLY OASIS'S DESK USES THEM. Every workspace
 * now runs its own desk (lib/delivery/access.ts). A ticket on any other desk
 * must never reach CC's Telegram lane (another business's customer's words in
 * OASIS's operator channel) nor be emailed to that business's customer from the
 * OASIS mailbox under the OASIS brand. Until a workspace connects its own
 * lanes, each notification on its desk is still claimed exactly once and its
 * outcome recorded as "not sent (… for this workspace yet)" — visible on the
 * ticket, never FAILED (nothing failed; there is no lane), never retried.
 *
 * Senders are injected (NotifyDeps) so tests exercise all of this with fakes.
 */
import "server-only";
import { after } from "next/server";
import type { Client } from "@libsql/client";
import { sendTelegram } from "@/lib/notify/telegram";
import { sendOasisSharedGmail, type OwnTicketReply } from "@/lib/integrations/oasis-shared-gmail-send";
import { isDryRun } from "@/lib/integrations/send-mode";
import { supportInboxForDesk } from "@/lib/email/support-mailbox";
import { OASIS_PIPELINE_ASSIGNMENT_EMAILS } from "@/lib/team";
import { publicAppBaseUrl } from "@/lib/api-helpers";
import { DELIVERY_TENANT_ID } from "@/lib/delivery/rules";
import { SUPPORT_FORM_PATH } from "@/lib/delivery/support-form";
import {
  claimNotification,
  deskReader,
  getTicket,
  recordNotification,
  setCommentEmailStatus,
  type Ticket,
} from "@/lib/delivery/store";
import {
  clientAckEmail,
  clientEmailAckEmail,
  clientReplyEmail,
  newTicketFounderEmail,
  newTicketTelegram,
  slaBreachFounderEmail,
  slaBreachTelegram,
} from "@/lib/delivery/messages";
import { deskMessageId, loadAckFacts, loadTicketThread, recordAckOutcome, recordOutboundMessage } from "@/lib/delivery/email-thread";

export type SendResult = { ok: boolean; reason?: string };

/** One desk email. The threading fields and ownTicketReply reach the shared sender unchanged. */
export type DeskEmail = {
  to: string;
  cc?: string[];
  subject: string;
  body: string;
  idempotencyKey: string;
  inReplyTo?: string | null;
  references?: readonly string[] | null;
  autoSubmitted?: "auto-replied" | null;
  ownTicketReply?: OwnTicketReply | null;
};

export type NotifyDeps = {
  telegram: (text: string) => Promise<SendResult>;
  email: (m: DeskEmail) => Promise<SendResult>;
  founderEmails: readonly string[];
  appOrigin: string;
  /**
   * The dashboard's send mode (lib/integrations/send-mode.ts). Absent = the
   * real one. Read by the support inbox's acknowledgement, the one desk email
   * that no person triggers.
   */
  isDryRun?: (channel: string) => boolean;
  /** The Feed's event tape (agent_events), for the support inbox's stale alert. Absent = not published. */
  publishEvent?: (e: { eventType: string; tenantId: string; severity: "info" | "warn" | "error"; payload: Record<string, unknown> }) => Promise<void>;
};

export function defaultNotifyDeps(): NotifyDeps {
  return {
    telegram: (text) => sendTelegram(text, { lane: "operator" }),
    email: async (m) => {
      const r = await sendOasisSharedGmail({
        tenantId: DELIVERY_TENANT_ID,
        to: m.to,
        cc: m.cc ?? null,
        subject: m.subject,
        body: m.body,
        idempotencyKey: m.idempotencyKey,
        purpose: "support",
        inReplyTo: m.inReplyTo ?? null,
        references: m.references ?? null,
        autoSubmitted: m.autoSubmitted ?? null,
        ownTicketReply: m.ownTicketReply ?? null,
      });
      return r.ok ? { ok: true } : { ok: false, reason: `${r.reason}: ${r.error}` };
    },
    founderEmails: OASIS_PIPELINE_ASSIGNMENT_EMAILS,
    appOrigin: publicAppBaseUrl(),
    isDryRun,
    publishEvent: async (e) => {
      const { publishAgentEvent } = await import("@/lib/manifest/events");
      await publishAgentEvent({ ...e, publisher: "dept:client_success" });
    },
  };
}

/**
 * Run `task` after the response is sent (next/server after()). Outside a
 * request scope — a script, a test — after() throws, and the task runs as a
 * detached promise instead. Either way a failure is logged, never thrown into
 * the request that already succeeded.
 */
export function scheduleAfterResponse(task: () => Promise<void>): void {
  const run = () =>
    task().catch((err) => console.error("[delivery.after] threw", err instanceof Error ? err.stack : err));
  try {
    after(run);
  } catch {
    void run();
  }
}

export function ticketUrl(deps: NotifyDeps, ticketId: string): string {
  return `${deps.appOrigin.replace(/\/+$/, "")}/tickets/${ticketId}`;
}

/** OASIS's public support form, as a full link for an email to a client. */
export function supportFormUrl(deps: NotifyDeps): string {
  return `${deps.appOrigin.replace(/\/+$/, "")}${SUPPORT_FORM_PATH}`;
}

/**
 * Every email OASIS sends a CLIENT ends with where to ask for help next: the
 * public support form (/f/oasis-ai-cc/support). Only OASIS's desk emails
 * clients (deskUsesOasisLanes), so the link is always OASIS's own form.
 */
export function withSupportLink(body: string, deps: NotifyDeps): string {
  return `${body}\n\nNeed help with something else? Open a new request: ${supportFormUrl(deps)}`;
}

/** Does this desk send through OASIS's lanes? Only OASIS's own. */
export function deskUsesOasisLanes(tenantId: string): boolean {
  return tenantId === DELIVERY_TENANT_ID;
}

/** The recorded outcome on a desk that has no lanes of its own yet. Never contains "FAILED". */
export const NO_ALERT_LANE = "telegram: not sent (no alert channel for this workspace yet); email: not sent (no mailbox connected for this workspace yet)";
export const NO_MAILBOX = "email: not sent (no mailbox connected for this workspace yet)";

async function settle(p: Promise<SendResult>): Promise<SendResult> {
  try {
    return await p;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function outcome(label: string, r: SendResult): string {
  return r.ok ? `${label}: sent` : `${label}: FAILED (${(r.reason || "unknown").slice(0, 160)})`;
}

async function emailFounders(deps: NotifyDeps, subject: string, body: string, key: string): Promise<SendResult> {
  const [to, ...cc] = deps.founderEmails;
  if (!to) return { ok: false, reason: "no founder email configured" };
  return settle(deps.email({ to, cc, subject, body, idempotencyKey: key }));
}

/** Telegram + email the desk's team about a new ticket. Returns the recorded outcome, or null if already claimed. */
export async function notifyFoundersOfNewTicket(
  db: Client,
  tenantId: string,
  ticketId: string,
  deps: NotifyDeps,
  now: Date,
): Promise<string | null> {
  if (!(await claimNotification(db, tenantId, ticketId, "founder_alert_at", now))) return null;
  if (!deskUsesOasisLanes(tenantId)) {
    await recordNotification(db, tenantId, ticketId, "founder_alert_at", NO_ALERT_LANE);
    return NO_ALERT_LANE;
  }
  const ticket = await getTicket(db, deskReader(tenantId), ticketId);
  if (!ticket) return null;
  const url = ticketUrl(deps, ticketId);
  const mail = newTicketFounderEmail(ticket, url);
  const [tg, em] = await Promise.all([
    settle(deps.telegram(newTicketTelegram(ticket, url, now))),
    emailFounders(deps, mail.subject, mail.body, `support-new:${ticketId}`),
  ]);
  const status = `${outcome("telegram", tg)}; ${outcome("email", em)}`;
  if (!tg.ok || !em.ok) console.error("[delivery.notify.new_ticket]", { ticket: ticket.ticket_number, status });
  await recordNotification(db, tenantId, ticketId, "founder_alert_at", status);
  return status;
}

/** The client's confirmation with their ticket number. Null if already claimed or no address. */
export async function acknowledgeClient(
  db: Client,
  tenantId: string,
  ticketId: string,
  deps: NotifyDeps,
  now: Date,
): Promise<string | null> {
  const ticket = await getTicket(db, deskReader(tenantId), ticketId);
  if (!ticket || !ticket.client_email) return null;
  if (ticket.source === "email") return acknowledgeEmailTicket(db, tenantId, ticket, deps, now);
  if (!(await claimNotification(db, tenantId, ticketId, "client_ack_at", now))) return null;
  if (!deskUsesOasisLanes(tenantId)) {
    await recordNotification(db, tenantId, ticketId, "client_ack_at", NO_MAILBOX);
    return NO_MAILBOX;
  }
  const mail = clientAckEmail(ticket);
  const key = `support-ack:${ticketId}`;
  const r = await settle(
    deps.email({ to: ticket.client_email, subject: mail.subject, body: withSupportLink(mail.body, deps), idempotencyKey: key }),
  );
  const status = outcome("email", r);
  if (!r.ok) console.error("[delivery.notify.client_ack]", { ticket: ticket.ticket_number, status });
  await recordNotification(db, tenantId, ticketId, "client_ack_at", status);
  // Recorded, so a client's reply to it threads back onto this ticket.
  if (r.ok) await recordDeskSend(db, tenantId, ticket, { origin: "ack", commentId: null, key, to: ticket.client_email, subject: mail.subject, now });
  return status;
}

/** What the outcome line says when the acknowledgement was decided against at ingest. */
const ACK_SKIP_WORDS: Record<string, string> = {
  opt_out: "the sender asked to stop receiving email",
  not_wanted: "the support inbox did not ask for one (acknowledgements are off, or the sender could not be verified)",
  not_a_new_ticket: "the email added to an existing ticket",
  sender_not_verified: "the sender could not be verified",
  automated: "the email was sent by a machine",
  sender_limit: "this sender already got several acknowledgements recently",
};

/**
 * THE INSTANT ACKNOWLEDGEMENT OF AN EMAIL (design section 6). Whether one goes
 * at all was decided ONCE, at ingest (email-intake.ts ackDecision: the reader
 * asked for it, a new ticket, a verified human sender, not an opt-out, under
 * the per-sender limit) and written on the message before the ticket existed.
 * This re-reads that decision, so the reconcile pass that retries a lost
 * after() can only send an acknowledgement that was meant to go.
 *
 * Then: claimed once (client_ack_at, as the form's), the recipient pinned to
 * the verified address that sent the email (a ticket address changed since is
 * refused), the dashboard's send mode (dry run sends nothing), the shared
 * sender's opt-out check. It goes from support@, threaded on the client's
 * message (In-Reply-To, References), marked Auto-Submitted, tagged [T-0042],
 * and is recorded so their reply threads back.
 */
async function acknowledgeEmailTicket(
  db: Client,
  tenantId: string,
  ticket: Ticket,
  deps: NotifyDeps,
  now: Date,
): Promise<string | null> {
  const facts = await loadAckFacts(db, tenantId, ticket.id);
  if (!(await claimNotification(db, tenantId, ticket.id, "client_ack_at", now))) return null;
  const finish = async (status: string, ackStatus: string, sentAt: string | null) => {
    await recordNotification(db, tenantId, ticket.id, "client_ack_at", status);
    if (facts) await recordAckOutcome(db, tenantId, facts.claimId, ackStatus, sentAt);
    return status;
  };
  if (!facts) return finish("email: not sent (no record of the email that opened this ticket)", "not_sent:no_record", null);
  if (!deskUsesOasisLanes(tenantId)) return finish(NO_MAILBOX, "not_sent:no_mailbox", null);
  const decided = facts.ackStatus ?? "";
  if (decided !== "scheduled") {
    const reason = decided.startsWith("skipped:") ? decided.slice("skipped:".length) : decided || "not_decided";
    return finish(`email: not sent (${ACK_SKIP_WORDS[reason] ?? reason})`, decided || "not_sent:not_decided", null);
  }
  // PINNED RECIPIENT. It acknowledges the email that opened the ticket, so it
  // goes to the address that SENT that email, and only while the record says
  // Gmail authenticated it; never to whatever the ticket says now. A ticket
  // address changed since (a person's edit before a late reconcile pass) is
  // refused and recorded, not followed.
  if (!facts.senderVerified) return finish("email: not sent (the sender could not be verified)", "not_sent:sender_not_verified", null);
  const to = facts.fromAddress ?? "";
  if (!to || (ticket.client_email ?? "").trim().toLowerCase() !== to) {
    return finish("email: not sent (the ticket's client address changed after the email arrived)", "not_sent:recipient_changed", null);
  }
  if ((deps.isDryRun ?? isDryRun)("email")) {
    return finish("email: not sent (dry run: email sending is off on this deployment)", "dry_run", null);
  }
  const mail = clientEmailAckEmail(ticket, facts.subject);
  const key = `support-ack:${ticket.id}`;
  const references = [...facts.references, ...(facts.messageId ? [facts.messageId] : [])];
  const r = await settle(
    deps.email({
      to,
      subject: mail.subject,
      body: withSupportLink(mail.body, deps),
      idempotencyKey: key,
      inReplyTo: facts.messageId,
      references,
      autoSubmitted: "auto-replied",
    }),
  );
  if (r.ok) {
    await recordDeskSend(db, tenantId, ticket, {
      origin: "ack",
      commentId: null,
      key,
      to,
      subject: mail.subject,
      now,
      inReplyTo: facts.messageId,
      references,
    });
    return finish("email: sent", "sent", now.toISOString());
  }
  // The shared sender's own opt-out check said no: nothing failed.
  if ((r.reason || "").startsWith("suppressed")) {
    return finish("email: not sent (the sender has opted out of email)", "not_sent:suppressed", null);
  }
  const status = outcome("email", r);
  console.error("[delivery.notify.client_ack_email]", { ticket: ticket.ticket_number, status });
  return finish(status, "failed", null);
}

/** Record a desk email that left, for threading. Never fails the send it records. */
async function recordDeskSend(
  db: Client,
  tenantId: string,
  ticket: Pick<Ticket, "id" | "ticket_number">,
  m: {
    origin: "ack" | "reply";
    commentId: string | null;
    key: string;
    to: string;
    subject: string;
    now: Date;
    inReplyTo?: string | null;
    references?: readonly string[];
  },
): Promise<void> {
  const mailbox = supportInboxForDesk(tenantId);
  if (!mailbox) return;
  try {
    await recordOutboundMessage(db, {
      tenantId,
      mailbox,
      ticketId: ticket.id,
      commentId: m.commentId,
      origin: m.origin,
      idempotencyKey: m.key,
      to: m.to,
      subject: m.subject,
      inReplyTo: m.inReplyTo ?? null,
      references: m.references ?? [],
      at: m.now.toISOString(),
    });
  } catch (err) {
    // The email went; only its threading record failed. The client's reply
    // still finds the ticket by the [T-0042] tag in the subject.
    console.error("[delivery.notify.record_send]", { ticket: ticket.ticket_number, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Both intake notifications, independently: one failing never blocks the other. */
export async function runIntakeNotifications(
  db: Client,
  tenantId: string,
  ticketId: string,
  deps: NotifyDeps,
  now: Date,
): Promise<void> {
  const results = await Promise.allSettled([
    notifyFoundersOfNewTicket(db, tenantId, ticketId, deps, now),
    acknowledgeClient(db, tenantId, ticketId, deps, now),
  ]);
  for (const r of results) {
    if (r.status === "rejected") console.error("[delivery.notify.intake] threw", r.reason);
  }
}

/** Email a public team reply to the client and record the outcome on the comment. */
export async function emailClientReply(
  db: Client,
  tenantId: string,
  ticket: Pick<Ticket, "id" | "ticket_number" | "client_name" | "client_email" | "status"> & { source?: string },
  comment: { id: string; body: string; authorName: string },
  deps: NotifyDeps,
): Promise<string> {
  return (await sendTicketReplyEmail(db, tenantId, ticket, comment, deps)).status;
}

export type TicketReplyEmailResult = {
  /** The outcome line stored on the comment ("email: sent", "email: FAILED (...)"). */
  status: string;
  ok: boolean;
  /** The shared sender's reason code when it did not go ("not_configured", "send_failed"...). */
  reason: string | null;
  error: string | null;
  /** The Message-ID it carries (derived from its idempotency key), when it went. */
  messageId: string | null;
};

/**
 * A public reply on a ticket, emailed to the client: a teammate's reply from
 * the ticket page, or an approved reply draft (lib/os/approvals/executors.ts
 * reply_ticket, `preSigned`).
 *
 * THREADED. When the ticket has a recorded email thread (support@, migration
 * bravo__200) it answers the client's latest message (In-Reply-To) inside the
 * thread (References), under their own subject tagged with the ticket number.
 * It is recorded once sent, so their answer threads back.
 *
 * A REPLY TO THE CLIENT'S OWN TICKET IS TRANSACTIONAL: it goes to the ticket's
 * requester even after they opted out of marketing (ownTicketReply; the rule
 * and how narrow it is: oasis-shared-gmail-send.ts isOwnTicketReply).
 */
export async function sendTicketReplyEmail(
  db: Client,
  tenantId: string,
  ticket: Pick<Ticket, "id" | "ticket_number" | "client_name" | "client_email" | "status"> & { source?: string },
  comment: { id: string; body: string; authorName: string; preSigned?: boolean },
  deps: NotifyDeps,
  now: Date = new Date(),
): Promise<TicketReplyEmailResult> {
  const done = async (status: string, r: Partial<TicketReplyEmailResult> = {}): Promise<TicketReplyEmailResult> => {
    await setCommentEmailStatus(db, tenantId, comment.id, status);
    return { status, ok: false, reason: null, error: null, messageId: null, ...r };
  };
  if (!ticket.client_email) return done("email: not sent (ticket has no client email)", { reason: "no_client_email" });
  if (!deskUsesOasisLanes(tenantId)) return done(NO_MAILBOX, { reason: "no_mailbox" });
  const thread = await loadTicketThread(db, tenantId, ticket.id);
  const mail = clientReplyEmail(
    ticket,
    { body: comment.body, authorName: comment.authorName, preSigned: comment.preSigned },
    ticket.source === "email" && thread ? thread.rootSubject ?? "" : null,
  );
  const key = `support-reply:${comment.id}`;
  const r = await settle(
    deps.email({
      to: ticket.client_email,
      subject: mail.subject,
      body: withSupportLink(mail.body, deps),
      idempotencyKey: key,
      inReplyTo: thread?.inReplyTo ?? null,
      references: thread?.references ?? null,
      ownTicketReply: { ticketId: ticket.id, requester: ticket.client_email },
    }),
  );
  const status = outcome("email", r);
  if (!r.ok) {
    console.error("[delivery.notify.client_reply]", { ticket: ticket.ticket_number, status });
    const [code, ...rest] = (r.reason || "unknown").split(": ");
    return done(status, { reason: code, error: rest.join(": ") || null });
  }
  await recordDeskSend(db, tenantId, ticket, {
    origin: "reply",
    commentId: comment.id,
    key,
    to: ticket.client_email,
    subject: mail.subject,
    now,
    inReplyTo: thread?.inReplyTo ?? null,
    references: thread?.references ?? [],
  });
  return done(status, { ok: true, messageId: deskMessageId(key) });
}

/**
 * Alert the desk's team about a breach whose claim this caller already holds.
 * `previousStatus` is the outcome of an earlier attempt that FAILED on a lane
 * (store.reclaimFailedBreachAlerts): a lane it records as sent is not sent
 * again, so retrying a dead mailbox does not repeat the Telegram message.
 */
export async function alertSlaBreach(
  db: Client,
  tenantId: string,
  ticketId: string,
  deps: NotifyDeps,
  now: Date,
  previousStatus: string | null = null,
): Promise<string | null> {
  const ticket = await getTicket(db, deskReader(tenantId), ticketId);
  if (!ticket) return null;
  if (!deskUsesOasisLanes(tenantId)) {
    await recordNotification(db, tenantId, ticketId, "sla_breach_alert_at", NO_ALERT_LANE);
    return NO_ALERT_LANE;
  }
  const url = ticketUrl(deps, ticketId);
  const mail = slaBreachFounderEmail(ticket, url, now);
  // The status is "telegram: <outcome>; email: <outcome>" and a sent lane has
  // no reason text after it, so these anchors cannot match inside a reason.
  const telegramSent = previousStatus?.startsWith("telegram: sent;") ?? false;
  const emailSent = previousStatus?.endsWith("; email: sent") ?? false;
  const [tg, em] = await Promise.all([
    telegramSent ? { ok: true } : settle(deps.telegram(slaBreachTelegram(ticket, url, now))),
    emailSent ? { ok: true } : emailFounders(deps, mail.subject, mail.body, `support-breach:${ticketId}:${ticket.sla_target}`),
  ]);
  const status = `${outcome("telegram", tg)}; ${outcome("email", em)}`;
  if (!tg.ok || !em.ok) console.error("[delivery.notify.sla_breach]", { ticket: ticket.ticket_number, status });
  await recordNotification(db, tenantId, ticketId, "sla_breach_alert_at", status);
  return status;
}
