/**
 * lib/conversation-threading.ts — PURE conversation-threading logic.
 *
 * No DB, no `server-only` — so the grouping is unit-testable in plain tsx
 * (see tests/conversations-grouping.test.ts) and importable from anywhere.
 * The DB-backed wrapper lives in lib/lead-interactions-queries.ts, which
 * fetches rows + resolves lead labels and then calls groupRowsIntoThreads().
 */

/**
 * Canonical E.164 normalizer — single source of truth, re-exported by
 * lib/lead-interactions-queries.ts for the send routes + chat tools.
 */
export function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, "");
  if (raw.trim().startsWith("+") && digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

export type ConversationChannel = "sms" | "phone" | "email";

/**
 * The PLATFORM a message came in on — the dimension the inbox sections by
 * (Text Torrent / Email / Twilio / Kixie). Distinct from `channel` (sms/phone/
 * email): Text Torrent and Twilio are both `sms`, Kixie is `phone`+sms, etc.
 * Derived from agent_source + channel + metadata.provider via messageSource().
 */
export type ConversationSource = "texttorrent" | "twilio" | "kixie" | "email" | "other";

/**
 * Phase 3 spine — mirrors conversation_threads.status (database/112_
 * conversations_spine.sql `conv_thread_upsert()`). Only meaningful on a
 * thread loaded via listThreadsFromSpine(); the read-time grouping path
 * (groupRowsIntoThreads below) leaves this undefined rather than fabricate
 * an approximation, so the UI can gate real filtering on its presence.
 */
export type ThreadStatus = "open" | "needs_reply" | "waiting_on_client" | "closed" | "snoozed" | "triage";

export type ConversationMessage = {
  id: string;
  channel: string; // sms | phone | email | note
  source: ConversationSource;
  direction: string; // inbound | outbound
  type: string | null;
  subject: string | null;
  preview: string;
  at: string; // ISO 8601
  recording_url: string | null;
  transcript_url: string | null;
  disposition: string | null;
  call_outcome: string | null;
  call_duration_sec: number | null;
};

export type ConversationThread = {
  /** Stable grouping key: lead:<uuid> | phone:<E164> | email:<addr> | id:<uuid>. */
  key: string;
  lead_id: string | null;
  contact_label: string;
  contact_phone: string | null;
  contact_email: string | null;
  channels: string[];
  /** Distinct platforms this thread has messages on (for the inbox sections). */
  sources: ConversationSource[];
  last_at: string;
  last_preview: string;
  last_direction: string;
  inbound_count: number;
  tt_chat_id: string | null;
  messages: ConversationMessage[];
  /**
   * Phase 3 spine fields (database/112_conversations_spine.sql). Populated
   * ONLY by listThreadsFromSpine() in lib/lead-interactions-queries.ts;
   * left undefined by groupRowsIntoThreads() (the permanent read-time
   * fallback) so callers can tell "no spine data" from "spine says zero/
   * unset" and gate live filtering/unread/assign UI on CONVERSATIONS_SPINE.
   */
  status?: ThreadStatus;
  assigned_to?: string | null;
  owner_agent_id?: string | null;
  unread_count?: number;
  snoozed_until?: string | null;
  /** True when this thread's messages haven't been lazy-loaded yet (spine
   *  mode only — the spine list query returns thread metadata without
   *  messages; ThreadPane fetches them on select via GET
   *  /api/conversations/threads/[key]). Always false/absent on the
   *  read-time-grouping path, which loads messages eagerly. */
  messages_loaded?: boolean;
};

/** Raw lead_interactions row shape consumed by the grouper. */
export type RawInteractionRow = {
  id: string;
  channel: string | null;
  direction: string | null;
  type: string | null;
  subject: string | null;
  content_preview: string | null;
  created_at: string | null;
  sent_at: string | null;
  from_phone: string | null;
  to_phone: string | null;
  to_email: string | null;
  agent_source: string | null;
  metadata: Record<string, unknown> | null;
  recording_url: string | null;
  transcript_url: string | null;
  disposition: string | null;
  call_outcome: string | null;
  call_duration_sec: number | null;
  kixie_call_id: string | null;
  lead_id: string | null;
  actor_user_id: string | null;
};

/**
 * Map a row to the PLATFORM it belongs to (inbox section). Order matters:
 * email by channel; then Kixie (its own source/provider, or any phone call);
 * then Twilio; then Text Torrent (incl. the "helios" automated daemon + any
 * dashboard SMS send, since TT is the primary SMS provider). Anything else
 * (system/note) → "other" (only shows under the "All" section).
 */
export function messageSource(row: {
  channel: string | null;
  agent_source?: string | null;
  metadata?: Record<string, unknown> | null;
}): ConversationSource {
  const ch = (row.channel || "").toLowerCase();
  if (ch === "email") return "email";
  const src = (row.agent_source || "").toLowerCase();
  const provider =
    row.metadata && typeof row.metadata.provider === "string"
      ? (row.metadata.provider as string).toLowerCase()
      : "";
  if (src === "kixie" || provider === "kixie" || ch === "phone") return "kixie";
  if (src === "twilio" || provider === "twilio") return "twilio";
  if (src === "texttorrent" || src === "helios" || provider === "texttorrent") return "texttorrent";
  if (ch === "sms") return "texttorrent"; // dashboard SMS send → primary provider
  return "other";
}

/** The prospect-side phone for a row, regardless of send direction. */
function counterpartPhone(row: RawInteractionRow): string | null {
  const raw =
    row.direction === "inbound"
      ? row.from_phone || row.to_phone
      : row.to_phone || row.from_phone;
  return normalizePhoneE164(raw);
}

function groupKey(row: RawInteractionRow): { key: string; phone: string | null; email: string | null } {
  if (row.lead_id) {
    return { key: `lead:${row.lead_id}`, phone: counterpartPhone(row), email: row.to_email };
  }
  const phone = counterpartPhone(row);
  if (phone) return { key: `phone:${phone}`, phone, email: row.to_email };
  if (row.to_email) {
    const e = row.to_email.toLowerCase();
    return { key: `email:${e}`, phone: null, email: e };
  }
  return { key: `id:${row.id}`, phone: null, email: null };
}

/** Distinct, non-null lead_ids present in the rows. */
export function distinctLeadIds(rows: RawInteractionRow[]): string[] {
  return Array.from(new Set(rows.map((r) => r.lead_id).filter((x): x is string => !!x)));
}

/**
 * Group raw interaction rows (expected newest-first) into contact threads.
 * `labels` maps lead_id → display name; the DB wrapper resolves it. Pure +
 * synchronous so it unit-tests without Supabase.
 */
export function groupRowsIntoThreads(
  rows: RawInteractionRow[],
  labels: Record<string, string> = {},
): ConversationThread[] {
  const threads = new Map<string, ConversationThread>();
  for (const row of rows) {
    const at = row.sent_at || row.created_at;
    if (!at) continue;
    const { key, phone, email } = groupKey(row);
    const channel = row.channel || "unknown";
    const source = messageSource(row);
    const direction = row.direction || "outbound";
    const ttChatId =
      row.metadata && typeof row.metadata.tt_chat_id === "string"
        ? (row.metadata.tt_chat_id as string)
        : null;

    let thread = threads.get(key);
    if (!thread) {
      thread = {
        key,
        lead_id: row.lead_id,
        contact_label: phone || email || "Unknown contact",
        contact_phone: phone,
        contact_email: email,
        channels: [],
        sources: [],
        last_at: at, // first row for a key is newest (rows are desc)
        // Email sends logged via the gateway may carry a null content_preview
        // (the gateway omits body_preview); fall back to the subject so the
        // thread list shows the subject line instead of an empty "—".
        last_preview: row.content_preview || row.subject || "",
        last_direction: direction,
        inbound_count: 0,
        tt_chat_id: ttChatId,
        messages: [],
      };
      threads.set(key, thread);
    }
    if (!thread.channels.includes(channel)) thread.channels.push(channel);
    if (source !== "other" && !thread.sources.includes(source)) thread.sources.push(source);
    if (direction === "inbound") thread.inbound_count += 1;
    if (!thread.tt_chat_id && ttChatId) thread.tt_chat_id = ttChatId;
    if (!thread.contact_phone && phone) thread.contact_phone = phone;
    if (!thread.contact_email && email) thread.contact_email = email;
    thread.messages.push({
      id: row.id,
      channel,
      source,
      direction,
      type: row.type,
      subject: row.subject,
      // Same fallback as last_preview: a gateway-logged email with no
      // content_preview still renders its subject in the message bubble.
      preview: row.content_preview || row.subject || "",
      at,
      recording_url: row.recording_url,
      transcript_url: row.transcript_url,
      disposition: row.disposition,
      call_outcome: row.call_outcome,
      call_duration_sec: row.call_duration_sec,
    });
  }

  for (const thread of threads.values()) {
    if (thread.lead_id && labels[thread.lead_id]) {
      thread.contact_label = labels[thread.lead_id];
    }
    // Messages were pushed newest-first; flip to chronological for display.
    thread.messages.reverse();
  }

  return Array.from(threads.values());
}
