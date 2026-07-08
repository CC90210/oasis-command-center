/**
 * lib/lead-interactions-queries.ts — DB-backed read helpers over the
 * `lead_interactions` table for the Conversations inbox.
 *
 * The PURE grouping logic + the phone normalizer live in
 * lib/conversation-threading.ts (no `server-only`, unit-tested). This module
 * is the thin server-only wrapper: it fetches rows, resolves lead display
 * names, and hands both to groupRowsIntoThreads().
 *
 * Re-exports normalizePhoneE164 + the thread types so the send routes / chat
 * tools have one import path and don't need to know about the split.
 */

import "server-only";
import { getServiceSupabase } from "./supabase-server";
import {
  groupRowsIntoThreads,
  distinctLeadIds,
  normalizePhoneE164,
  type RawInteractionRow,
  type ConversationChannel,
  type ConversationThread,
  type ConversationSource,
  type ThreadStatus,
} from "./conversation-threading";

export { normalizePhoneE164, messageSource } from "./conversation-threading";
export type {
  ConversationThread,
  ConversationMessage,
  ConversationChannel,
  ConversationSource,
  ThreadStatus,
} from "./conversation-threading";

/**
 * Phase 3 spine flag (plan §7/§9). Gates listThreadsFromSpine() + the
 * workflow-ops UI (ListTabs/StatusFilter/unread/snooze/assign) behind
 * `CONVERSATIONS_SPINE=1`. Default OFF — read-time grouping
 * (listThreadsForTenant) stays the permanent fallback and today's behavior
 * is unchanged until the 112 migration is applied AND this flag is flipped
 * in Vercel env. Server-only by construction (this whole module is).
 */
export function conversationsSpineEnabled(): boolean {
  return process.env.CONVERSATIONS_SPINE === "1";
}

/**
 * Dashboard-native opt-out check (2026-06-02, Codex P1 hardening). True when
 * this tenant has an inbound interaction from the number tagged
 * metadata.opt_out_detected — i.e. the contact replied STOP and our TT
 * inbound webhook flagged it. Matched by last-10-digits.
 *
 * IMPORTANT — this is a PARTIAL, defense-in-depth check, not the canonical
 * DNC list. The authoritative CASL suppression list is the CSV the bridge's
 * send_gateway.py / casl_compliance.py manages (data/phone_suppressions.csv),
 * which Vercel functions cannot read. Numbers suppressed via CSV import or
 * the Twilio path are NOT visible here. Full parity requires routing
 * dashboard sends through send_gateway — out of scope for this change. This
 * guard catches the most common case (contact replied STOP through our TT
 * number) on the dashboard's direct-send paths.
 *
 * Best-effort: returns false (does not block) on query error — the dry-run
 * default + the bridge gateway remain the primary safety nets.
 */
export async function isPhoneOptedOut(
  tenantId: string,
  phone: string | null | undefined,
): Promise<boolean> {
  const r = await checkPhoneOptOut(tenantId, phone);
  return r.optedOut;
}

/**
 * Strict variant for DIRECT SEND gates: distinguishes "checked clean" from
 * "check failed". Send paths must FAIL CLOSED on `checkFailed` (block the
 * send), unlike best-effort isPhoneOptedOut above whose false-on-error is
 * relied on by non-send callers. [[fail-closed-default]] (audit 2026-07-01)
 */
export async function checkPhoneOptOut(
  tenantId: string,
  phone: string | null | undefined,
): Promise<{ optedOut: boolean; checkFailed: boolean }> {
  const norm = normalizePhoneE164(phone ?? "");
  if (!tenantId || !norm) return { optedOut: false, checkFailed: false };
  const last10 = norm.replace(/\D/g, "").slice(-10);
  if (last10.length < 10) return { optedOut: false, checkFailed: false };
  try {
    const db = getServiceSupabase();
    const r = await db
      .from("lead_interactions")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("direction", "inbound")
      .filter("metadata->>opt_out_detected", "eq", "true")
      .filter("from_phone", "ilike", `%${last10}%`)
      .limit(1);
    if (r.error) {
      console.error("[lead-interactions-queries] opt-out check errored", r.error.message);
      return { optedOut: false, checkFailed: true };
    }
    return { optedOut: Array.isArray(r.data) && r.data.length > 0, checkFailed: false };
  } catch (err) {
    console.error("[lead-interactions-queries] opt-out check failed", err);
    return { optedOut: false, checkFailed: true };
  }
}

/**
 * Email opt-out re-check for dashboard DIRECT-SEND paths that bypass
 * send_gateway's own suppression (operator-Gmail, transactional relays).
 * FAIL CLOSED: send paths must block on `checkFailed`. Mirrors the inline
 * pattern in lib/forms/next-steps-email.ts. [[fail-closed-default]]
 */
export async function checkEmailSuppressed(
  tenantId: string,
  email: string | null | undefined,
): Promise<{ suppressed: boolean; checkFailed: boolean }> {
  const addr = String(email ?? "").trim().toLowerCase();
  if (!tenantId || !addr) return { suppressed: false, checkFailed: false };
  // Escape LIKE wildcards — `_`/`%` are valid in an email local-part.
  const pattern = addr.replace(/[%_\\]/g, "\\$&");
  try {
    const r = await getServiceSupabase()
      .from("email_suppressions")
      .select("email")
      .eq("tenant_id", tenantId)
      .ilike("email", pattern)
      .limit(1);
    if (r.error) {
      console.error("[lead-interactions-queries] email suppression check errored", r.error.message);
      return { suppressed: false, checkFailed: true };
    }
    return { suppressed: (r.data?.length ?? 0) > 0, checkFailed: false };
  } catch (err) {
    console.error("[lead-interactions-queries] email suppression check failed", err);
    return { suppressed: false, checkFailed: true };
  }
}

// Must match the columns migration 093 added so call rows render with
// recording/transcript/disposition just like the lead timeline.
const INTERACTION_COLUMNS =
  "id, channel, direction, type, subject, content_preview, created_at, " +
  "sent_at, from_phone, to_phone, to_email, agent_source, metadata, recording_url, " +
  "transcript_url, disposition, call_outcome, call_duration_sec, " +
  "kixie_call_id, lead_id, actor_user_id";

/**
 * Resolve display names for the given lead_ids in one batched tenant_records
 * query. Best-effort — a failure just leaves labels as the contact phone.
 */
async function resolveLeadLabels(
  db: ReturnType<typeof getServiceSupabase>,
  tenantId: string,
  leadIds: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (leadIds.length === 0) return out;
  try {
    const r = await db
      .from("tenant_records")
      .select("id,data")
      .eq("tenant_id", tenantId)
      .in("id", leadIds);
    for (const row of (r.data || []) as Array<{ id: string; data: Record<string, unknown> }>) {
      const d = row.data || {};
      const name =
        (typeof d.name === "string" && d.name) ||
        (typeof d.business_name === "string" && d.business_name) ||
        (typeof d.company === "string" && d.company) ||
        [d.first_name, d.last_name].filter((x) => typeof x === "string" && x).join(" ").trim() ||
        "";
      if (name) out[row.id] = name;
    }
  } catch (err) {
    console.error("[lead-interactions-queries] label lookup failed", err);
  }
  return out;
}

/**
 * Build the contact-threaded inbox for a tenant. Loads the most recent
 * `limit` interaction rows (default 400), resolves lead names, and groups
 * them. Resilient: returns [] on query failure rather than throwing, so a
 * transient DB error renders an empty inbox instead of 500-ing the page.
 */
export async function listThreadsForTenant(
  tenantId: string | null,
  opts: { channel?: ConversationChannel | "all"; limit?: number } = {},
): Promise<ConversationThread[]> {
  if (!tenantId) return [];
  const db = getServiceSupabase();
  const limit = Math.max(50, Math.min(opts.limit ?? 400, 1000));

  let rows: RawInteractionRow[] = [];
  try {
    let query = db
      .from("lead_interactions")
      .select(INTERACTION_COLUMNS)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (opts.channel && opts.channel !== "all") {
      query = query.eq("channel", opts.channel);
    }
    const { data, error } = await query;
    if (error) throw error;
    rows = (data || []) as unknown as RawInteractionRow[];
  } catch (err) {
    console.error("[lead-interactions-queries] listThreadsForTenant failed", err);
    return [];
  }

  const labels = await resolveLeadLabels(db, tenantId, distinctLeadIds(rows));
  return groupRowsIntoThreads(rows, labels);
}

const SPINE_THREAD_COLUMNS =
  "thread_key, lead_id, contact_phone_e164, contact_email, contact_label, " +
  "owner_agent_id, assigned_to, status, last_message_at, last_direction, " +
  "last_preview, unread_count, sources, snoozed_until";

type SpineThreadRow = {
  thread_key: string;
  lead_id: string | null;
  contact_phone_e164: string | null;
  contact_email: string | null;
  contact_label: string | null;
  owner_agent_id: string | null;
  assigned_to: string | null;
  status: string | null;
  last_message_at: string | null;
  last_direction: string | null;
  last_preview: string | null;
  unread_count: number | null;
  sources: string[] | null;
  snoozed_until: string | null;
};

const VALID_SOURCES: ConversationSource[] = ["texttorrent", "twilio", "kixie", "email", "other"];

/** Derive the channel-icon list ConversationRow renders from the spine's
 *  coarser `sources` array (channel-level granularity isn't tracked on the
 *  thread row — only per-message, which isn't loaded until lazy-fetch). */
function sourcesToChannels(sources: ConversationSource[]): string[] {
  const out: string[] = [];
  for (const s of sources) {
    const ch = s === "email" ? "email" : s === "kixie" ? "phone" : "sms";
    if (!out.includes(ch)) out.push(ch);
  }
  return out;
}

function spineRowToThread(row: SpineThreadRow, labels: Record<string, string>): ConversationThread {
  const sources = (row.sources || []).filter((s): s is ConversationSource =>
    (VALID_SOURCES as string[]).includes(s),
  );
  const contactLabel =
    (row.lead_id && labels[row.lead_id]) ||
    row.contact_label ||
    row.contact_phone_e164 ||
    row.contact_email ||
    "Unknown contact";
  return {
    key: row.thread_key,
    lead_id: row.lead_id,
    contact_label: contactLabel,
    contact_phone: row.contact_phone_e164,
    contact_email: row.contact_email,
    channels: sourcesToChannels(sources),
    sources,
    last_at: row.last_message_at || new Date(0).toISOString(),
    last_preview: row.last_preview || "",
    last_direction: row.last_direction || "outbound",
    // Not tracked at spine granularity (would need a per-message count);
    // unused by any component today (ConversationRow reads unread_count).
    inbound_count: 0,
    tt_chat_id: null, // populated client-side once messages lazy-load
    messages: [],
    status: (row.status as ThreadStatus | null) || "open",
    assigned_to: row.assigned_to,
    owner_agent_id: row.owner_agent_id,
    unread_count: row.unread_count ?? 0,
    snoozed_until: row.snoozed_until,
    messages_loaded: false,
  };
}

/**
 * Phase 3 read layer (plan §7) — persistent-spine equivalent of
 * listThreadsForTenant(), querying `conversation_threads` (maintained by the
 * `conv_thread_upsert` trigger in database/112_conversations_spine.sql)
 * instead of re-grouping lead_interactions at read-time. SQL-side
 * status/assignment/unread filters + real pagination (no 400-row cap) — the
 * things the read-time path structurally can't do server-side.
 *
 * Returns the SAME ConversationThread shape as listThreadsForTenant, with
 * `messages: []` / `messages_loaded: false` — the caller lazy-loads a
 * selected thread's messages via GET /api/conversations/threads/[key].
 * `[]`-on-failure, same as the read-time path — a spine query error must
 * never 500 the page; it just renders an empty inbox for that render.
 */
export async function listThreadsFromSpine(
  tenantId: string | null,
  opts: {
    status?: ThreadStatus | "all";
    /** A user auth_user_id (lowercased), "unassigned", or "all"/undefined. */
    assignedTo?: string | "unassigned" | "all";
    unreadOnly?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): Promise<ConversationThread[]> {
  if (!tenantId) return [];
  const db = getServiceSupabase();
  const limit = Math.max(1, Math.min(opts.limit ?? 400, 2000));
  const offset = Math.max(0, opts.offset ?? 0);

  try {
    let query = db
      .from("conversation_threads")
      .select(SPINE_THREAD_COLUMNS)
      .eq("tenant_id", tenantId)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1);
    if (opts.status && opts.status !== "all") query = query.eq("status", opts.status);
    if (opts.assignedTo === "unassigned") query = query.is("assigned_to", null);
    else if (opts.assignedTo && opts.assignedTo !== "all") {
      query = query.eq("assigned_to", opts.assignedTo.toLowerCase());
    }
    if (opts.unreadOnly) query = query.gt("unread_count", 0);

    const { data, error } = await query;
    if (error) throw error;
    const rows = (data || []) as unknown as SpineThreadRow[];
    const leadIds = Array.from(new Set(rows.map((r) => r.lead_id).filter((x): x is string => !!x)));
    const labels = await resolveLeadLabels(db, tenantId, leadIds);
    return rows.map((r) => spineRowToThread(r, labels));
  } catch (err) {
    console.error("[lead-interactions-queries] listThreadsFromSpine failed", err);
    return [];
  }
}

/** Parsed form of a `ConversationThread.key` (see conversation-threading.ts
 *  groupKey — lead:<uuid> | phone:<E164> | email:<addr> | id:<uuid>). */
export type ThreadKeyParts =
  | { kind: "lead"; leadId: string }
  | { kind: "phone"; phone: string }
  | { kind: "email"; email: string }
  | { kind: "id"; id: string };

export function parseThreadKey(key: string): ThreadKeyParts | null {
  if (!key) return null;
  if (key.startsWith("lead:")) return { kind: "lead", leadId: key.slice(5) };
  if (key.startsWith("phone:")) return { kind: "phone", phone: key.slice(6) };
  if (key.startsWith("email:")) return { kind: "email", email: key.slice(6) };
  if (key.startsWith("id:")) return { kind: "id", id: key.slice(3) };
  return null;
}

/**
 * Server-side, per-thread message load for the AI routes (summarize,
 * voice-suggest). Callers MUST NOT trust a client-supplied transcript —
 * this re-queries `lead_interactions` scoped to `tenantId` + the specific
 * thread key, so a forged/stale client payload can never smuggle another
 * tenant's or another thread's messages into a prompt.
 *
 * Mirrors groupRowsIntoThreads' groupKey exactly: phone/email keys only
 * apply to rows with no lead_id (a lead_id always wins the "lead:" key), so
 * those branches filter `.is("lead_id", null)` to avoid pulling in messages
 * that actually belong to a different lead-linked thread.
 *
 * Returns null on no match / query failure — callers fall back to the
 * deterministic "summary unavailable" / neutral-voice path, never throw.
 */
/**
 * Shared row-fetch for a single thread key, used by both loadThreadForAi
 * (small, token-bounded window for the AI routes) and loadThreadMessages
 * (fuller window for lazy-loading a selected thread's message list under
 * the Phase 3 spine). Same tenant-scoping + groupKey mirroring as before —
 * factored out so the two callers can't drift on that logic.
 */
async function queryThreadRows(
  db: ReturnType<typeof getServiceSupabase>,
  tenantId: string,
  parts: ThreadKeyParts,
  limit: number,
): Promise<RawInteractionRow[] | null> {
  let query = db
    .from("lead_interactions")
    .select(INTERACTION_COLUMNS)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (parts.kind === "lead") {
    if (!/^[0-9a-f-]{36}$/i.test(parts.leadId)) return null;
    query = query.eq("lead_id", parts.leadId);
  } else if (parts.kind === "phone") {
    const last10 = parts.phone.replace(/\D/g, "").slice(-10);
    if (last10.length < 10) return null;
    query = query.is("lead_id", null).or(`from_phone.ilike.%${last10}%,to_phone.ilike.%${last10}%`);
  } else if (parts.kind === "email") {
    const pattern = parts.email.trim().toLowerCase().replace(/[%_\\]/g, "\\$&");
    if (!pattern) return null;
    query = query.is("lead_id", null).ilike("to_email", pattern);
  } else {
    if (!/^[0-9a-f-]{36}$/i.test(parts.id)) return null;
    query = query.eq("id", parts.id);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as unknown as RawInteractionRow[];
}

export async function loadThreadForAi(
  tenantId: string | null,
  threadKey: string,
  opts: { limit?: number } = {},
): Promise<ConversationThread | null> {
  if (!tenantId) return null;
  const parts = parseThreadKey(threadKey);
  if (!parts) return null;
  const db = getServiceSupabase();
  const limit = Math.max(5, Math.min(opts.limit ?? 30, 100));

  try {
    const rows = await queryThreadRows(db, tenantId, parts, limit);
    if (!rows || rows.length === 0) return null;

    const labels = await resolveLeadLabels(db, tenantId, distinctLeadIds(rows));
    const threads = groupRowsIntoThreads(rows, labels);
    // All rows queried above share the same group key by construction, so
    // this yields exactly one thread (or occasionally the same key split
    // across a lead-id vs id: fallback for orphan rows — first is correct).
    return threads[0] ?? null;
  } catch (err) {
    console.error("[lead-interactions-queries] loadThreadForAi failed", err);
    return null;
  }
}

/**
 * Phase 3 lazy-load (plan §7 "lazy-load messages per selected thread") —
 * fuller message window than loadThreadForAi (which is deliberately capped
 * small to bound the AI routes' token usage). Used by GET
 * /api/conversations/threads/[key] to hydrate a spine-listed thread (which
 * carries no messages) once the operator selects it. `[]`/null on failure —
 * callers render an empty thread pane rather than erroring.
 */
export async function loadThreadMessages(
  tenantId: string | null,
  threadKey: string,
  opts: { limit?: number } = {},
): Promise<ConversationThread | null> {
  if (!tenantId) return null;
  const parts = parseThreadKey(threadKey);
  if (!parts) return null;
  const db = getServiceSupabase();
  const limit = Math.max(10, Math.min(opts.limit ?? 500, 1000));

  try {
    const rows = await queryThreadRows(db, tenantId, parts, limit);
    if (!rows || rows.length === 0) return null;

    const labels = await resolveLeadLabels(db, tenantId, distinctLeadIds(rows));
    const threads = groupRowsIntoThreads(rows, labels);
    return threads[0] ?? null;
  } catch (err) {
    console.error("[lead-interactions-queries] loadThreadMessages failed", err);
    return null;
  }
}
