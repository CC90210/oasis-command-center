/**
 * lib/delivery/messages.ts — the text of every support notification. PURE.
 *
 * TWO AUDIENCES, TWO TRUST LEVELS.
 *   Founders (Telegram + email) get everything, including the client's own
 *   words: it is internal, and they need it to triage. Telegram is sent with
 *   parse_mode HTML, so every client-typed value is escaped.
 *   The client gets as little of their own input echoed back as possible. The
 *   public form does not verify the email address, so anything we echo is
 *   attacker-controlled text inside an OASIS-branded email to an arbitrary
 *   inbox. The acknowledgement therefore carries the ticket number, the
 *   category, the priority and a sanitised first name — never the title or the
 *   description. When the attached file was not kept it says so in a fixed
 *   sentence, never naming the file (the name is sender-typed too).
 */
import { escapeTelegramHtml } from "@/lib/notify/telegram-format";
import {
  TICKET_CATEGORY_LABELS,
  TICKET_SEVERITY_LABELS,
  TICKET_STATUS_LABELS,
  formatDuration,
  safeGreetingName,
  slaTargetPhrase,
  type TicketCategory,
  type TicketSeverity,
  type TicketStatus,
} from "@/lib/delivery/rules";

export type MessageTicket = {
  id: string;
  ticket_number: string;
  title: string;
  description: string | null;
  category: TicketCategory;
  severity: TicketSeverity;
  status: TicketStatus;
  source: string;
  client_name: string | null;
  client_email: string | null;
  client_company: string | null;
  client_tenant_name: string | null;
  client_match: string | null;
  project_title: string | null;
  project_hint: string | null;
  sla_target: string;
  attachments?: Array<{ filename: string; error?: string }>;
};

export type Email = { subject: string; body: string };

/** Founders are in Montreal; show them their own clock. */
export function formatForFounders(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-CA", {
    timeZone: "America/Toronto",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }) + " ET";
}

function clientLine(t: MessageTicket): string {
  const who = [t.client_name, t.client_company, t.client_email].filter(Boolean).join(" · ");
  return who || "Unknown client";
}

function matchLine(t: MessageTicket): string {
  if (t.project_title) {
    return `Project: ${t.project_title}${t.client_match === "email_project" ? " (matched from their email)" : ""}`;
  }
  if (t.client_tenant_name) {
    return `Client workspace: ${t.client_tenant_name}${t.client_match === "email_tenant" ? " (matched from their email)" : ""}`;
  }
  if (t.client_match === "lookup_failed") return "Project: lookup FAILED, link it by hand";
  return `Project: not matched${t.project_hint ? ` (they wrote "${t.project_hint}")` : ""}`;
}

function attachmentLine(t: MessageTicket): string | null {
  const list = t.attachments ?? [];
  if (!list.length) return null;
  return list
    .map((a) => (a.error ? `Attachment ${a.filename}: NOT stored (${a.error})` : `Attachment: ${a.filename}`))
    .join("\n");
}

export function newTicketTelegram(t: MessageTicket, url: string, now: Date): string {
  const e = escapeTelegramHtml;
  const due = Math.round((Date.parse(t.sla_target) - now.getTime()) / 60_000);
  const lines = [
    `<b>New support ticket ${e(t.ticket_number)}</b> · ${e(TICKET_SEVERITY_LABELS[t.severity])} · ${e(TICKET_CATEGORY_LABELS[t.category])}`,
    e(t.title),
    "",
    e(clientLine(t)),
    e(matchLine(t)),
    `First response due ${e(formatForFounders(t.sla_target))} (in ${e(formatDuration(due))})`,
    attachmentLine(t) ? e(attachmentLine(t) as string) : "",
    "",
    e(url),
  ];
  return lines.filter((l, i, all) => l !== "" || (all[i - 1] !== "" && i > 0)).join("\n");
}

export function newTicketFounderEmail(t: MessageTicket, url: string): Email {
  const body = [
    `${t.ticket_number} · ${TICKET_SEVERITY_LABELS[t.severity]} · ${TICKET_CATEGORY_LABELS[t.category]} · via ${t.source}`,
    "",
    `From: ${clientLine(t)}`,
    matchLine(t),
    `First response due: ${formatForFounders(t.sla_target)}`,
    attachmentLine(t) ?? "",
    "",
    "What they wrote:",
    t.description || "(no description)",
    "",
    `Open the ticket: ${url}`,
    "Reply to the client from the ticket page so the reply is on the thread and stops the SLA clock.",
  ];
  return {
    subject: `[${t.ticket_number}] New ${TICKET_SEVERITY_LABELS[t.severity].toLowerCase()} ticket: ${t.title}`.slice(0, 200),
    body: body.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n"),
  };
}

export function clientAckEmail(t: MessageTicket): Email {
  const name = safeGreetingName(t.client_name);
  // The public form's thank-you screen cannot say a file was refused, so this
  // email is where the client learns it.
  const fileNotKept = (t.attachments ?? []).some((a) => a.error);
  return {
    subject: `We received your request (${t.ticket_number})`,
    body: [
      `Hi ${name},`,
      "",
      `Thanks for getting in touch. Your request is logged as ticket ${t.ticket_number}.`,
      "",
      `Category: ${TICKET_CATEGORY_LABELS[t.category]}`,
      `Priority: ${TICKET_SEVERITY_LABELS[t.severity]}`,
      "",
      ...(fileNotKept
        ? [
            "We could not keep the file you attached. We accept PDF, PNG, JPEG or WebP files up to 10 MB: reply to this email with it attached and we will add it to your ticket.",
            "",
          ]
        : []),
      `You will hear from a person on the OASIS team within ${slaTargetPhrase(t.severity)}.`,
      `If you need to add anything, reply to this email and keep ${t.ticket_number} in the subject line.`,
      "",
      "The OASIS team",
    ].join("\n"),
  };
}

/** A team member's public reply, emailed to the client. The reply is trusted text. */
export function clientReplyEmail(
  t: Pick<MessageTicket, "ticket_number" | "client_name" | "status">,
  reply: { body: string; authorName: string },
): Email {
  const name = safeGreetingName(t.client_name);
  return {
    subject: `Re: your OASIS support request (${t.ticket_number})`,
    body: [
      `Hi ${name},`,
      "",
      reply.body,
      "",
      `${reply.authorName}, OASIS`,
      "",
      `Ticket ${t.ticket_number} · Status: ${TICKET_STATUS_LABELS[t.status] ?? t.status}`,
      `Reply to this email and keep ${t.ticket_number} in the subject line.`,
    ].join("\n"),
  };
}

export function slaBreachTelegram(t: MessageTicket, url: string, now: Date): string {
  const e = escapeTelegramHtml;
  const overdue = Math.max(0, Math.round((now.getTime() - Date.parse(t.sla_target)) / 60_000));
  return [
    `<b>SLA BREACHED ${e(t.ticket_number)}</b> · ${e(TICKET_SEVERITY_LABELS[t.severity])}`,
    e(t.title),
    `${e(clientLine(t))}`,
    `No reply yet. First response was due ${e(formatForFounders(t.sla_target))}, ${e(formatDuration(overdue))} ago.`,
    e(url),
  ].join("\n");
}

export function slaBreachFounderEmail(t: MessageTicket, url: string, now: Date): Email {
  const overdue = Math.max(0, Math.round((now.getTime() - Date.parse(t.sla_target)) / 60_000));
  return {
    subject: `[${t.ticket_number}] SLA breached: no reply to a ${TICKET_SEVERITY_LABELS[t.severity].toLowerCase()} ticket`,
    body: [
      `${t.ticket_number} has had no public reply and its first-response target passed ${formatDuration(overdue)} ago (due ${formatForFounders(t.sla_target)}).`,
      "",
      `Ticket: ${t.title}`,
      `From: ${clientLine(t)}`,
      "",
      `Reply from the ticket page: ${url}`,
      "This alert is sent once per breach.",
    ].join("\n"),
  };
}
