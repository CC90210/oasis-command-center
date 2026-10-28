/**
 * Supabase-backed agent inbox. Replaces filesystem JSON files
 * (tmp/agent_inbox/inbox/*) as the source of truth — multi-machine,
 * tenant-scoped, RLS-protected. The filesystem path stays as a
 * secondary mirror so local agents posting via scripts/agent_inbox.py
 * keep working while we migrate.
 *
 * Read-side: list / count unread / get-by-id.
 * Write-side: post / mark-read.
 *
 * Both server-only (use service Supabase client). The /api/inbox/*
 * route handlers are the only callers.
 */

import { getServiceSupabase } from "./supabase-server";
import { getTursoClient } from "./turso";
import { randomBytes } from "node:crypto";
import { VALID_PRIORITIES, KNOWN_AGENTS, type Priority } from "./agent-inbox-types";

// Re-export so existing call sites importing from this file keep working.
export { VALID_PRIORITIES, KNOWN_AGENTS };
export type { Priority };

export type DbInboxMessage = {
  id: string;
  message_id: string;
  tenant_id: string;
  from_agent: string;
  to_agent: string;
  subject: string | null;
  body: string;
  priority: Priority;
  requires_response: boolean;
  in_reply_to: string | null;
  thread_id: string | null;
  read_at: string | null;
  created_at: string;
  /** 1 = the agents owner's computer may deliver it to the agent's local inbox (bravo__246). */
  relay_eligible?: number | boolean | null;
  delivered_at?: string | null;
  delivered_pairing_id?: string | null;
  delivered_label?: string | null;
  acked_at?: string | null;
  read_via?: ReadVia | null;
  /** When delivered_pairing_id reserved it for delivery (bravo__247). */
  relay_claimed_at?: string | null;
};

/** Who marked a note read (bravo__246 read_via). */
export const READ_VIA = ["dashboard", "cloud_chat", "agent"] as const;
export type ReadVia = (typeof READ_VIA)[number];

/**
 * The agents a paired computer can deliver to: each has a local inbox it reads
 * at the start of every session (scripts/core/agent_inbox.py in its repo on the
 * agents owner's computer). `broadcast` reaches all three. Aura has no reader
 * yet, so a note to Aura is never relayed.
 */
export const RELAY_RECIPIENTS = ["bravo", "atlas", "maven", "broadcast"] as const;

export function isRelayRecipient(agent: string): boolean {
  return (RELAY_RECIPIENTS as readonly string[]).includes(agent.trim().toLowerCase());
}

/** One relay batch at most: a computer that has been away catches up in a few minutes, not one request. */
export const RELAY_BATCH_MAX = 20;

/** A reservation with no delivery after this long may be taken by another computer (the first stopped partway). */
export const RELAY_RESERVATION_MS = 5 * 60 * 1000;

const PRIORITY_RANK: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export async function listUnreadDb(tenantId: string, toAgent?: string): Promise<DbInboxMessage[]> {
  const db = getServiceSupabase();
  let q = db
    .from("agent_messages")
    .select("*")
    .eq("tenant_id", tenantId)
    .is("read_at", null);
  if (toAgent) q = q.eq("to_agent", toAgent);
  const { data, error } = await q
    .order("priority", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(200);
  // Fail loud (2026-09-30): a failed read is not an empty inbox. /inbox shows
  // "Couldn't check"; the chat's inbox injection already catches and goes on.
  if (error) throw new Error(`agent_messages unread read failed: ${error.message}`);
  const rows = (data || []) as DbInboxMessage[];
  // Postgres orders alphabetically; we want urgent → low. Re-sort client-side
  // by the rank map so 'urgent' lands above 'high' etc.
  rows.sort((a, b) => {
    const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (p !== 0) return p;
    return b.created_at.localeCompare(a.created_at);
  });
  return rows;
}

export async function listReadDb(tenantId: string, toAgent?: string, limit = 50): Promise<DbInboxMessage[]> {
  const db = getServiceSupabase();
  let q = db
    .from("agent_messages")
    .select("*")
    .eq("tenant_id", tenantId)
    .not("read_at", "is", null);
  if (toAgent) q = q.eq("to_agent", toAgent);
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`agent_messages read-archive read failed: ${error.message}`);
  return (data || []) as DbInboxMessage[];
}

export async function unreadCountDb(tenantId: string, toAgent?: string): Promise<number> {
  const db = getServiceSupabase();
  let q = db
    .from("agent_messages")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .is("read_at", null);
  if (toAgent) q = q.eq("to_agent", toAgent);
  const { count } = await q;
  return count ?? 0;
}

export async function markReadDb(
  tenantId: string,
  id: string,
  via: ReadVia = "dashboard",
): Promise<{ ok: boolean; error?: string }> {
  if (!id) return { ok: false, error: "missing_id" };
  const db = getServiceSupabase();
  const { error } = await db
    .from("agent_messages")
    .update({ read_at: new Date().toISOString(), read_via: via })
    .eq("tenant_id", tenantId)
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Reserve, for `pairingId`, the directives waiting for delivery and return them,
 * oldest first: relay eligible, not delivered, not read, and not reserved by
 * another computer in the last RELAY_RESERVATION_MS (Codex review of #768: two
 * computers polling at once both received the same directives, and the local
 * write happens before the delivery report). ONE statement, so two computers
 * never both win a note; a computer that stopped partway loses its reservation
 * after five minutes. Throws on a failed write (it is not "nothing to deliver").
 */
export async function reserveRelayBatchDb(
  tenantId: string,
  pairingId: string,
  now: number = Date.now(),
): Promise<DbInboxMessage[]> {
  const nowIso = new Date(now).toISOString();
  const staleIso = new Date(now - RELAY_RESERVATION_MS).toISOString();
  const open =
    "relay_eligible = 1 AND delivered_at IS NULL AND read_at IS NULL " +
    "AND (delivered_pairing_id IS NULL OR delivered_pairing_id = ? OR relay_claimed_at IS NULL OR relay_claimed_at < ?)";
  try {
    const rs = await getTursoClient().execute({
      sql:
        `UPDATE agent_messages SET delivered_pairing_id = ?, relay_claimed_at = ? ` +
        `WHERE tenant_id = ? AND ${open} AND id IN (` +
        `SELECT id FROM agent_messages WHERE tenant_id = ? AND ${open} ORDER BY created_at ASC LIMIT ${RELAY_BATCH_MAX}` +
        `) RETURNING *`,
      args: [pairingId, nowIso, tenantId, pairingId, staleIso, tenantId, pairingId, staleIso],
    });
    const rows = rs.rows.map((row) => ({ ...(row as unknown as DbInboxMessage) }));
    return rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  } catch (err) {
    throw new Error(`agent_messages relay reservation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Record that `pairing` wrote these notes into their agents' local inboxes.
 * Only the computer that reserved a note may report it delivered, once; only
 * the ids THIS call stamped are returned.
 */
export async function markDeliveredDb(
  tenantId: string,
  ids: readonly string[],
  pairing: { id: string; label: string },
): Promise<string[]> {
  if (ids.length === 0) return [];
  const { data, error } = await getServiceSupabase()
    .from("agent_messages")
    .update({
      delivered_at: new Date().toISOString(),
      delivered_pairing_id: pairing.id,
      delivered_label: pairing.label.slice(0, 80),
    })
    .eq("tenant_id", tenantId)
    .in("id", [...ids])
    .eq("relay_eligible", 1)
    .eq("delivered_pairing_id", pairing.id)
    .is("delivered_at", null)
    .select("id");
  if (error) throw new Error(`agent_messages delivery write failed: ${error.message}`);
  return ((data || []) as Array<{ id: string }>).map((row) => row.id);
}

/**
 * Record that the agent moved these notes to its read/ folder. Only the
 * computer that delivered a note may say it was read, and only once.
 */
export async function markAckedDb(tenantId: string, ids: readonly string[], pairingId: string): Promise<string[]> {
  if (ids.length === 0) return [];
  const now = new Date().toISOString();
  const { data, error } = await getServiceSupabase()
    .from("agent_messages")
    .update({ acked_at: now, read_at: now, read_via: "agent" })
    .eq("tenant_id", tenantId)
    .in("id", [...ids])
    .eq("delivered_pairing_id", pairingId)
    .is("acked_at", null)
    .is("read_at", null)
    .select("id");
  if (error) throw new Error(`agent_messages acknowledgement write failed: ${error.message}`);
  return ((data || []) as Array<{ id: string }>).map((row) => row.id);
}

/** Every note in the workspace, newest first, for Admin > Agent ops. Throws on a failed read. */
export async function listAgentOpsMessagesDb(tenantId: string, limit = 100): Promise<DbInboxMessage[]> {
  const { data, error } = await getServiceSupabase()
    .from("agent_messages")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(200, limit)));
  if (error) throw new Error(`agent_messages agent-ops read failed: ${error.message}`);
  return (data || []) as DbInboxMessage[];
}

export async function postMessageDb(opts: {
  tenantId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  priority?: Priority;
  requires_response?: boolean;
  in_reply_to?: string | null;
  /**
   * Optional pre-generated message_id. When the route does dual-write
   * (Supabase + filesystem), it passes the SAME id to both writers so the
   * /inbox page can dedupe rows from the two sources by message_id.
   */
  messageId?: string;
  /**
   * A directive the operator posted from the dashboard, to an agent with a
   * local reader (isRelayRecipient): the agents owner's computer delivers it.
   * Never set for a note an agent wrote: an agent's words do not travel to
   * another agent's machine on their own.
   */
  relayEligible?: boolean;
}): Promise<{ ok: boolean; message?: DbInboxMessage; error?: string }> {
  if (!opts.body || !opts.body.trim()) return { ok: false, error: "body_required" };
  if (!opts.from.trim() || !opts.to.trim()) return { ok: false, error: "agent_required" };
  const priority: Priority = opts.priority || "normal";
  if (!VALID_PRIORITIES.includes(priority)) return { ok: false, error: "invalid_priority" };

  const db = getServiceSupabase();
  const messageId = opts.messageId || randomBytes(6).toString("hex");
  const row = {
    message_id: messageId,
    tenant_id: opts.tenantId,
    from_agent: opts.from.trim().toLowerCase(),
    to_agent: opts.to.trim().toLowerCase(),
    subject: opts.subject?.trim() || null,
    body: opts.body.trim(),
    priority,
    requires_response: !!opts.requires_response,
    in_reply_to: opts.in_reply_to || null,
    thread_id: opts.in_reply_to || messageId,
    relay_eligible: opts.relayEligible && isRelayRecipient(opts.to) ? 1 : 0,
  };
  const { data, error } = await db
    .from("agent_messages")
    .insert(row)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, message: data as DbInboxMessage };
}

/**
 * Convert a DB row to the shape the existing UI expects (the InboxMessage
 * type from agent-inbox-fs.ts). Lets us drop in Supabase-backed reads
 * without touching the rendering components.
 */
export function dbToUiShape(row: DbInboxMessage) {
  return {
    message_id: row.message_id,
    from: row.from_agent,
    to: row.to_agent,
    timestamp: row.created_at,
    subject: row.subject || "",
    body: row.body,
    priority: row.priority,
    requires_response: row.requires_response,
    in_reply_to: row.in_reply_to,
    thread_id: row.thread_id || row.message_id,
    _filename: row.id,
    _read: !!row.read_at,
  };
}
