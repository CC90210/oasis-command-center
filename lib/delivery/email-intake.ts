/**
 * lib/delivery/email-intake.ts - an email to support@ becomes a ticket, a
 * line on an existing ticket, or (for mail that is not a client's request)
 * nothing at all. POST /api/internal/support/ingest runs handleSupportIngest.
 *
 * WHO DOES WHAT. A reader on CC's PC (BEA scripts/support/) reads support@,
 * filters and classifies each message, and posts it here, HMAC-signed
 * (support-ingest-auth.ts). It never writes a ticket and never emails anyone.
 * This module owns the ticket, the acknowledgement, the thread and the ledger.
 *
 * THE TENANT comes from the RECEIVING mailbox, through the support inbox
 * registry (lib/email/support-mailbox.ts supportInboxDeskTenant): support@
 * files into OASIS's own desk. Nothing in the request body names a tenant.
 *
 * THE STEPS, for one message:
 *   1. CLAIM. The message's key is sha256 of its Message-ID exactly as sent (or
 *      the reader's synthetic key when it has none). The claim row
 *      (support_email_messages, direction inbound) is written FIRST, with the
 *      whole plan in it: the disposition, the ids it will create, the notes,
 *      and the acknowledgement decision. A second post of the same message
 *      finds the claim: complete = the same answer again (same ticket number);
 *      incomplete = the same plan finished, never a second ticket. Replacing
 *      the plan and completing the claim are compare-and-swaps on the stored
 *      plan, so two attempts at once agree on one plan, one ticket and one
 *      answer (carryOut). The same key with other content (sender, subject or
 *      text) is refused, 409.
 *   2. THREAD (planIngest). In order: the In-Reply-To / References ids match a
 *      message on this desk (our acknowledgement or reply, or an earlier email
 *      from the client); the subject names a ticket ([T-0042], (T-0042),
 *      T-0042); the same verified sender has an open ticket with the same
 *      subject from the last 7 days. An email joins that ticket only when its
 *      sender is VERIFIED and ON THE THREAD (the ticket's requester, someone
 *      who already wrote on it, or a contact of its client record): a stranger
 *      who quotes T-0042 opens a new ticket, and their words never land on
 *      another client's. A closed ticket is never reopened by email: the
 *      message opens a follow-up ticket, with a note on the old one.
 *   3. WRITE. The ticket (createTicket, idempotent on its planned id; the SLA
 *      clock starts when the mail arrived, at most 14 days back) or the client
 *      comment (addTicketComment, idempotent on its planned id; it reopens a
 *      waiting or resolved ticket). Then ONE batch: the notes, the claim's
 *      completion, the ledger row (ticket.message_received), an opt-out, and,
 *      for a ticket linked to a client record only, the client's
 *      Conversations thread (lib/os/customers/message-mirror.ts).
 *   4. ANSWER, then after the response: the team's alert and the
 *      acknowledgement for a new ticket (lib/delivery/notify.ts), or a
 *      "client replied" message for an email added to a ticket.
 *
 * THE ACKNOWLEDGEMENT (ackDecision) goes only when the reader asked for it
 * (ack_wanted, its permission bit) AND this side agrees: a new ticket, a
 * verified human sender, not an opt-out, under the per-sender limit. The
 * dashboard's send mode and the opt-out list are checked again when it sends.
 * It is decided once, here, and written on the claim before any ticket exists.
 *
 * AN OPT-OUT (classification.opt_out) files the ticket like any other (a person
 * reads it), sends nothing automatically, and records the sender on OASIS's
 * opt-out list, the one every sender checks (email_suppressions).
 *
 * PRIVACY. The text of a client's email is stored once, as the ticket's
 * description or comment: that is the business record. The claim row holds
 * routing facts. Mail that is not a ticket keeps only its key, the sender's
 * domain and what was decided, and is purged after 30 days
 * (purgeOldNonTicketMessages, run by the SLA cron).
 */
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Client, InStatement, ResultSet } from "@libsql/client";
import { emitIfChanged, type LedgerStatement } from "@/lib/ledger/emit";
import { canonicalJson } from "@/lib/os/approvals/rules";
import { isRetiredTenant } from "@/lib/tenant/retired";
import { escapeTelegramHtml } from "@/lib/notify/telegram-format";
import {
  OASIS_SUPPRESSION_BRAND,
  OASIS_SUPPRESSION_TENANT_ID,
  isAddressOfMailbox,
  supportInboxDeskTenant,
} from "@/lib/email/support-mailbox";
import {
  LIMITS,
  OPEN_TICKET_STATUSES,
  SUPPORT_FACETS,
  SUPPORT_URGENCIES,
  TICKET_CATEGORY_LABELS,
  findTicketRefInSubject,
  isOneOf,
  normalizeSubjectForThread,
  supportFacetToTicket,
  type SupportFacet,
  type SupportUrgency,
  type TicketCategory,
  type TicketSeverity,
} from "@/lib/delivery/rules";
import {
  addTicketComment,
  createTicket,
  deskReader,
  getTicket,
  projectCustomerId,
  systemNoteStatement,
  type Ticket,
} from "@/lib/delivery/store";
import { OASIS_DESK, type SupportDesk } from "@/lib/delivery/desks";
import { matchRequesterEmail } from "@/lib/delivery/support-intake";
import {
  defaultNotifyDeps,
  runIntakeNotifications,
  scheduleAfterResponse,
  ticketUrl,
  type NotifyDeps,
} from "@/lib/delivery/notify";
import { lookupHashes, messageIdHash, syntheticMessageKey } from "@/lib/delivery/email-thread";
import { authenticateSupportRequest, refuse, supportInboxInstalled, supportJson } from "@/lib/delivery/support-ingest-auth";
import { clientEmailMirrorStatements } from "@/lib/os/customers/message-mirror";

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

/** The producer every ledger row here names: the catalog's owner of the key. */
export const EMAIL_INTAKE_LEDGER_PRODUCER = "lib/delivery/email-intake.ts";
const MESSAGE_RECEIVED_KEY = "ticket.message_received";

/** Per sender, over the windows below: acknowledgements, and new tickets before the next email joins their newest. */
export const SENDER_LIMITS = { perTenMinutes: 3, perDay: 10 } as const;
/** How far back the "same subject, same sender" heuristic looks. */
export const SAME_SUBJECT_WINDOW_DAYS = 7;
/** The SLA clock starts when the mail arrived, but never more than this far back. */
export const MAX_BACKDATE_DAYS = 14;
/** Non-ticket mail is forgotten after this. */
export const NON_TICKET_RETENTION_DAYS = 30;
/** How many times one request re-reads a claim another attempt moved on under it before it gives up loudly. */
const CLAIM_LAPS = 4;

/** The facets a reply draft is written for (BEA drafter.DRAFTABLE_FACETS). */
export const DRAFTABLE_FACETS: readonly SupportFacet[] = ["bug", "how_to", "billing", "access", "feature_request"];

// ---------------------------------------------------------------------------
// The request body (the reader's contract, BEA scripts/support/ingest.py)
// ---------------------------------------------------------------------------

export type IngestBody = {
  mailbox: string;
  deliveredTo: string;
  origin: string;
  ackWanted: boolean;
  message: {
    messageId: string | null;
    inReplyTo: string | null;
    references: string[];
    receivedAt: string;
    from: { address: string; name: string | null };
    replyTo: string | null;
    to: string[];
    cc: string[];
    subject: string;
    bodyText: string;
    bodyTruncated: boolean;
    attachments: Array<{ filename: string; mime_type: string; size: number }>;
    auth: { spf: string | null; dkim: string | null; dmarc: string | null; aligned: boolean };
    autoSubmitted: boolean;
    forwardedBy: string | null;
  };
  classification: {
    isSupportRequest: boolean;
    nonTicketKind: string | null;
    facet: SupportFacet;
    urgency: SupportUrgency;
    confidence: number;
    fallback: boolean;
    summary: string;
    optOut: boolean;
    modelRef: string;
  };
};

export type BodyCheck = { ok: true; value: IngestBody } | { ok: false; error: "invalid_payload"; field: string };

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const CODE_RE = /^[a-z][a-z0-9_]{0,31}$/;

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A Message-ID as the reader sends it: one token, no whitespace, at most 1000 characters. */
function messageIdOk(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 1000 && !/\s/.test(v);
}

/**
 * The reader's body, checked field by field. Every key the contract names must
 * be present with its type; keys it does not name are ignored (the contract
 * grows additively: ack_wanted, opt_out and model_ref were added that way). A
 * facet or urgency this side does not know degrades to other / normal rather
 * than refusing a client's request over a label.
 */
export function validateIngestBody(raw: unknown): BodyCheck {
  const bad = (field: string): BodyCheck => ({ ok: false, error: "invalid_payload", field });
  const b = obj(raw);
  if (!b) return bad("body");
  const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
  const strOrNull = (v: unknown, max: number) => v === null || str(v, max);
  const strList = (v: unknown, maxItems: number, maxLen: number) =>
    Array.isArray(v) && v.length <= maxItems && v.every((x) => typeof x === "string" && x.length <= maxLen);

  if (!str(b.mailbox, 320) || !EMAIL_RE.test(String(b.mailbox).trim())) return bad("mailbox");
  if (!str(b.delivered_to, 320)) return bad("delivered_to");
  if (!str(b.origin, 64)) return bad("origin");
  if (typeof b.ack_wanted !== "boolean") return bad("ack_wanted");

  const m = obj(b.message);
  if (!m) return bad("message");
  if (m.message_id !== null && !messageIdOk(m.message_id)) return bad("message.message_id");
  if (m.in_reply_to !== null && !messageIdOk(m.in_reply_to)) return bad("message.in_reply_to");
  if (!strList(m.references, 100, 1000)) return bad("message.references");
  if (typeof m.received_at !== "string" || !ISO_UTC_RE.test(m.received_at) || Number.isNaN(Date.parse(m.received_at))) {
    return bad("message.received_at");
  }
  const from = obj(m.from);
  if (!from) return bad("message.from");
  if (!str(from.address, 320) || !EMAIL_RE.test(String(from.address).trim())) return bad("message.from.address");
  if (!strOrNull(from.name, 400)) return bad("message.from.name");
  if (!strOrNull(m.reply_to, 320)) return bad("message.reply_to");
  if (!strList(m.to, 200, 320)) return bad("message.to");
  if (!strList(m.cc, 200, 320)) return bad("message.cc");
  if (!str(m.subject, 2000)) return bad("message.subject");
  if (!str(m.body_text, 40_000)) return bad("message.body_text");
  if (typeof m.body_truncated !== "boolean") return bad("message.body_truncated");
  if (!Array.isArray(m.attachments) || m.attachments.length > 100) return bad("message.attachments");
  for (const a of m.attachments) {
    const x = obj(a);
    if (!x || !str(x.filename, 1000) || !str(x.mime_type, 255) || typeof x.size !== "number" || !Number.isFinite(x.size) || x.size < 0) {
      return bad("message.attachments");
    }
  }
  const auth = obj(m.auth);
  if (!auth) return bad("message.auth");
  for (const k of ["spf", "dkim", "dmarc"] as const) if (!strOrNull(auth[k], 64)) return bad(`message.auth.${k}`);
  if (typeof auth.aligned !== "boolean") return bad("message.auth.aligned");
  if (typeof m.auto_submitted !== "boolean") return bad("message.auto_submitted");
  if (!strOrNull(m.forwarded_by, 320)) return bad("message.forwarded_by");

  const c = obj(b.classification);
  if (!c) return bad("classification");
  if (typeof c.is_support_request !== "boolean") return bad("classification.is_support_request");
  if (c.non_ticket_kind !== null && !(typeof c.non_ticket_kind === "string" && CODE_RE.test(c.non_ticket_kind))) {
    return bad("classification.non_ticket_kind");
  }
  if (typeof c.facet !== "string") return bad("classification.facet");
  if (typeof c.urgency !== "string") return bad("classification.urgency");
  if (typeof c.confidence !== "number" || !Number.isFinite(c.confidence)) return bad("classification.confidence");
  if (typeof c.fallback !== "boolean") return bad("classification.fallback");
  if (!str(c.summary, 1000)) return bad("classification.summary");
  if (typeof c.opt_out !== "boolean") return bad("classification.opt_out");
  if (!str(c.model_ref, 64)) return bad("classification.model_ref");

  const lowerList = (v: unknown) => (v as string[]).map((x) => x.trim().toLowerCase()).filter(Boolean);
  return {
    ok: true,
    value: {
      mailbox: String(b.mailbox).trim().toLowerCase(),
      deliveredTo: String(b.delivered_to).trim().toLowerCase(),
      origin: String(b.origin),
      ackWanted: b.ack_wanted,
      message: {
        messageId: (m.message_id as string | null) ?? null,
        inReplyTo: (m.in_reply_to as string | null) ?? null,
        references: m.references as string[],
        receivedAt: m.received_at,
        from: { address: String(from.address).trim().toLowerCase(), name: (from.name as string | null) ?? null },
        replyTo: (m.reply_to as string | null) ?? null,
        to: lowerList(m.to),
        cc: lowerList(m.cc),
        subject: m.subject as string,
        bodyText: m.body_text as string,
        bodyTruncated: m.body_truncated,
        attachments: (m.attachments as Array<Record<string, unknown>>).map((a) => ({
          filename: String(a.filename),
          mime_type: String(a.mime_type),
          size: Math.round(Number(a.size)),
        })),
        auth: {
          spf: (auth.spf as string | null) ?? null,
          dkim: (auth.dkim as string | null) ?? null,
          dmarc: (auth.dmarc as string | null) ?? null,
          aligned: auth.aligned,
        },
        autoSubmitted: m.auto_submitted,
        forwardedBy: (m.forwarded_by as string | null) ? String(m.forwarded_by).trim().toLowerCase() : null,
      },
      classification: {
        isSupportRequest: c.is_support_request,
        nonTicketKind: (c.non_ticket_kind as string | null) ?? null,
        facet: isOneOf(SUPPORT_FACETS, c.facet) ? c.facet : "other",
        urgency: isOneOf(SUPPORT_URGENCIES, c.urgency) ? c.urgency : "normal",
        confidence: Math.min(1, Math.max(0, c.confidence)),
        fallback: c.fallback,
        summary: c.summary as string,
        optOut: c.opt_out,
        modelRef: c.model_ref as string,
      },
    },
  };
}

/** The message's key: sha256 of its Message-ID as sent, or the reader's synthetic key. */
export function ingestMessageKey(body: IngestBody): string {
  const m = body.message;
  return m.messageId ? messageIdHash(m.messageId) : syntheticMessageKey(m.receivedAt, m.from.address, m.subject, m.bodyText);
}

/** What makes two posts of one key the SAME message: its sender, subject and text. */
export function ingestContentHash(body: IngestBody): string {
  const m = body.message;
  return createHash("sha256")
    .update(canonicalJson({ from: m.from.address, subject: m.subject, body: m.bodyText }), "utf8")
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

export type Disposition = "new_ticket" | "appended" | "follow_up" | "bounce_noted" | "not_a_ticket";
export type SenderKind = "verified" | "unverified" | "forwarded";

/**
 * Who the sender is, as far as this side can trust it: verified (Gmail
 * authenticated the From domain, the reader's `aligned`), a teammate's forward
 * (the client's address came from the forwarded text, so it is unverified), or
 * unverified.
 */
export function senderKind(m: Pick<IngestBody["message"], "auth" | "forwardedBy">): SenderKind {
  if (m.forwardedBy) return "forwarded";
  return m.auth.aligned ? "verified" : "unverified";
}

/**
 * Whether the instant acknowledgement goes, decided once. "scheduled", or
 * "skipped:<reason>". The reader's ack_wanted is a permission, never an
 * order: false always means no.
 */
export function ackDecision(input: {
  ackWanted: boolean;
  disposition: Disposition;
  sender: SenderKind;
  autoSubmitted: boolean;
  optOut: boolean;
  recentAcks: { tenMinutes: number; day: number };
}): string {
  if (input.optOut) return "skipped:opt_out";
  if (!input.ackWanted) return "skipped:not_wanted";
  if (input.disposition !== "new_ticket" && input.disposition !== "follow_up") return "skipped:not_a_new_ticket";
  if (input.sender !== "verified") return "skipped:sender_not_verified";
  if (input.autoSubmitted) return "skipped:automated";
  if (input.recentAcks.tenMinutes >= SENDER_LIMITS.perTenMinutes || input.recentAcks.day >= SENDER_LIMITS.perDay) {
    return "skipped:sender_limit";
  }
  return "scheduled";
}

/**
 * Whether the reader is asked to draft a reply: a person's request that landed
 * on a ticket, read by the model (not a degraded read), of a facet the drafter
 * writes for, not an opt-out, from a verified sender or a teammate's forward.
 * A draft only ever becomes an approval a person decides.
 */
export function draftWanted(input: {
  disposition: Disposition;
  sender: SenderKind;
  classification: Pick<IngestBody["classification"], "isSupportRequest" | "facet" | "fallback" | "optOut">;
  autoSubmitted: boolean;
}): boolean {
  const c = input.classification;
  return (
    (input.disposition === "new_ticket" || input.disposition === "appended" || input.disposition === "follow_up") &&
    c.isSupportRequest &&
    !c.optOut &&
    !c.fallback &&
    !input.autoSubmitted &&
    DRAFTABLE_FACETS.includes(c.facet) &&
    input.sender !== "unverified"
  );
}

/** When the SLA clock starts: when the mail arrived, clamped to [now - 14 days, now]. */
export function ticketClock(receivedAt: string, now: Date): Date {
  const t = Date.parse(receivedAt);
  if (!Number.isFinite(t)) return now;
  return new Date(Math.min(now.getTime(), Math.max(now.getTime() - MAX_BACKDATE_DAYS * 86_400_000, t)));
}

/** The client's subject without reply prefixes or ticket tags, case kept: a ticket title's second half. */
export function cleanSubject(subject: string): string {
  let base = subject.replace(/[\r\n]+/g, " ").replace(/[[(]\s*T-\d{4,9}\s*[\])]/gi, " ");
  for (;;) {
    const next = base.replace(/^\s*(?:re|fwd?|tr|aw|sv)\s*(?:\[\d+\])?\s*:\s*/i, "");
    if (next === base) break;
    base = next;
  }
  return base.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text;
}

/** "Bug: Login page shows a 500" from the subject, else the first line of the text. */
export function emailTicketTitle(category: TicketCategory, subject: string, bodyText: string, followUpOf: string | null = null): string {
  const fromSubject = cleanSubject(subject);
  const firstLine = bodyText.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const what = clip(fromSubject || firstLine || "Email to support", 90);
  return clip(followUpOf ? `Follow-up to ${followUpOf}: ${what}` : `${TICKET_CATEGORY_LABELS[category]}: ${what}`, LIMITS.title);
}

/** The text that lands on the ticket: the client's new text, and a line when it was cut. */
export function ticketText(m: Pick<IngestBody["message"], "bodyText" | "bodyTruncated">): string {
  const text = m.bodyText.trim() || "(The email had no text.)";
  const note = m.bodyTruncated ? "\n\n[Shortened: the full message is in support@.]" : "";
  return `${clip(text, LIMITS.description - note.length)}${note}`;
}

function kb(size: number): string {
  return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
}

/** The internal line that says how the email was read and routed. Never shown to the client. */
export function routingNote(body: IngestBody, sender: SenderKind, extra: string[] = []): string {
  const m = body.message;
  const c = body.classification;
  const lines = [
    `From an email to ${body.mailbox}${body.deliveredTo !== body.mailbox ? ` (delivered to ${body.deliveredTo})` : ""}.`,
    sender === "verified"
      ? "Sender verified (their mail provider authenticated the address)."
      : sender === "forwarded"
        ? `Forwarded by ${m.forwardedBy}. The client's address came from the forwarded text and is not verified: no automatic email went to it.`
        : "Sender NOT verified: no automatic email went to it, it was not linked to a client record, and it will not join another ticket.",
    c.fallback
      ? "The classifier was unavailable, so this was filed as Other / Medium and no reply draft will be written."
      : `Read as ${c.facet.replace(/_/g, " ")}, ${c.urgency} urgency (confidence ${c.confidence.toFixed(2)}).`,
    ...(c.summary.trim() ? [`Summary: ${clip(c.summary.trim(), 200)}`] : []),
    ...(m.attachments.length
      ? [
          `Attachments (kept in support@, not here): ${m.attachments
            .slice(0, 10)
            .map((a) => `${clip(a.filename, 80)} (${a.mime_type}, ${kb(a.size)})`)
            .join("; ")}${m.attachments.length > 10 ? `; and ${m.attachments.length - 10} more` : ""}.`,
        ]
      : []),
    ...extra,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type NewTicketPlan = {
  title: string;
  category: TicketCategory;
  severity: TicketSeverity;
  client_name: string | null;
  client_email: string;
  project_id: string | null;
  client_tenant_id: string | null;
  client_match: string;
  customer_id: string | null;
  assigned_to: string | null;
};

export type IngestPlan = {
  v: 1;
  disposition: Disposition;
  /** The ticket the message lands on (a planned id for a new one). Null for not_a_ticket. */
  ticketId: string | null;
  newTicket: NewTicketPlan | null;
  /** The client comment's planned id (appended). */
  commentId: string | null;
  notes: Array<{ id: string; ticketId: string; body: string }>;
  ack: string;
  draftWanted: boolean;
  suppress: boolean;
  sender: SenderKind;
  /** Why this was not a ticket, for the answer (loop, automated, not_support, bounce_unmatched). */
  reason: string | null;
};

type Candidate = { ticket: Ticket; via: "headers" | "subject" | "same_subject" };

async function ticketById(db: Client, tenantId: string, id: string | null): Promise<Ticket | null> {
  return id ? getTicket(db, deskReader(tenantId), id) : null;
}

/** The ticket this email continues, by the threading order in the header. */
async function findThreadCandidate(db: Client, tenantId: string, body: IngestBody, sender: SenderKind, now: Date): Promise<Candidate | null> {
  const m = body.message;
  const hashes = lookupHashes([m.inReplyTo, ...m.references]);
  if (hashes.length) {
    const hit = rows(
      await db.execute({
        sql: `SELECT ticket_id FROM support_email_messages
              WHERE tenant_id = ? AND direction IN ('inbound', 'outbound') AND ticket_id IS NOT NULL
                AND message_id_hash IN (${hashes.map(() => "?").join(", ")})
              ORDER BY received_at DESC, id DESC LIMIT 1`,
        args: [tenantId, ...hashes],
      }),
    )[0];
    const t = await ticketById(db, tenantId, s(hit?.ticket_id));
    if (t) return { ticket: t, via: "headers" };
  }
  const seq = findTicketRefInSubject(m.subject);
  if (seq !== null) {
    const hit = rows(
      await db.execute({ sql: "SELECT id FROM support_tickets WHERE tenant_id = ? AND ticket_seq = ? LIMIT 1", args: [tenantId, seq] }),
    )[0];
    const t = await ticketById(db, tenantId, s(hit?.id));
    if (t) return { ticket: t, via: "subject" };
  }
  const subject = normalizeSubjectForThread(m.subject);
  if (sender === "verified" && subject) {
    const since = new Date(now.getTime() - SAME_SUBJECT_WINDOW_DAYS * 86_400_000).toISOString();
    const recent = rows(
      await db.execute({
        sql: `SELECT ticket_id, subject FROM support_email_messages
              WHERE tenant_id = ? AND direction = 'inbound' AND from_address = ? AND ticket_id IS NOT NULL AND ingested_at >= ?
              ORDER BY received_at DESC, id DESC LIMIT 20`,
        args: [tenantId, m.from.address, since],
      }),
    );
    for (const r of recent) {
      if (normalizeSubjectForThread(r.subject) !== subject) continue;
      const t = await ticketById(db, tenantId, s(r.ticket_id));
      if (t && (OPEN_TICKET_STATUSES as readonly string[]).includes(t.status)) return { ticket: t, via: "same_subject" };
    }
  }
  return null;
}

/**
 * Is this sender on the ticket's thread: its requester, someone who already
 * emailed it, or the main address or a contact of its client record?
 */
async function senderOnThread(db: Client, tenantId: string, ticket: Ticket, address: string): Promise<boolean> {
  if ((ticket.client_email || "").trim().toLowerCase() === address) return true;
  const wrote = await db.execute({
    sql: `SELECT 1 AS ok FROM support_email_messages
          WHERE tenant_id = ? AND ticket_id = ? AND direction = 'inbound' AND from_address = ? LIMIT 1`,
    args: [tenantId, ticket.id, address],
  });
  if (wrote.rows.length) return true;
  if (!ticket.customer_id) return false;
  try {
    const contact = await db.execute({
      sql: `SELECT 1 AS ok FROM customers c WHERE c.tenant_id = ? AND c.id = ? AND c.primary_email = ? AND c.archived_at IS NULL
            UNION ALL
            SELECT 1 FROM customer_contacts cc WHERE cc.tenant_id = ? AND cc.customer_id = ? AND cc.email = ?
            LIMIT 1`,
      args: [tenantId, ticket.customer_id, address, tenantId, ticket.customer_id, address],
    });
    return contact.rows.length > 0;
  } catch (err) {
    if (/no such table: (customers|customer_contacts)\b/i.test(err instanceof Error ? err.message : String(err))) return false;
    throw err;
  }
}

/** This sender's acknowledgements and email tickets over the limit windows (server time). */
async function senderCounts(db: Client, tenantId: string, address: string, now: Date) {
  const tenMin = new Date(now.getTime() - 10 * 60_000).toISOString();
  const day = new Date(now.getTime() - 86_400_000).toISOString();
  const r = rows(
    await db.execute({
      sql: `SELECT
              SUM(CASE WHEN ingested_at >= ? AND ack_status IN ('scheduled', 'sent') THEN 1 ELSE 0 END) AS acks10,
              SUM(CASE WHEN ack_status IN ('scheduled', 'sent') THEN 1 ELSE 0 END) AS acks_day,
              SUM(CASE WHEN ingested_at >= ? AND disposition IN ('new_ticket', 'follow_up') THEN 1 ELSE 0 END) AS new10,
              SUM(CASE WHEN disposition IN ('new_ticket', 'follow_up') THEN 1 ELSE 0 END) AS new_day
            FROM support_email_messages
            WHERE tenant_id = ? AND direction = 'inbound' AND from_address = ? AND ingested_at >= ?`,
      args: [tenMin, tenMin, tenantId, address, day],
    }),
  )[0];
  const n = (v: unknown) => Number(v ?? 0) || 0;
  return {
    acks: { tenMinutes: n(r?.acks10), day: n(r?.acks_day) },
    newTickets: { tenMinutes: n(r?.new10), day: n(r?.new_day) },
  };
}

/** The sender's newest working ticket, for an email past the new-ticket limit. */
async function newestOpenTicketOf(db: Client, tenantId: string, address: string): Promise<Ticket | null> {
  const hit = rows(
    await db.execute({
      sql: `SELECT id FROM support_tickets
            WHERE tenant_id = ? AND lower(client_email) = ? AND status IN (${OPEN_TICKET_STATUSES.map(() => "?").join(", ")})
            ORDER BY created_at DESC, id DESC LIMIT 1`,
      args: [tenantId, address, ...OPEN_TICKET_STATUSES],
    }),
  )[0];
  return ticketById(db, tenantId, s(hit?.id));
}

/**
 * Decide everything about one message before anything is written. Reads
 * only. The plan is stored on the claim, so a retry carries out THIS plan.
 */
export async function planIngest(db: Client, desk: SupportDesk, body: IngestBody, now: Date): Promise<IngestPlan> {
  const tenantId = desk.tenantId;
  const m = body.message;
  const c = body.classification;
  const sender = senderKind(m);
  const base = {
    v: 1 as const,
    newTicket: null,
    commentId: null,
    notes: [] as IngestPlan["notes"],
    draftWanted: false,
    sender,
    // A literal opt-out is honoured whatever else is true about the message.
    suppress: c.optOut,
  };
  const notATicket = (reason: string): IngestPlan => ({
    ...base,
    disposition: "not_a_ticket",
    ticketId: null,
    ack: "skipped:not_a_new_ticket",
    reason,
  });

  // Our own mailbox writing to itself is a loop, whatever it says.
  if (isAddressOfMailbox(m.from.address, body.mailbox)) return { ...notATicket("loop"), suppress: false };

  // A delivery report about one of OUR emails becomes a note on that ticket.
  if (c.nonTicketKind === "bounce") {
    const hashes = lookupHashes([m.inReplyTo, ...m.references]);
    const hit = hashes.length
      ? rows(
          await db.execute({
            sql: `SELECT ticket_id, origin, received_at FROM support_email_messages
                  WHERE tenant_id = ? AND direction = 'outbound' AND ticket_id IS NOT NULL
                    AND message_id_hash IN (${hashes.map(() => "?").join(", ")})
                  ORDER BY received_at DESC LIMIT 1`,
            args: [tenantId, ...hashes],
          }),
        )[0]
      : undefined;
    const t = await ticketById(db, tenantId, s(hit?.ticket_id));
    if (!t) return { ...notATicket("bounce_unmatched"), suppress: false };
    const what = s(hit?.origin) === "ack" ? "the acknowledgement" : "a reply";
    return {
      ...base,
      suppress: false,
      disposition: "bounce_noted",
      ticketId: t.id,
      notes: [
        {
          id: randomUUID(),
          ticketId: t.id,
          body:
            `A delivery failure report came back for ${what} emailed on this ticket (sent ${s(hit?.received_at) ?? "earlier"}). ` +
            `The client may not have received it: check the address, or reach them another way. ` +
            `The report is in support@ (subject: ${clip(cleanSubject(m.subject) || "(none)", 120)}).`,
        },
      ],
      ack: "skipped:not_a_new_ticket",
      reason: null,
    };
  }
  // Machine mail (out-of-office, auto-replies, bulk) never opens a ticket and
  // never joins one: an out-of-office answer to our acknowledgement must not
  // reopen the ticket it answers.
  if (m.autoSubmitted) return notATicket("automated");
  if (!c.isSupportRequest) return notATicket(c.nonTicketKind ? `not_support:${c.nonTicketKind}` : "not_support");

  const { category, severity } = c.fallback ? { category: "other" as const, severity: "medium" as const } : supportFacetToTicket(c.facet, c.urgency);
  const counts = await senderCounts(db, tenantId, m.from.address, now);
  const finish = (p: Omit<IngestPlan, "ack" | "draftWanted" | "v" | "sender" | "suppress" | "reason">): IngestPlan => ({
    ...base,
    ...p,
    ack: ackDecision({
      ackWanted: body.ackWanted,
      disposition: p.disposition,
      sender,
      autoSubmitted: m.autoSubmitted,
      optOut: c.optOut,
      recentAcks: counts.acks,
    }),
    draftWanted: draftWanted({ disposition: p.disposition, sender, classification: c, autoSubmitted: m.autoSubmitted }),
    reason: null,
  });
  const optOutLine = c.optOut
    ? [
        "The sender asked to stop receiving email. They are on OASIS's opt-out list now: no acknowledgement and no marketing email will reach them. A reply to this ticket still does (it answers their own request).",
      ]
    : [];

  const candidate = await findThreadCandidate(db, tenantId, body, sender, now);
  const onThread = candidate && sender === "verified" ? await senderOnThread(db, tenantId, candidate.ticket, m.from.address) : false;

  if (candidate && onThread) {
    const t = candidate.ticket;
    if (t.status === "closed") {
      const id = randomUUID();
      return finish({
        disposition: "follow_up",
        ticketId: id,
        newTicket: {
          title: emailTicketTitle(category, m.subject, m.bodyText, t.ticket_number),
          category,
          severity,
          client_name: m.from.name ? clip(m.from.name, LIMITS.clientName) : null,
          client_email: m.from.address,
          project_id: t.project_id,
          client_tenant_id: t.client_tenant_id,
          client_match: t.client_match ?? "none",
          customer_id: t.customer_id,
          assigned_to: t.assigned_to,
        },
        commentId: null,
        notes: [
          { id: randomUUID(), ticketId: id, body: routingNote(body, sender, [`Follow-up to ${t.ticket_number}, which was closed.`, ...optOutLine]) },
          {
            id: randomUUID(),
            ticketId: t.id,
            body: "The client emailed again after this ticket was closed. Their message opened a follow-up ticket instead of reopening this one.",
          },
        ],
      });
    }
    return finish({
      disposition: "appended",
      ticketId: t.id,
      newTicket: null,
      commentId: randomUUID(),
      notes: [
        ...(m.attachments.length || c.optOut || m.bodyTruncated
          ? [{ id: randomUUID(), ticketId: t.id, body: routingNote(body, sender, optOutLine) }]
          : []),
      ],
    });
  }

  // Past the per-sender new-ticket limit, a verified sender's email joins their
  // newest working ticket instead of opening another (the mail-bomb guard).
  const overLimit =
    sender === "verified" &&
    (counts.newTickets.tenMinutes >= SENDER_LIMITS.perTenMinutes || counts.newTickets.day >= SENDER_LIMITS.perDay);
  if (overLimit && !candidate) {
    const newest = await newestOpenTicketOf(db, tenantId, m.from.address);
    if (newest) {
      return finish({
        disposition: "appended",
        ticketId: newest.id,
        newTicket: null,
        commentId: randomUUID(),
        notes: [
          {
            id: randomUUID(),
            ticketId: newest.id,
            body: routingNote(body, sender, [
              `This sender opened several tickets in a short time, so this email was added to their newest open ticket instead of opening another.`,
              ...optOutLine,
            ]),
          },
        ],
      });
    }
  }

  const strangerLine =
    candidate && !onThread
      ? [
          sender === "verified"
            ? `This email referred to ${candidate.ticket.ticket_number}, but the sender is not on that ticket, so it opened this one instead.`
            : `This email referred to ${candidate.ticket.ticket_number}, but the sender could not be verified, so it opened this one instead.`,
        ]
      : [];
  return finish(await newTicketParts(db, desk, body, sender, [...strangerLine, ...optOutLine]));
}

/**
 * The parts of a NEW-ticket plan: the planned id, the ticket, the routing
 * note. Only a verified sender is linked to a client record (as the form
 * links one, matchRequesterEmail); a ticket on a project takes that project's
 * client record.
 */
async function newTicketParts(
  db: Client,
  desk: SupportDesk,
  body: IngestBody,
  sender: SenderKind,
  extraLines: string[],
): Promise<Pick<IngestPlan, "disposition" | "ticketId" | "newTicket" | "commentId" | "notes">> {
  const m = body.message;
  const c = body.classification;
  const { category, severity } = c.fallback ? { category: "other" as const, severity: "medium" as const } : supportFacetToTicket(c.facet, c.urgency);
  const id = randomUUID();
  let link = { project_id: null as string | null, client_tenant_id: null as string | null, client_match: "none", customer_id: null as string | null };
  if (sender === "verified") {
    try {
      const match = await matchRequesterEmail(db, desk, m.from.address, null);
      let customer = match.customer_id;
      if (match.project_id) customer = (await projectCustomerId(db, desk.tenantId, match.project_id)) ?? customer;
      link = { project_id: match.project_id, client_tenant_id: match.client_tenant_id, client_match: match.client_match, customer_id: customer };
    } catch (err) {
      // Matching enriches the ticket; it never costs the client their request.
      console.error("[email-intake] client match failed", err instanceof Error ? err.message : err);
      link = { ...link, client_match: "lookup_failed" };
    }
  }
  return {
    disposition: "new_ticket",
    ticketId: id,
    newTicket: {
      title: emailTicketTitle(category, m.subject, m.bodyText),
      category,
      severity,
      client_name: m.from.name ? clip(m.from.name, LIMITS.clientName) : null,
      client_email: m.from.address,
      ...link,
      assigned_to: null,
    },
    commentId: null,
    notes: [{ id: randomUUID(), ticketId: id, body: routingNote(body, sender, extraLines) }],
  };
}

/**
 * A new-ticket plan for an email whose planned ticket can no longer take it
 * (it closed, or is gone, between the plan and the write). Same decisions
 * (acknowledgement, draft) as any new ticket.
 */
async function replanAsNewTicket(db: Client, desk: SupportDesk, body: IngestBody, previous: IngestPlan, now: Date): Promise<IngestPlan> {
  const m = body.message;
  const counts = await senderCounts(db, desk.tenantId, m.from.address, now);
  const parts = await newTicketParts(db, desk, body, previous.sender, [
    "The ticket this email was meant for could no longer take it (it was closed or removed), so it opened this one.",
  ]);
  return {
    ...previous,
    ...parts,
    ack: ackDecision({
      ackWanted: body.ackWanted,
      disposition: "new_ticket",
      sender: previous.sender,
      autoSubmitted: m.autoSubmitted,
      optOut: body.classification.optOut,
      recentAcks: counts.acks,
    }),
    draftWanted: draftWanted({ disposition: "new_ticket", sender: previous.sender, classification: body.classification, autoSubmitted: m.autoSubmitted }),
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

export type Claim = {
  id: string;
  content_hash: string | null;
  plan: IngestPlan | null;
  /** The plan exactly as stored: what a compare-and-swap on the claim compares. */
  plan_json: string | null;
  ticket_id: string | null;
  disposition: string | null;
  ack_status: string | null;
  draft_wanted: boolean;
  completed_at: string | null;
};

async function loadClaim(db: Client, tenantId: string, hash: string): Promise<Claim | null> {
  const r = rows(
    await db.execute({
      sql: `SELECT id, content_hash, plan_json, ticket_id, disposition, ack_status, draft_wanted, completed_at
            FROM support_email_messages WHERE tenant_id = ? AND direction = 'inbound' AND message_id_hash = ? LIMIT 1`,
      args: [tenantId, hash],
    }),
  )[0];
  if (!r) return null;
  let plan: IngestPlan | null = null;
  try {
    plan = r.plan_json ? (JSON.parse(String(r.plan_json)) as IngestPlan) : null;
  } catch {
    console.error("[email-intake] unparseable plan_json", { claim: r.id });
  }
  return {
    id: String(r.id),
    content_hash: s(r.content_hash),
    plan,
    plan_json: s(r.plan_json),
    ticket_id: s(r.ticket_id),
    disposition: s(r.disposition),
    ack_status: s(r.ack_status),
    draft_wanted: Number(r.draft_wanted) === 1,
    completed_at: s(r.completed_at),
  };
}

/** The claim row: routing facts and the plan, never the text. Non-ticket mail keeps only the sender's domain. */
function claimStatement(claimId: string, desk: SupportDesk, body: IngestBody, hash: string, contentHash: string, plan: IngestPlan, now: Date): InStatement {
  const m = body.message;
  const c = body.classification;
  const keep = plan.disposition !== "not_a_ticket";
  const at = now.toISOString();
  return {
    sql: `INSERT INTO support_email_messages
            (id, tenant_id, direction, mailbox, delivered_to, origin, message_id, message_id_hash, content_hash, in_reply_to,
             references_json, from_address, to_json, cc_json, subject, ticket_id, comment_id, disposition, plan_json,
             sender_verified, auth_json, auto_submitted, forwarded_by, is_support_request, non_ticket_kind, facet, urgency,
             confidence, fallback, opt_out, model_ref, ack_wanted, ack_status, draft_wanted, attachments_json, body_truncated,
             received_at, ingested_at, created_at, updated_at)
          VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, direction, message_id_hash) DO NOTHING`,
    args: [
      claimId,
      desk.tenantId,
      body.mailbox,
      body.deliveredTo,
      body.origin,
      keep ? m.messageId : null,
      hash,
      contentHash,
      keep ? m.inReplyTo : null,
      JSON.stringify(keep ? m.references : []),
      keep ? m.from.address : `@${m.from.address.split("@").pop() ?? ""}`,
      JSON.stringify(keep ? m.to : []),
      JSON.stringify(keep ? m.cc : []),
      keep ? m.subject.slice(0, 500) : null,
      plan.ticketId,
      plan.commentId,
      plan.disposition,
      JSON.stringify(plan),
      plan.sender === "verified" ? 1 : 0,
      keep ? JSON.stringify(m.auth) : null,
      m.autoSubmitted ? 1 : 0,
      keep ? m.forwardedBy : null,
      c.isSupportRequest ? 1 : 0,
      c.nonTicketKind,
      c.facet,
      c.urgency,
      c.confidence,
      c.fallback ? 1 : 0,
      c.optOut ? 1 : 0,
      c.modelRef,
      body.ackWanted ? 1 : 0,
      plan.ack,
      plan.draftWanted ? 1 : 0,
      JSON.stringify(keep ? m.attachments.slice(0, 20) : []),
      m.bodyTruncated ? 1 : 0,
      ticketClock(m.receivedAt, now).toISOString(),
      at,
      at,
      at,
    ],
  };
}

// ---------------------------------------------------------------------------
// Carrying out the plan
// ---------------------------------------------------------------------------

function ledgerStatement(desk: SupportDesk, body: IngestBody, plan: IngestPlan, hash: string, customerId: string | null, now: Date): LedgerStatement {
  return emitIfChanged(
    {
      tenantId: desk.tenantId,
      eventKey: MESSAGE_RECEIVED_KEY,
      eventVersion: 1,
      occurredAt: ticketClock(body.message.receivedAt, now),
      subject: { type: "ticket", id: plan.ticketId as string },
      customerId,
      actor: { type: "external", id: null },
      source: "gmail",
      idempotencyKey: `tktmsg:${hash}`,
      confidence: "verified",
      payload: {
        facet: body.classification.facet,
        urgency: body.classification.urgency,
        disposition: plan.disposition,
        sender: plan.sender,
      },
      producer: EMAIL_INTAKE_LEDGER_PRODUCER,
    },
    now,
  );
}

/** OASIS's opt-out list (the one every sender checks), unless the address is already on it. */
function suppressionStatement(address: string): InStatement {
  return {
    sql: `INSERT INTO email_suppressions (email, tenant_id, brand, reason, source)
          SELECT ?, ?, ?, 'unsubscribe', 'support_inbox'
          WHERE NOT EXISTS (SELECT 1 FROM email_suppressions WHERE tenant_id = ? AND lower(email) = ?)`,
    args: [address, OASIS_SUPPRESSION_TENANT_ID, OASIS_SUPPRESSION_BRAND, OASIS_SUPPRESSION_TENANT_ID, address],
  };
}

async function mirrorClient(db: Client, tenantId: string, customerId: string | null) {
  if (!customerId) return null;
  try {
    const r = rows(
      await db.execute({ sql: "SELECT id, display_name, source_lead_id FROM customers WHERE tenant_id = ? AND id = ? LIMIT 1", args: [tenantId, customerId] }),
    )[0];
    return r ? { id: String(r.id), display_name: String(r.display_name ?? ""), source_lead_id: s(r.source_lead_id) } : null;
  } catch (err) {
    if (/no such table: customers\b/i.test(err instanceof Error ? err.message : String(err))) return null;
    throw err;
  }
}

export type IngestResult = {
  claimId: string;
  disposition: Disposition;
  ticket: Ticket | null;
  ack: string;
  draftWanted: boolean;
  duplicate: boolean;
  optOutRecorded: boolean;
  reopened: boolean;
  reason: string | null;
};

type CarriedOut = { completed: true; plan: IngestPlan; ticket: Ticket | null; reopened: boolean } | { completed: false };

/**
 * Write what the plan says. Every write is idempotent on an id the plan
 * holds, so running a plan twice (a retry, a concurrent duplicate) writes it
 * once. A ticket that changed since the plan (closed, or gone) is re-planned
 * on the spot and the new plan stored, so the claim cannot get stuck.
 *
 * COMPARE-AND-SWAP ON THE STORED PLAN. Two attempts can hold one claim (a
 * retry while the first is still running). Replacing the plan and completing
 * the claim each happen only while the claim is incomplete AND still holds
 * the exact plan this attempt read (plan_json). An attempt that loses either
 * answers `completed: false` and writes no plan of its own: the caller reads
 * the claim again and follows the winner's plan, or its answer. So two
 * retries whose ticket closed in between make ONE replacement ticket, and only
 * the attempt that completed the claim tells anyone (the ledger row rides on
 * that completion; the alerts and the acknowledgement follow its answer).
 */
async function carryOut(
  db: Client,
  desk: SupportDesk,
  claimId: string,
  body: IngestBody,
  hash: string,
  planIn: IngestPlan,
  planJsonIn: string,
  now: Date,
): Promise<CarriedOut> {
  const tenantId = desk.tenantId;
  const m = body.message;
  let plan = planIn;
  let planJson = planJsonIn;
  let reopened = false;
  const clock = ticketClock(m.receivedAt, now);

  if (plan.disposition === "appended" && plan.ticketId && plan.commentId) {
    const r = await addTicketComment(
      db,
      tenantId,
      plan.ticketId,
      {
        id: plan.commentId,
        body: ticketText(m),
        is_internal: false,
        author_type: "client",
        author: { userId: null, name: clip(m.from.name || m.from.address, LIMITS.clientName) },
        channel: "email",
      },
      clock,
    );
    if (r.ok) {
      reopened = r.reopened;
    } else {
      // The ticket closed (or vanished) between the plan and now: the email
      // opens a ticket of its own instead. Stored, so a retry does the same,
      // and stored only over the plan this attempt read.
      const replacement = await replanAsNewTicket(db, desk, body, plan, now);
      const replacementJson = JSON.stringify(replacement);
      const swapped = await db.execute({
        sql: "UPDATE support_email_messages SET plan_json = ?, ticket_id = ?, comment_id = ?, disposition = ?, ack_status = ?, draft_wanted = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND completed_at IS NULL AND plan_json = ?",
        args: [
          replacementJson,
          replacement.ticketId,
          replacement.commentId,
          replacement.disposition,
          replacement.ack,
          replacement.draftWanted ? 1 : 0,
          now.toISOString(),
          tenantId,
          claimId,
          planJson,
        ],
      });
      // Another attempt replaced (or finished) this plan first: follow its plan.
      if (swapped.rowsAffected !== 1) return { completed: false };
      plan = replacement;
      planJson = replacementJson;
    }
  }

  if (plan.newTicket && plan.ticketId) {
    const t = plan.newTicket;
    await createTicket(
      db,
      tenantId,
      {
        id: plan.ticketId,
        title: t.title,
        description: ticketText(m),
        category: t.category,
        severity: t.severity,
        source: "email",
        project_id: t.project_id,
        client_tenant_id: t.client_tenant_id,
        client_name: t.client_name,
        client_email: t.client_email,
        client_company: null,
        client_match: t.client_match,
        project_hint: null,
        reporter_user_id: null,
        assigned_to: t.assigned_to,
        customer_id: t.customer_id,
      },
      clock,
    );
  }

  const ticket = await ticketById(db, tenantId, plan.ticketId);
  const at = now.toISOString();
  const stmts: InStatement[] = plan.notes.map((n) => systemNoteStatement(tenantId, n.ticketId, { id: n.id, body: n.body, at: clock.toISOString() }));
  // The completion, over the plan carried out. The ledger row right after it
  // is written only when it changed the claim (emitIfChanged: changes() = 1).
  const completion =
    stmts.push({
      sql: `UPDATE support_email_messages SET ticket_id = ?, comment_id = ?, disposition = ?, completed_at = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND completed_at IS NULL AND plan_json = ?`,
      args: [plan.ticketId, plan.commentId, plan.disposition, at, at, tenantId, claimId, planJson],
    }) - 1;
  const onTicket = plan.disposition === "new_ticket" || plan.disposition === "appended" || plan.disposition === "follow_up";
  if (onTicket && ticket) stmts.push(ledgerStatement(desk, body, plan, hash, ticket.customer_id, now));
  if (plan.suppress) stmts.push(suppressionStatement(m.from.address));
  if ((plan.disposition === "new_ticket" || plan.disposition === "follow_up") && plan.ack !== "scheduled" && plan.ticketId) {
    // Shown on the ticket at once ("not sent: why"), and claimed, so no retry
    // pass ever sends an acknowledgement that was decided against.
    const reason = plan.ack.startsWith("skipped:") ? plan.ack.slice("skipped:".length) : plan.ack;
    stmts.push({
      sql: `UPDATE support_tickets SET client_ack_at = ?, client_ack_status = ?
            WHERE tenant_id = ? AND id = ? AND client_ack_at IS NULL`,
      args: [at, `email: not sent (${reason.replace(/_/g, " ")})`, tenantId, plan.ticketId],
    });
  }
  // The client's Conversations thread: for a ticket linked to a client record only.
  const client = onTicket && ticket ? await mirrorClient(db, tenantId, ticket.customer_id) : null;
  if (client && ticket) {
    stmts.push(
      ...clientEmailMirrorStatements({
        tenantId,
        client,
        direction: "inbound",
        id: claimId,
        provider: "support_inbox",
        providerMessageId: hash,
        at: clock.toISOString(),
        subject: m.subject,
        body: m.bodyText,
        clientEmail: m.from.address,
        deskEmail: body.mailbox,
        actorUserId: null,
        metadata: { ticket_id: ticket.id, support_message_id: claimId },
      }),
    );
  }
  const results = await db.batch(stmts, "write");
  // Another attempt completed the claim (or replaced its plan) first: its
  // answer is the answer, and its after-response work the only one.
  if (results[completion].rowsAffected !== 1) return { completed: false };
  return { completed: true, plan, ticket: await ticketById(db, tenantId, plan.ticketId), reopened };
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

export type IngestDeps = {
  db: Client;
  env: Record<string, string | undefined>;
  now: Date;
  notify?: NotifyDeps;
  schedule?: (task: () => Promise<void>) => void;
};

/** The desk a registered support inbox files into, or null. */
export function deskForMailbox(mailbox: string): SupportDesk | null {
  const tenantId = supportInboxDeskTenant(mailbox);
  if (!tenantId) return null;
  return tenantId === OASIS_DESK.tenantId ? OASIS_DESK : null;
}

function answer(result: IngestResult): Response {
  const t = result.ticket;
  return supportJson(200, {
    ok: true,
    disposition: result.disposition,
    duplicate: result.duplicate,
    ticket: t ? { id: t.id, number: t.ticket_number, status: t.status, severity: t.severity } : null,
    ack: result.ack,
    draft_wanted: result.draftWanted,
    message_record_id: result.claimId,
    opt_out_recorded: result.optOutRecorded,
    ...(result.reason ? { reason: result.reason } : {}),
  });
}

/** Ingest one authenticated, validated message on its desk. Exported for tests and the route. */
export async function ingestSupportMessage(deps: IngestDeps, desk: SupportDesk, body: IngestBody): Promise<{ status: 200; result: IngestResult } | { status: 409; error: string }> {
  const { db, now } = deps;
  const hash = ingestMessageKey(body);
  const contentHash = ingestContentHash(body);

  let claim = await loadClaim(db, desk.tenantId, hash);
  if (!claim) {
    const plan = await planIngest(db, desk, body, now);
    // ON CONFLICT DO NOTHING: a concurrent post of this message may claim it
    // first, and then its claim (and its plan) is the one read back below.
    await db.execute(claimStatement(randomUUID(), desk, body, hash, contentHash, plan, now));
    claim = await loadClaim(db, desk.tenantId, hash);
    if (!claim) throw new Error("email-intake: the claim is not readable after it was written");
  }
  if (claim.content_hash !== contentHash) {
    console.error("[email-intake] one message key, other content", { tenant: desk.tenantId, claim: claim.id });
    return { status: 409, error: "message_id_conflict" };
  }

  // Each lap either finishes this claim or finds that another attempt moved it
  // on (replaced its plan, or completed it) and follows that. A lap is lost
  // only to an attempt that made progress, so a few are plenty.
  for (let lap = 0; lap < CLAIM_LAPS; lap += 1) {
    if (claim.completed_at) {
      // The same answer again: a lost response, a retry, a concurrent duplicate.
      const ticket = await ticketById(db, desk.tenantId, claim.ticket_id);
      return {
        status: 200,
        result: {
          claimId: claim.id,
          disposition: (claim.disposition ?? "not_a_ticket") as Disposition,
          ticket,
          ack: claim.ack_status ?? "skipped:not_a_new_ticket",
          draftWanted: claim.draft_wanted,
          duplicate: true,
          optOutRecorded: !!claim.plan?.suppress,
          reopened: false,
          reason: claim.plan?.reason ?? null,
        },
      };
    }
    if (!claim.plan || !claim.plan_json) throw new Error(`email-intake: claim ${claim.id} has no readable plan`);
    // A claim another attempt planned is carried out with ITS plan.
    const done = await carryOut(db, desk, claim.id, body, hash, claim.plan, claim.plan_json, now);
    if (done.completed) {
      return {
        status: 200,
        result: {
          claimId: claim.id,
          disposition: done.plan.disposition,
          ticket: done.ticket,
          ack: done.plan.ack,
          draftWanted: done.plan.draftWanted,
          duplicate: false,
          optOutRecorded: done.plan.suppress,
          reopened: done.reopened,
          reason: done.plan.reason,
        },
      };
    }
    const moved = await loadClaim(db, desk.tenantId, hash);
    if (!moved) throw new Error(`email-intake: claim ${claim.id} vanished while it was being carried out`);
    claim = moved;
  }
  throw new Error(`email-intake: claim ${claim.id} kept changing under this attempt`);
}

/** The work after the response: who is told, and the acknowledgement. Never throws into the request. */
function afterIngest(deps: IngestDeps, desk: SupportDesk, body: IngestBody, result: IngestResult): void {
  const schedule = deps.schedule ?? scheduleAfterResponse;
  const t = result.ticket;
  if (result.duplicate) return;
  if ((result.disposition === "new_ticket" || result.disposition === "follow_up") && t) {
    schedule(() => runIntakeNotifications(deps.db, desk.tenantId, t.id, deps.notify ?? defaultNotifyDeps(), deps.now));
    return;
  }
  const notify = () => deps.notify ?? defaultNotifyDeps();
  const e = escapeTelegramHtml;
  if (result.disposition === "appended" && t) {
    schedule(async () => {
      const n = notify();
      const r = await n.telegram(
        [
          `<b>Client replied by email on ${e(t.ticket_number)}</b>${result.reopened ? " (ticket reopened)" : ""}`,
          e(body.message.bodyText.trim().slice(0, 600) || "(no text)"),
          e(ticketUrl(n, t.id)),
        ].join("\n"),
      );
      if (!r.ok) console.error("[email-intake.client_replied]", { ticket: t.ticket_number, reason: r.reason });
    });
  } else if (result.disposition === "bounce_noted" && t) {
    schedule(async () => {
      const n = notify();
      const r = await n.telegram(`<b>An email on ${e(t.ticket_number)} bounced</b>\nThe client may not have it. ${e(ticketUrl(n, t.id))}`);
      if (!r.ok) console.error("[email-intake.bounce]", { ticket: t.ticket_number, reason: r.reason });
    });
  } else if (result.disposition === "not_a_ticket" && body.classification.nonTicketKind === "sales_lead") {
    schedule(async () => {
      const n = notify();
      const r = await n.telegram(
        [
          "<b>[HOT-LEAD] A sales enquiry reached support@</b>",
          `From ${e(body.message.from.address)}`,
          e(body.classification.summary.slice(0, 300)),
          "It is not a ticket. It is in support@, unread.",
        ].join("\n"),
      );
      if (!r.ok) console.error("[email-intake.hot_lead]", { reason: r.reason });
    });
  }
}

/**
 * POST /api/internal/support/ingest. The status codes (the reader acts on
 * them, support-ingest-auth.ts):
 *   200  filed (or a repeat of a message already filed: the same answer)
 *   401  bad or missing signature, stale timestamp
 *   409  this message's key arrived before with other content
 *   413  body over 512 KB
 *   422  invalid JSON or body, a mailbox that is not a support inbox, mail
 *        delivered elsewhere
 *   503  not_installed: the secret is unset or migration bravo__200 is missing
 *   500  the database failed; the reader retries, and nothing is written twice
 */
export async function handleSupportIngest(req: Request, deps: IngestDeps): Promise<Response> {
  const auth = await authenticateSupportRequest(req, deps.env, deps.now);
  if (!auth.ok) return auth.response;
  const v = validateIngestBody(auth.body);
  if (!v.ok) return refuse(422, v.error, { field: v.field });
  const body = v.value;
  if (body.origin !== "support_inbox") return refuse(422, "invalid_payload", { field: "origin" });
  const desk = deskForMailbox(body.mailbox);
  if (!desk) return refuse(422, "unknown_mailbox");
  if (isRetiredTenant(desk.tenantId)) return refuse(422, "tenant_retired");
  if (!isAddressOfMailbox(body.deliveredTo, body.mailbox)) return refuse(422, "invalid_payload", { field: "delivered_to" });
  if (!(await supportInboxInstalled(deps.db))) return refuse(503, "not_installed", { detail: "migration bravo__200 is not applied" });

  const out = await ingestSupportMessage(deps, desk, body);
  if (out.status === 409) return refuse(409, out.error);
  afterIngest(deps, desk, body, out.result);
  return answer(out.result);
}

/**
 * Forget non-ticket mail after NON_TICKET_RETENTION_DAYS (its row holds only
 * the key, the sender's domain and what was decided). Run by the SLA cron.
 * A missing table is nothing to purge.
 */
export async function purgeOldNonTicketMessages(db: Client, now: Date): Promise<number> {
  const before = new Date(now.getTime() - NON_TICKET_RETENTION_DAYS * 86_400_000).toISOString();
  try {
    const rs = await db.execute({
      sql: `DELETE FROM support_email_messages
            WHERE direction = 'inbound' AND disposition = 'not_a_ticket' AND ingested_at < ?`,
      args: [before],
    });
    return rs.rowsAffected;
  } catch (err) {
    if (/no such table: support_email_messages\b/i.test(err instanceof Error ? err.message : String(err))) return 0;
    throw err;
  }
}
