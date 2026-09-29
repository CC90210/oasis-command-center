/**
 * lib/delivery/notify.ts — send the support notifications, exactly once each.
 *
 * Reuses the existing channels, no new providers:
 *   Telegram  lib/notify/telegram.ts, lane "operator" (CC's OASIS lane, the
 *             same one the OASIS funnels alert on).
 *   Email     lib/integrations/oasis-shared-gmail-send.ts — the OASIS mailbox
 *             (OASIS_MAIL_FROM + OASIS_MAIL_APP_PASSWORD, or the oasis_gmail
 *             tenant credential). It carries the suppression check, the brand
 *             guard and the OASIS footer; this module adds none of its own.
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
import { sendOasisSharedGmail } from "@/lib/integrations/oasis-shared-gmail-send";
import { OASIS_PIPELINE_ASSIGNMENT_EMAILS } from "@/lib/team";
import { publicAppBaseUrl } from "@/lib/api-helpers";
import { DELIVERY_TENANT_ID } from "@/lib/delivery/rules";
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
  clientReplyEmail,
  newTicketFounderEmail,
  newTicketTelegram,
  slaBreachFounderEmail,
  slaBreachTelegram,
} from "@/lib/delivery/messages";

export type SendResult = { ok: boolean; reason?: string };

export type NotifyDeps = {
  telegram: (text: string) => Promise<SendResult>;
  email: (m: { to: string; cc?: string[]; subject: string; body: string; idempotencyKey: string }) => Promise<SendResult>;
  founderEmails: readonly string[];
  appOrigin: string;
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
      });
      return r.ok ? { ok: true } : { ok: false, reason: `${r.reason}: ${r.error}` };
    },
    founderEmails: OASIS_PIPELINE_ASSIGNMENT_EMAILS,
    appOrigin: publicAppBaseUrl(),
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
  if (!(await claimNotification(db, tenantId, ticketId, "client_ack_at", now))) return null;
  if (!deskUsesOasisLanes(tenantId)) {
    await recordNotification(db, tenantId, ticketId, "client_ack_at", NO_MAILBOX);
    return NO_MAILBOX;
  }
  const mail = clientAckEmail(ticket);
  const r = await settle(
    deps.email({ to: ticket.client_email, subject: mail.subject, body: mail.body, idempotencyKey: `support-ack:${ticketId}` }),
  );
  const status = outcome("email", r);
  if (!r.ok) console.error("[delivery.notify.client_ack]", { ticket: ticket.ticket_number, status });
  await recordNotification(db, tenantId, ticketId, "client_ack_at", status);
  return status;
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
  ticket: Pick<Ticket, "id" | "ticket_number" | "client_name" | "client_email" | "status">,
  comment: { id: string; body: string; authorName: string },
  deps: NotifyDeps,
): Promise<string> {
  if (!ticket.client_email) {
    const status = "email: not sent (ticket has no client email)";
    await setCommentEmailStatus(db, tenantId, comment.id, status);
    return status;
  }
  if (!deskUsesOasisLanes(tenantId)) {
    await setCommentEmailStatus(db, tenantId, comment.id, NO_MAILBOX);
    return NO_MAILBOX;
  }
  const mail = clientReplyEmail(ticket, { body: comment.body, authorName: comment.authorName });
  const r = await settle(
    deps.email({ to: ticket.client_email, subject: mail.subject, body: mail.body, idempotencyKey: `support-reply:${comment.id}` }),
  );
  const status = outcome("email", r);
  if (!r.ok) console.error("[delivery.notify.client_reply]", { ticket: ticket.ticket_number, status });
  await setCommentEmailStatus(db, tenantId, comment.id, status);
  return status;
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
