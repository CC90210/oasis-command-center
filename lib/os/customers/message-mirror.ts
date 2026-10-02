/**
 * lib/os/customers/message-mirror.ts - one email in a client's Conversations
 * thread, from outside the composer: the support inbox's messages
 * (lib/delivery/email-intake.ts, inbound) and the desk's approved replies
 * (lib/os/approvals/executors.ts reply_ticket, outbound).
 *
 * The thread is read from lead_interactions (lib/os/customers/conversations.ts
 * loadClientConversation): a row stamped with the client's id
 * (metadata.customer_id) is in their thread. Turso has no thread trigger, so
 * the writer also creates or advances the conversation_threads row, as the
 * composer does (conversations.ts messageStatements).
 *
 * ONLY FOR A TICKET LINKED TO A CLIENT RECORD: the caller passes the client.
 * An email from anyone else stays on its ticket and nowhere else (the privacy
 * gate lib/agents/operator-email/ingest.ts keeps for mail).
 *
 * IDEMPOTENT. The row is keyed by (provider, provider_message_id), the unique
 * index lead_interactions already carries: the same email mirrored twice (a
 * retried ingest) inserts nothing, and the thread row is advanced only by the
 * insert that landed (changes() = 1).
 *
 * Statements only: the caller runs them in its own batch.
 */
import { randomUUID } from "node:crypto";
import type { InStatement } from "@libsql/client";

export type MirrorClient = {
  id: string;
  display_name: string;
  source_lead_id: string | null;
};

export type MirrorMessage = {
  tenantId: string;
  client: MirrorClient;
  direction: "inbound" | "outbound";
  /** The lead_interactions row id. */
  id: string;
  /** Unique per message within `provider`: the dedupe key. */
  provider: string;
  providerMessageId: string;
  at: string;
  subject: string;
  body: string;
  /** The client's address: the sender of an inbound email, the recipient of an outbound one. */
  clientEmail: string;
  /** The desk's address on the other side. */
  deskEmail: string;
  actorUserId: string | null;
  /** Ids only: the ticket, the support message, the approval. Never a body. */
  metadata: Record<string, string | null>;
};

/** The thread key: the deal the client came from, else their address (conversations.ts threadKeyFor). */
export function mirrorThreadKey(client: MirrorClient, clientEmail: string): string {
  return client.source_lead_id ? `lead:${client.source_lead_id}` : `email:${clientEmail}`;
}

export function clientEmailMirrorStatements(m: MirrorMessage): InStatement[] {
  const inbound = m.direction === "inbound";
  const preview = m.body.slice(0, 1024);
  const metadata = JSON.stringify({ ...m.metadata, customer_id: m.client.id });
  const key = mirrorThreadKey(m.client, m.clientEmail);
  return [
    {
      sql: `INSERT INTO lead_interactions
              (id, tenant_id, lead_id, type, channel, direction, agent_source, subject, content, content_preview,
               to_email, from_email, sent_at, actor_user_id, provider, provider_message_id, metadata, created_at)
            VALUES (?, ?, ?, ?, 'email', ?, 'support_desk', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING`,
      args: [
        m.id,
        m.tenantId,
        m.client.source_lead_id,
        inbound ? "email_received" : "email_sent",
        m.direction,
        m.subject.slice(0, 500),
        m.body,
        preview,
        inbound ? m.deskEmail : m.clientEmail,
        inbound ? m.clientEmail : m.deskEmail,
        m.at,
        m.actorUserId,
        m.provider,
        m.providerMessageId,
        metadata,
        m.at,
      ],
    },
    {
      // Advanced only by the insert above that landed (it immediately precedes this).
      sql: `INSERT INTO conversation_threads
              (id, tenant_id, thread_key, lead_id, contact_email, contact_label, status, last_message_at,
               last_inbound_at, last_outbound_at, last_direction, last_preview, unread_count, channel_summary, sources,
               created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{"email":true}', '["email"]', ?, ?
            WHERE changes() = 1
            ON CONFLICT (tenant_id, thread_key) DO UPDATE SET
              last_message_at = CASE WHEN last_message_at IS NULL OR excluded.last_message_at > last_message_at
                                     THEN excluded.last_message_at ELSE last_message_at END,
              last_inbound_at = COALESCE(excluded.last_inbound_at, last_inbound_at),
              last_outbound_at = COALESCE(excluded.last_outbound_at, last_outbound_at),
              last_direction = CASE WHEN last_message_at IS NULL OR excluded.last_message_at >= last_message_at
                                    THEN excluded.last_direction ELSE last_direction END,
              last_preview = CASE WHEN last_message_at IS NULL OR excluded.last_message_at >= last_message_at
                                  THEN excluded.last_preview ELSE last_preview END,
              unread_count = unread_count + excluded.unread_count,
              status = CASE
                         WHEN excluded.last_direction = 'inbound' AND status IN ('open', 'waiting_on_client', 'closed') THEN 'needs_reply'
                         WHEN excluded.last_direction = 'outbound' AND status = 'needs_reply' THEN 'waiting_on_client'
                         ELSE status END,
              contact_email = COALESCE(contact_email, excluded.contact_email),
              updated_at = excluded.updated_at`,
      args: [
        randomUUID(),
        m.tenantId,
        key,
        m.client.source_lead_id,
        m.clientEmail,
        m.client.display_name,
        inbound ? "needs_reply" : "open",
        m.at,
        inbound ? m.at : null,
        inbound ? null : m.at,
        m.direction,
        preview.slice(0, 280),
        inbound ? 1 : 0,
        m.at,
        m.at,
      ],
    },
  ];
}
