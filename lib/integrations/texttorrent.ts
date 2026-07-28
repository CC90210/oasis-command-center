/**
 * lib/integrations/texttorrent.ts — typed TextTorrent v1 API client.
 *
 * Phase 1 of the TT + Kixie full embedding plan (2026-06-01). Server-only.
 * Credentials are resolved from tenant_integration_credentials (multi-tenant
 * encrypted store) so chat tools, drawer buttons, and cron paths share one
 * client per tenant.
 *
 * TT API docs: https://texttorrent.com/docs/api
 *
 * Auth: two required headers per request:
 *   X-API-SID         — the tenant's SID
 *   X-API-PUBLIC-KEY  — the tenant's public key
 *   X-ACT-AS-USER     — optional, Base64-encoded email for sub-account act-as
 *
 * Rate limit: 60 requests/min per API key. The client tracks request timestamps
 * in a rolling 60-second window and queues calls when the window is full,
 * returning a 429-shaped error if the caller doesn't want to wait. Backoff is
 * the caller's responsibility — every fetch wrapper returns the parsed body
 * (or an Error with .status set so callers can branch).
 */

import "server-only";

import { getTenantIntegrationBundle } from "@/lib/tenant-integration-store";
import { getServiceSupabase } from "@/lib/supabase-server";

const BASE_URL = "https://api.texttorrent.com/api/v1";

// ---- Credential resolution ------------------------------------------------

export type TextTorrentCredentials = {
  tenantId: string;
  apiSid: string;
  publicKey: string;
  /** Optional sub-account email to act-as (sent as X-ACT-AS-USER, PLAIN email). */
  actAsEmail?: string;
};

/**
 * Read the tenant's TextTorrent credentials from the encrypted store.
 * Throws if the tenant hasn't wired TT yet — caller is responsible for
 * surfacing the missing-credential state (the readiness card already does).
 */
export async function getTextTorrentCredentials(
  tenantId: string,
  opts: { actAsEmail?: string | null; service?: string } = {},
): Promise<TextTorrentCredentials> {
  // Which TextTorrent ACCOUNT to authenticate as: the main "texttorrent" bundle by
  // default, or "texttorrent_followup" (a separate SID/public key) for the follow-up
  // drip account. The rate limiter keys off the resolved SID, so each account budgets separately.
  const bundle = await getTenantIntegrationBundle(tenantId, opts.service || "texttorrent");
  // TT authenticates with two distinct keys (X-API-SID + X-API-PUBLIC-KEY).
  // The integration form exposes api_sid + api_public_key; api_key is kept as
  // a legacy single-value fallback for tenants wired before the two-field form.
  const apiSid = bundle.api_sid || bundle.api_key || "";
  const publicKey = bundle.api_public_key || bundle.api_key || "";
  if (!apiSid || !publicKey) {
    throw new TextTorrentError(
      "missing_credentials",
      "TextTorrent SID + public key not on file for this tenant — wire them in Settings → Integrations.",
      0,
    );
  }
  // Act-as the sending sub-account:
  //   - a non-empty string → act-as THAT sub-account (X-ACT-AS-USER)
  //   - null               → EXPLICITLY no act-as: authenticate as the parent/
  //                          admin account itself. The drip engine uses this to
  //                          send a Matt/owner (unattributed) lead from the admin
  //                          account rather than the default sub-account.
  //   - undefined (default)→ the tenant default (act_as_email, e.g.
  //                          jordan@sunbizfunding.com) — unchanged for every
  //                          existing call site, matching the live agent path.
  const actAsEmail =
    opts.actAsEmail === null
      ? undefined
      : opts.actAsEmail || bundle.act_as_email || undefined;
  return { tenantId, apiSid, publicKey, actAsEmail };
}

// ---- Rate limiter (60 req/min rolling window) -----------------------------

const REQUEST_LOG: Map<string, number[]> = new Map();
const RATE_LIMIT_PER_MIN = 60;

function trackRequest(apiSid: string) {
  const now = Date.now();
  const cutoff = now - 60_000;
  const log = (REQUEST_LOG.get(apiSid) || []).filter((t) => t >= cutoff);
  log.push(now);
  REQUEST_LOG.set(apiSid, log);
  return log.length;
}

function rateLimitRetryAfterMs(apiSid: string): number {
  const log = REQUEST_LOG.get(apiSid) || [];
  if (log.length < RATE_LIMIT_PER_MIN) return 0;
  const oldest = log[0];
  return Math.max(0, 60_000 - (Date.now() - oldest));
}

// ---- Error shape ----------------------------------------------------------

export class TextTorrentError extends Error {
  readonly code: string;
  readonly status: number;
  readonly response?: unknown;
  constructor(code: string, message: string, status: number, response?: unknown) {
    super(message);
    this.name = "TextTorrentError";
    this.code = code;
    this.status = status;
    this.response = response;
  }
}

// ---- Core fetch wrapper ---------------------------------------------------

type RequestOpts = {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown> | unknown[];
  /** When the rate limit is hit, wait up to this many ms before erroring. */
  maxWaitMs?: number;
  priority?: number;
};

async function ttFetch<T>(
  creds: TextTorrentCredentials,
  path: string,
  opts: RequestOpts = {},
): Promise<T> {
  const controller = new AbortController();
  const gateTimeout = setTimeout(() => controller.abort(), 3000);
  let gate: { data: unknown; error: { message?: string } | null };
  try {
    gate = await getServiceSupabase().rpc("consume_texttorrent_rate_token", {
      p_bucket: `${creds.tenantId}:parent-sid`,
      p_worker_id: "oasis-texttorrent-client",
      p_priority: opts.priority ?? 50,
      p_limit: 60,
      p_window_seconds: 60,
    }).abortSignal(controller.signal);
  } catch (error) {
    throw new TextTorrentError(
      "rate_limiter_unavailable",
      error instanceof Error ? error.message : "Shared TextTorrent rate limiter unavailable.",
      503,
    );
  } finally {
    clearTimeout(gateTimeout);
  }
  if (gate.error) {
    throw new TextTorrentError(
      "rate_limiter_unavailable",
      gate.error.message || "Shared TextTorrent rate limiter unavailable.",
      503,
    );
  }
  if (gate.data !== true) {
    throw new TextTorrentError("rate_limited", "Shared TextTorrent parent-SID rate limit deferred.", 429);
  }
  const wait = rateLimitRetryAfterMs(creds.apiSid);
  if (wait > 0) {
    const cap = opts.maxWaitMs ?? 2000;
    if (wait > cap) {
      throw new TextTorrentError(
        "rate_limited",
        `TT 60/min limit hit. Retry in ${Math.ceil(wait / 1000)}s.`,
        429,
      );
    }
    await new Promise((r) => setTimeout(r, wait + 50));
  }
  trackRequest(creds.apiSid);

  const url = new URL(BASE_URL + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    "X-API-SID": creds.apiSid,
    "X-API-PUBLIC-KEY": creds.publicKey,
    Accept: "application/json",
  };
  if (creds.actAsEmail) {
    // PLAIN email — LIVE-VERIFIED (BUSINESS_CONTEXT/TEXTTORRENT_API_VERIFIED.md).
    // The prior base64 encoding was a dormant bug: the live API expects the raw
    // email in X-ACT-AS-USER (dormant only because no call site passed actAsEmail).
    headers["X-ACT-AS-USER"] = creds.actAsEmail;
  }
  if (opts.body) headers["Content-Type"] = "application/json";

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      method: opts.method || (opts.body ? "POST" : "GET"),
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
    });
  } catch (err) {
    throw new TextTorrentError(
      "network_error",
      err instanceof Error ? err.message : "network failure",
      0,
    );
  }

  // 429 from TT itself (just in case our local window is wrong).
  if (resp.status === 429) {
    throw new TextTorrentError("rate_limited", "TT returned 429.", 429);
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  if (!resp.ok) {
    const msg =
      (body as { message?: string; error?: string })?.message ||
      (body as { error?: string })?.error ||
      `TT ${resp.status}`;
    // TT bills per message SEND. `/inbox/chat/create` is FREE and still returns
    // 201 at a zero balance, so a drained account keeps minting chats while every
    // send 422s — the 2026-07-23 incident (1,232 chats, 0 messages). Give credit
    // exhaustion a stable code so callers can halt on it instead of string-
    // matching a vendor message or burning a retry budget on it.
    const code = /enough credit|insufficient credit/i.test(msg)
      ? "insufficient_credits"
      : `http_${resp.status}`;
    throw new TextTorrentError(code, msg, resp.status, body);
  }
  return body as T;
}

// ---- Typed API surface ----------------------------------------------------

export type TtMe = {
  id: string;
  email: string;
  credits?: number;
  plan_name?: string;
  subscription_status?: string;
};

export type TtList = {
  id: string;
  name: string;
  count?: number;
  bookmarked?: boolean;
  created_at?: string;
};

export type TtContact = {
  id: string;
  first_name?: string;
  last_name?: string;
  number: string;
  email?: string;
  company?: string;
};

export type TtCampaign = {
  id: string | number;
  name?: string;
  campaign_name?: string;
  status?: string;
  list_id?: string;
  contact_list_id?: string | number;
  contact_list_name?: string;
  message?: string;
  scheduled_time?: string | null;
  created_at?: string;
  sent?: number;
  delivered?: number;
  clicked?: number;
  failed?: number;
  opted_out?: number;
};

/** Native bulk-campaign create args — TT's carrier-safe anti-block engine. */
export type BulkCampaignArgs = {
  campaign_name: string;
  contact_list_id: string | number;
  sms_body: string;
  /** Sender-number pool the campaign rotates across (E.164). */
  numbers: string[];
  sms_type?: "sms" | "mms";
  /** Anti-blocking: spread the send across the number pool. */
  number_pool?: boolean;
  /** Anti-blocking: even round-robin across the numbers. */
  round_robin_campaign?: boolean;
  /** Anti-blocking: drip in batches over time. */
  batch_process?: boolean;
  batch_size?: number;
  /** Minutes between batches. */
  batch_frequency?: number;
  /** Append a compliant opt-out link. */
  opt_out_link?: boolean;
  appended_message?: string;
  /** Schedule (YYYY-MM-DD + HH:MM); omit to send now. */
  selected_date?: string;
  selected_time?: string;
};

export type TtInboxMessage = {
  chat_id: string;
  from: string;
  to: string;
  message: string;
  direction: "inbound" | "outbound";
  created_at: string;
  /** Chat-level unread count (getInbox only) — used to skip chats the live
   *  Jordan agent hasn't read yet (reading a thread marks it read). */
  unreadCount?: number;
  /** Per-message TT delivery status (getThread only) — undocumented `api_send_status`
   *  ("Failed" / "success"), the real per-message DLR signal. */
  sendStatus?: string;
};

/** Account info + credit balance — useful for the readiness card. */
export function meAccountInfo(creds: TextTorrentCredentials): Promise<TtMe> {
  return ttFetch<TtMe>(creds, "/user/auth/me");
}

// --- Lists & contacts ------------------------------------------------------

export function listLists(
  creds: TextTorrentCredentials,
  opts: { email?: string } = {},
): Promise<{ data: TtList[] }> {
  return ttFetch(creds, "/contact/list", { query: { email: opts.email } });
}

export function createList(
  creds: TextTorrentCredentials,
  name: string,
): Promise<{ data: TtList }> {
  if (!name || name.length > 15) {
    throw new TextTorrentError(
      "validation",
      "List name required (max 15 chars per TT docs).",
      0,
    );
  }
  return ttFetch(creds, "/contact/list/add/bookmark", { body: { name } });
}

export function listContacts(
  creds: TextTorrentCredentials,
  listId: string,
  opts: { limit?: number; page?: number; search?: string } = {},
): Promise<{ data: TtContact[]; total?: number }> {
  return ttFetch(creds, `/contact/${encodeURIComponent(listId)}/contacts`, {
    query: { limit: opts.limit, page: opts.page, search: opts.search },
  });
}

export function addContact(
  creds: TextTorrentCredentials,
  args: {
    first_name: string;
    number: string;
    list_id: string;
    last_name?: string;
    email?: string;
    company?: string;
  },
): Promise<{ data: TtContact }> {
  return ttFetch(creds, "/contact/add", { body: args });
}

// --- 1:1 SMS (Inbox) -------------------------------------------------------
//
// LIVE-VERIFIED send path (BUSINESS_CONTEXT/TEXTTORRENT_API_VERIFIED.md) — the
// same two-step flow the production Jordan agent uses daily:
//   1. POST /inbox/chat/create { receiver_number (10-digit), sender_id } → chat_id
//   2. POST /inbox/chat { chat_id, to_number, from_number, message }     → sends
// The old POST /inbox/message/send 404s ("route could not be found"); do not
// reintroduce it.

/** Normalize an E.164 / formatted phone to the 10-digit US form that
 *  /inbox/chat/create requires. */
function toTenDigit(phone: string): string {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  throw new TextTorrentError("validation", `Cannot normalize "${phone}" to a 10-digit US number.`, 0);
}

/** Find an existing chat id for a destination number by scanning the inbox
 *  (used when /inbox/chat/create reports the chat already exists). */
async function findChatIdByNumber(
  creds: TextTorrentCredentials,
  toNumber: string,
): Promise<string | null> {
  const ten = toTenDigit(toNumber);
  const inbox = await ttFetch<{ data?: { data?: Array<{ id: string | number; number: string }> } }>(
    creds,
    "/inbox",
    { query: { limit: 100 } },
  );
  const chats = inbox?.data?.data || [];
  for (const c of chats) {
    try {
      if (toTenDigit(c.number) === ten) return String(c.id);
    } catch {
      /* skip malformed numbers */
    }
  }
  return null;
}

/**
 * Send a 1:1 SMS. Creates-or-finds the chat, then sends on it. `sender_id` is
 * the sending number (the rep's own line or the tenant default) and is required
 * — TT rejects a create without it. Returns the resolved chat_id so callers can
 * thread follow-ups.
 */
export async function sendSms(
  creds: TextTorrentCredentials,
  args: { number: string; message: string; sender_id?: string; rate_priority?: number },
): Promise<{ data: { chat_id: string; message_id?: string } }> {
  const fromNumber = (args.sender_id || "").trim();
  if (!fromNumber) {
    throw new TextTorrentError(
      "validation",
      "TextTorrent send requires a sender number — set a Default Business Number in Settings → Integrations or your own number in Personal integrations.",
      0,
    );
  }
  // Refuse a blank body BEFORE Step 1. Step 1 is free but creates a real chat, so
  // sending an empty message would leave an empty thread in the rep's inbox and
  // still attempt a billable send. Fail closed instead.
  const outbound = String(args.message ?? "").trim();
  if (!outbound) {
    throw new TextTorrentError(
      "validation",
      "Refusing to send an empty TextTorrent message — no chat is created and no credit is spent.",
      0,
    );
  }
  const receiver = toTenDigit(args.number);

  // Step 1: create or find the chat.
  let chatId = "";
  try {
    const created = await ttFetch<{ data?: { id?: string | number } }>(creds, "/inbox/chat/create", {
      body: { receiver_number: receiver, sender_id: fromNumber },
      priority: args.rate_priority,
    });
    chatId = String(created?.data?.id || "");
  } catch (err) {
    // "already started a chat" → reuse the existing thread; anything else is fatal.
    if (err instanceof TextTorrentError && /already started/i.test(err.message)) {
      chatId = (await findChatIdByNumber(creds, args.number)) || "";
    } else {
      throw err;
    }
  }
  if (!chatId) chatId = (await findChatIdByNumber(creds, args.number)) || "";
  if (!chatId) {
    throw new TextTorrentError("send_failed", `Could not open a TextTorrent chat for ${args.number}.`, 0);
  }

  // Step 2: send the message on the chat. THIS is the billable call; Step 1 above
  // is free, so any failure here leaves an empty chat behind.
  const sent = await ttFetch<{ data?: { message_id?: string } }>(creds, "/inbox/chat", {
    body: { chat_id: chatId, to_number: args.number, from_number: fromNumber, message: outbound },
    priority: args.rate_priority,
  });
  const messageId = sent?.data?.message_id;
  if (messageId == null || String(messageId).trim() === "") {
    // Observability only — deliberately NOT a throw. We have never captured a
    // confirmed-successful Step 2 response (the incident probe only ever got 422
    // insufficient_credits), so we cannot yet prove TT always returns message_id
    // on success; failing closed here could break every send. Promote this to a
    // hard fail once one real success is observed to carry a message_id.
    console.warn("[texttorrent] send returned no message_id — delivery unconfirmed", {
      chatId,
      to: args.number,
      from: fromNumber,
    });
  }
  return { data: { chat_id: chatId, message_id: messageId } };
}

const ttStr = (v: unknown): string => (v == null ? "" : String(v));

/**
 * List inbox chats. TT shape: `{ data: { data: [ {id, number, from_number,
 * last_message, updated_at, ...} ] } }` (paginated). Normalized to
 * TtInboxMessage[] carrying the `chat_id` (= chat `id`) the caller pulls threads
 * by. `from` = contact number, `to` = our sending number, `message` = the chat's
 * last message.
 */
export async function getInbox(
  creds: TextTorrentCredentials,
  opts: { limit?: number; page?: number } = {},
): Promise<{ data: TtInboxMessage[] }> {
  const resp = await ttFetch<{ data?: { data?: Array<Record<string, unknown>> } | Array<Record<string, unknown>> }>(creds, "/inbox", { query: opts });
  const rowsRaw = resp?.data;
  const rows: Array<Record<string, unknown>> = Array.isArray(rowsRaw) ? rowsRaw : rowsRaw?.data || [];
  return {
    data: rows.map((c) => ({
      chat_id: ttStr(c.id ?? c.chat_id),
      from: ttStr(c.number),
      to: ttStr(c.from_number),
      message: ttStr(c.last_message),
      direction: "inbound" as const,
      created_at: ttStr(c.updated_at),
      unreadCount: Number(c.unread_count ?? c.unread ?? 0) || 0,
    })),
  };
}

/**
 * Pull a chat's messages. TT shape: `{ data: { chat: {number, from_number}, messages:
 * { data: [ {direction:'inbound'|'outbound', message, chat_id, created_at} ] } } }`.
 * from/to are derived per direction from the chat's contact + our number.
 */
export async function getThread(
  creds: TextTorrentCredentials,
  chatId: string,
): Promise<{ data: TtInboxMessage[] }> {
  const resp = await ttFetch<{ data?: { chat?: Record<string, unknown>; messages?: { data?: Array<Record<string, unknown>> } | Array<Record<string, unknown>> } }>(creds, `/inbox/${encodeURIComponent(chatId)}`);
  const d = resp?.data || {};
  const chat = (d.chat || {}) as Record<string, unknown>;
  const contact = ttStr(chat.number);
  const our = ttStr(chat.from_number);
  const msgsRaw = d.messages;
  const msgs: Array<Record<string, unknown>> = Array.isArray(msgsRaw) ? msgsRaw : msgsRaw?.data || [];
  return {
    data: msgs.map((m) => {
      const direction = ttStr(m.direction).toLowerCase() === "inbound" ? "inbound" : "outbound";
      return {
        chat_id: ttStr(m.chat_id ?? chatId),
        from: direction === "inbound" ? contact : our,
        to: direction === "inbound" ? our : contact,
        message: ttStr(m.message),
        direction: direction as "inbound" | "outbound",
        created_at: ttStr(m.created_at),
        sendStatus: ttStr(m.api_send_status),
      };
    }),
  };
}

export function replyToThread(
  creds: TextTorrentCredentials,
  args: { number: string; message: string; sender_id?: string },
): Promise<{ data: { chat_id: string; message_id?: string } }> {
  // Same create-or-find-then-send path; TT threads by chat_id internally.
  return sendSms(creds, args);
}

// --- Bulk campaigns --------------------------------------------------------

/**
 * Launch a native bulk campaign — TT's anti-block mass-send engine, the only
 * way to reach thousands without carrier blocking. LIVE-VERIFIED contract
 * (422 validation probe): POST /campaigning/bulk requires campaign_name,
 * contact_list_id, sms_type, sms_body, numbers[]. The old /campaign/create 404s.
 */
export async function createBulkCampaign(
  creds: TextTorrentCredentials,
  args: BulkCampaignArgs,
): Promise<{ data: { campaign_id?: number; total_contacts?: number; total_segments?: number; total_credit?: number } }> {
  const body: Record<string, unknown> = {
    campaign_name: args.campaign_name,
    contact_list_id: args.contact_list_id,
    sms_type: args.sms_type || "sms",
    sms_body: args.sms_body,
    numbers: args.numbers,
  };
  if (args.number_pool !== undefined) body.number_pool = args.number_pool;
  if (args.round_robin_campaign !== undefined) body.round_robin_campaign = args.round_robin_campaign;
  if (args.batch_process !== undefined) body.batch_process = args.batch_process;
  if (args.batch_size !== undefined) body.batch_size = args.batch_size;
  if (args.batch_frequency !== undefined) body.batch_frequency = args.batch_frequency;
  if (args.opt_out_link !== undefined) body.opt_out_link = args.opt_out_link;
  if (args.appended_message) body.appended_message = args.appended_message;
  if (args.selected_date) body.selected_date = args.selected_date;
  if (args.selected_time) body.selected_time = args.selected_time;
  return ttFetch(creds, "/campaigning/bulk", { body });
}

/**
 * List campaigns + status. LIVE-VERIFIED path: GET /campaigning/analytic
 * (returns a paginated { data: { data: [...] } } envelope). The old /campaign 404s.
 */
export async function listCampaigns(
  creds: TextTorrentCredentials,
  opts: { limit?: number; page?: number; status?: string; search?: string } = {},
): Promise<{ data: TtCampaign[] }> {
  const r = await ttFetch<{ data?: { data?: TtCampaign[] } | TtCampaign[] }>(creds, "/campaigning/analytic", {
    query: { limit: opts.limit, page: opts.page, status: opts.status, search: opts.search },
  });
  const payload = r?.data;
  const flat = Array.isArray(payload) ? payload : (payload as { data?: TtCampaign[] })?.data || [];
  return { data: flat };
}

// --- Campaign analytics (LIVE-VERIFIED /campaigning/analytic/details/*) -----
// The old /campaign/{id}/messages* paths 404. Verified shapes below.

export type TtCampaignDetails = {
  id: number;
  campaign_name?: string;
  contact_list_id?: number;
  credits_consumed?: number;
  total_participants?: number;
  created_at?: string;
  status?: string;
};

export type TtCampaignCount = {
  total: number;
  scheduled: number;
  processing: number;
  completed: number; // delivered + sent
  paused: number;
  failed: number; // failed + undelivered
};

/** Per-message row. `received`/`received_message` carry the native inbound reply. */
export type TtCampaignMessage = {
  id: number;
  bulk_message_id: number;
  send_from: string;
  send_to: string;
  contact_id?: number;
  message?: string;
  send_status?: string; // pending | sent | delivered | failed | undelivered
  remarks?: string;
  received?: number; // 1 when the recipient replied
  received_message?: string | null;
  type?: string;
  execute_at?: string;
};

/** Campaign core stats + spend. GET /campaigning/analytic/details/{id} */
export async function campaignDetails(
  creds: TextTorrentCredentials,
  campaignId: string | number,
): Promise<{ data: TtCampaignDetails }> {
  return ttFetch(creds, `/campaigning/analytic/details/${encodeURIComponent(String(campaignId))}`);
}

/** Message status breakdown. GET /campaigning/analytic/details/{id}/count */
export async function campaignCount(
  creds: TextTorrentCredentials,
  campaignId: string | number,
): Promise<{ data: TtCampaignCount }> {
  return ttFetch(creds, `/campaigning/analytic/details/${encodeURIComponent(String(campaignId))}/count`);
}

/** Per-message roster (delivery + native replies). GET /campaigning/analytic/details/{id}/list */
export async function campaignMessageList(
  creds: TextTorrentCredentials,
  campaignId: string | number,
  opts: { limit?: number; page?: number; status?: string; search?: string } = {},
): Promise<{ data: TtCampaignMessage[]; page?: number; lastPage?: number }> {
  const r = await ttFetch<{
    data?: { data?: TtCampaignMessage[]; current_page?: number; last_page?: number } | TtCampaignMessage[];
  }>(creds, `/campaigning/analytic/details/${encodeURIComponent(String(campaignId))}/list`, {
    query: { limit: opts.limit ?? 100, page: opts.page, status: opts.status, search: opts.search },
  });
  const payload = r?.data;
  if (Array.isArray(payload)) return { data: payload };
  const nested = payload as { data?: TtCampaignMessage[]; current_page?: number; last_page?: number } | undefined;
  return { data: nested?.data || [], page: nested?.current_page, lastPage: nested?.last_page };
}

// --- Opt-out + blocklist ---------------------------------------------------

export function listOptOutWords(
  creds: TextTorrentCredentials,
): Promise<{ data: Array<{ id: string; word: string }> }> {
  return ttFetch(creds, "/contact/opt-out-words");
}

export function addOptOutWord(
  creds: TextTorrentCredentials,
  word: string,
): Promise<{ data: { id: string; word: string } }> {
  return ttFetch(creds, "/contact/opt-out-words/add", { body: { word } });
}

export function blockContact(
  creds: TextTorrentCredentials,
  args: { contact_id?: string; number?: string },
): Promise<{ data: unknown }> {
  return ttFetch(creds, "/contact/blocked-list/add", { body: args });
}

export function unblockContact(
  creds: TextTorrentCredentials,
  contactIds: string[],
): Promise<{ data: unknown }> {
  return ttFetch(creds, "/contact/blocked-list/remove", { body: { items: contactIds } });
}

// --- Number validation -----------------------------------------------------

export function verifyValidationCost(
  creds: TextTorrentCredentials,
  contactIds: string[],
): Promise<{ data: { credits_needed: number; available: number } }> {
  return ttFetch(creds, "/contact/number/verify/confirmation", {
    body: { contact_id: contactIds },
  });
}

export function validateNumbers(
  creds: TextTorrentCredentials,
  args: { contact_ids: string[]; validator_credits: number; available_validation: number },
): Promise<{ data: { record_id: string } }> {
  return ttFetch(creds, "/contact/number/validate", { body: args });
}

// --- Templates -------------------------------------------------------------

export function listTemplates(
  creds: TextTorrentCredentials,
  opts: { limit?: number; page?: number } = {},
): Promise<{ data: Array<{ id: string; name: string; content: string }> }> {
  return ttFetch(creds, "/template", { query: opts });
}

export function addTemplate(
  creds: TextTorrentCredentials,
  args: { name: string; content: string },
): Promise<{ data: { id: string } }> {
  return ttFetch(creds, "/template/add", { body: args });
}

// --- AI reply generation (TT native) --------------------------------------

export function generateAiReply(
  creds: TextTorrentCredentials,
  args: { chat_id: string; tone?: string },
): Promise<{ data: { suggestion: string } }> {
  return ttFetch(creds, "/inbox/reply/generate-ai", { body: args });
}

// --- Numbers (purchase + list) --------------------------------------------

export type TtNumber = {
  id: number;
  number: string;
  friendly_name?: string;
  status?: number;
  region?: string;
  country?: string;
  capabilities?: { voice?: boolean; sms?: boolean; mms?: boolean };
};

/**
 * The account's active sending numbers (the rotating pool). LIVE-VERIFIED path:
 * GET /inbox/numbers/active → paginated { data: { data: TtNumber[] } }. The old
 * /inbox/active-numbers 404s.
 */
export async function listNumbers(
  creds: TextTorrentCredentials,
  opts: { limit?: number; page?: number } = {},
): Promise<{ data: TtNumber[] }> {
  const r = await ttFetch<{ data?: { data?: TtNumber[] } | TtNumber[] }>(creds, "/inbox/numbers/active", {
    query: { limit: opts.limit ?? 50, page: opts.page },
  });
  const payload = r?.data;
  const flat = Array.isArray(payload) ? payload : (payload as { data?: TtNumber[] })?.data || [];
  return { data: flat };
}

// --- Sub-accounts ---------------------------------------------------------

export function listSubAccounts(
  creds: TextTorrentCredentials,
): Promise<{ data: Array<{ id: string; email: string; first_name?: string; last_name?: string; status?: string }> }> {
  return ttFetch(creds, "/sub-account");
}

export function createSubAccount(
  creds: TextTorrentCredentials,
  args: { email: string; first_name: string; last_name?: string },
): Promise<{ data: { id: string } }> {
  return ttFetch(creds, "/sub-account/add", { body: args });
}
