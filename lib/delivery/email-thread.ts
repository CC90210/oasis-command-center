/**
 * lib/delivery/email-thread.ts - the support inbox's thread on a ticket: the
 * ids that key a message, the headers a desk email carries so it threads in
 * the client's mail client, and the outbound record that lets a client's
 * answer find its ticket again.
 *
 * support_email_messages (migration bravo__200) holds one row per message in
 * either direction. This module reads it for a ticket and records the desk's
 * own sends; lib/delivery/email-intake.ts writes the inbound rows.
 *
 * A DATABASE WITHOUT THE TABLE is an answer here, not an error: the desk's
 * email keeps going out exactly as before (no threading headers, nothing
 * recorded), so the deploy and the migration can land in either order. Every
 * other failure throws.
 *
 * No "server-only": tests drive it against a local libSQL file.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Client, ResultSet } from "@libsql/client";
import { gmailMessageIdForIdempotencyKey } from "@/lib/integrations/email-delivery-safety";
import { normalizeMessageId } from "@/lib/delivery/rules";

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

export const SUPPORT_MESSAGES_TABLE = "support_email_messages";

/**
 * "The support inbox's schema is not in this database" (migration bravo__200
 * not applied): either table, or the comment channel column.
 */
export function isMissingSupportInboxSchema(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /no such table: (support_email_messages|support_mailbox_status)\b/.test(msg) || /no such column: (\w+\.)?channel\b/.test(msg);
}

/** sha256 of a Message-ID exactly as sent ("<id>", case kept), lowercase hex: the key both sides dedupe on. */
export function messageIdHash(messageId: string): string {
  return createHash("sha256").update(messageId, "utf8").digest("hex");
}

/**
 * The key of a message that carries no Message-ID: sha256 of its receive time,
 * sender, subject and text joined by newlines, over the values the reader
 * sent. The reader keys such a message the same way (BEA mime.synthetic_key),
 * so a retry of it is recognised on both sides.
 */
export function syntheticMessageKey(receivedAt: string, from: string, subject: string, bodyText: string): string {
  return createHash("sha256").update([receivedAt, from, subject, bodyText].join("\n"), "utf8").digest("hex");
}

/**
 * The hashes a set of referenced ids can be stored under: each id as written
 * and lower-cased. The desk's own ids are lower case; a delivery report's copy
 * of them is lower-cased by the reader; a client's ids keep their case.
 */
export function lookupHashes(ids: ReadonlyArray<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const raw of ids) {
    const id = normalizeMessageId(raw);
    if (!id) continue;
    out.add(messageIdHash(id));
    out.add(messageIdHash(id.toLowerCase()));
  }
  return [...out];
}

/** The Message-ID the desk's email with this idempotency key carries (composeOasisMessage). */
export function deskMessageId(idempotencyKey: string): string {
  return gmailMessageIdForIdempotencyKey(idempotencyKey);
}

function parseIds(v: unknown): string[] {
  if (typeof v !== "string" || !v.trim()) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    console.error("[delivery.email_thread] unparseable references_json");
    return [];
  }
}

/** How many ids a desk email's References header carries: the root and the ten newest. */
export const THREAD_REFERENCES = 11;

export type TicketThread = {
  /** The subject of the email that opened the conversation, or null (a form ticket). */
  rootSubject: string | null;
  /** In-Reply-To for the next desk email: the client's latest message, else the desk's own latest. */
  inReplyTo: string | null;
  /** References for the next desk email: the root and the newest ids, oldest first. */
  references: string[];
};

/**
 * The thread facts the next desk email on a ticket needs. Null when the
 * support inbox's table is missing, or the ticket has no recorded message yet
 * (a form or portal ticket before its first recorded email).
 */
export async function loadTicketThread(db: Client, tenantId: string, ticketId: string): Promise<TicketThread | null> {
  let list: Row[];
  try {
    list = rows(
      await db.execute({
        sql: `SELECT direction, message_id, subject, references_json FROM support_email_messages
              WHERE tenant_id = ? AND ticket_id = ? AND message_id IS NOT NULL
              ORDER BY received_at, id
              LIMIT 200`,
        args: [tenantId, ticketId],
      }),
    );
  } catch (err) {
    if (isMissingSupportInboxSchema(err)) return null;
    throw err;
  }
  if (!list.length) return null;
  const firstInbound = list.find((r) => r.direction === "inbound") ?? null;
  const inbound = list.filter((r) => r.direction === "inbound");
  const latestInbound = inbound.length ? s(inbound[inbound.length - 1].message_id) : null;
  const latestAny = s(list[list.length - 1].message_id);
  // The root is what the client's own mail client considers the start: the
  // first id their first message referenced, else that message itself.
  const rootRefs = firstInbound ? parseIds(firstInbound.references_json) : [];
  const ids = [...rootRefs.slice(0, 1), ...list.map((r) => String(r.message_id))];
  const unique = [...new Set(ids)];
  const references = unique.length > THREAD_REFERENCES ? [unique[0], ...unique.slice(-(THREAD_REFERENCES - 1))] : unique;
  return {
    rootSubject: firstInbound ? s(firstInbound.subject) : null,
    inReplyTo: latestInbound ?? latestAny,
    references,
  };
}

export type OutboundRecord = {
  tenantId: string;
  mailbox: string;
  ticketId: string;
  commentId: string | null;
  /** "ack" or "reply". */
  origin: "ack" | "reply";
  idempotencyKey: string;
  to: string;
  subject: string;
  inReplyTo: string | null;
  references: readonly string[];
  at: string;
};

/**
 * Record a desk email that LEFT, so a client's answer to it (which names its
 * Message-ID in In-Reply-To or References) finds this ticket. Idempotent on
 * the Message-ID. A database without the table records nothing (logged by the
 * caller's outcome, never an error: the email itself went out).
 */
export async function recordOutboundMessage(db: Client, r: OutboundRecord): Promise<boolean> {
  const messageId = deskMessageId(r.idempotencyKey);
  try {
    const rs = await db.execute({
      sql: `INSERT INTO support_email_messages
              (id, tenant_id, direction, mailbox, origin, message_id, message_id_hash, in_reply_to, references_json,
               from_address, to_json, subject, ticket_id, comment_id, disposition, received_at, ingested_at, completed_at,
               created_at, updated_at)
            VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id, direction, message_id_hash) DO NOTHING`,
      args: [
        randomUUID(),
        r.tenantId,
        r.mailbox,
        r.origin,
        messageId,
        messageIdHash(messageId),
        r.inReplyTo,
        JSON.stringify([...r.references]),
        r.mailbox,
        JSON.stringify([r.to]),
        r.subject.slice(0, 500),
        r.ticketId,
        r.commentId,
        r.at,
        r.at,
        r.at,
        r.at,
        r.at,
      ],
    });
    return rs.rowsAffected === 1;
  } catch (err) {
    if (isMissingSupportInboxSchema(err)) return false;
    throw err;
  }
}

export type AckFacts = {
  claimId: string;
  /** "scheduled" or "skipped:<reason>", decided once, at ingest. */
  ackStatus: string | null;
  messageId: string | null;
  references: string[];
  subject: string | null;
  /** Who sent that email (lowercased at ingest): the only address its acknowledgement may go to. */
  fromAddress: string | null;
  /** Whether Gmail authenticated that sender (the reader's `aligned`), as recorded at ingest. */
  senderVerified: boolean;
};

/**
 * The email that opened this ticket, as its acknowledgement needs it: whether
 * an acknowledgement was decided at ingest, who sent it and whether that
 * sender was verified, and the ids it threads on. Null when the table is
 * missing or no email opened the ticket.
 */
export async function loadAckFacts(db: Client, tenantId: string, ticketId: string): Promise<AckFacts | null> {
  let r: Row | undefined;
  try {
    r = rows(
      await db.execute({
        sql: `SELECT id, ack_status, message_id, references_json, subject, from_address, sender_verified FROM support_email_messages
              WHERE tenant_id = ? AND ticket_id = ? AND direction = 'inbound' AND disposition IN ('new_ticket', 'follow_up')
              ORDER BY received_at, id LIMIT 1`,
        args: [tenantId, ticketId],
      }),
    )[0];
  } catch (err) {
    if (isMissingSupportInboxSchema(err)) return null;
    throw err;
  }
  if (!r) return null;
  return {
    claimId: String(r.id),
    ackStatus: s(r.ack_status),
    messageId: s(r.message_id),
    references: parseIds(r.references_json),
    subject: s(r.subject),
    fromAddress: s(r.from_address)?.trim().toLowerCase() ?? null,
    senderVerified: Number(r.sender_verified) === 1,
  };
}

/**
 * Has this address PROVEN itself on this ticket: did a verified email (Gmail
 * authenticated its sender, the reader's `aligned`) come from it? A teammate's
 * forward names the client's address from the forwarded text, and an
 * unverified sender's From is only a claim; neither proves who will receive a
 * reply. False when the table is missing: nothing is proven then.
 */
export async function isVerifiedRecipient(db: Client, tenantId: string, ticketId: string, address: string): Promise<boolean> {
  const to = address.trim().toLowerCase();
  if (!to) return false;
  try {
    const rs = await db.execute({
      sql: `SELECT 1 AS ok FROM support_email_messages
            WHERE tenant_id = ? AND ticket_id = ? AND direction = 'inbound' AND sender_verified = 1 AND from_address = ?
            LIMIT 1`,
      args: [tenantId, ticketId, to],
    });
    return rs.rows.length > 0;
  } catch (err) {
    if (isMissingSupportInboxSchema(err)) return false;
    throw err;
  }
}

/** Record what became of an acknowledgement on the message that asked for it. */
export async function recordAckOutcome(db: Client, tenantId: string, claimId: string, status: string, at: string | null): Promise<void> {
  try {
    await db.execute({
      sql: "UPDATE support_email_messages SET ack_status = ?, acked_at = COALESCE(?, acked_at), updated_at = ? WHERE tenant_id = ? AND id = ?",
      args: [status.slice(0, 200), at, new Date().toISOString(), tenantId, claimId],
    });
  } catch (err) {
    if (!isMissingSupportInboxSchema(err)) throw err;
  }
}
