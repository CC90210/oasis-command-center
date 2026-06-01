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

const BASE_URL = "https://api.texttorrent.com/api/v1";

// ---- Credential resolution ------------------------------------------------

export type TextTorrentCredentials = {
  apiSid: string;
  publicKey: string;
  /** Optional sub-account email to act-as (sent as X-ACT-AS-USER Base64). */
  actAsEmail?: string;
};

/**
 * Read the tenant's TextTorrent credentials from the encrypted store.
 * Throws if the tenant hasn't wired TT yet — caller is responsible for
 * surfacing the missing-credential state (the readiness card already does).
 */
export async function getTextTorrentCredentials(
  tenantId: string,
  opts: { actAsEmail?: string } = {},
): Promise<TextTorrentCredentials> {
  const bundle = await getTenantIntegrationBundle(tenantId, "texttorrent");
  // The schema today uses {api_key, from_number} — the docs reference
  // X-API-SID + X-API-PUBLIC-KEY as two separate fields. Until the operator
  // pastes both into the schema we accept api_key as either the SID or the
  // public key; production-ready setups will paste both.
  //
  // Schema gets a second field (api_sid) in a future migration; for now we
  // support both shapes so we don't block on UI work.
  const apiSid = bundle.api_sid || bundle.api_key || "";
  const publicKey = bundle.api_public_key || bundle.api_key || "";
  if (!apiSid || !publicKey) {
    throw new TextTorrentError(
      "missing_credentials",
      "TextTorrent SID + public key not on file for this tenant — wire them in Settings → Integrations.",
      0,
    );
  }
  return { apiSid, publicKey, actAsEmail: opts.actAsEmail };
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
};

async function ttFetch<T>(
  creds: TextTorrentCredentials,
  path: string,
  opts: RequestOpts = {},
): Promise<T> {
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
    headers["X-ACT-AS-USER"] = Buffer.from(creds.actAsEmail).toString("base64");
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
    throw new TextTorrentError(
      `http_${resp.status}`,
      msg,
      resp.status,
      body,
    );
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
  id: string;
  name?: string;
  list_id?: string;
  message?: string;
  scheduled_time?: string | null;
  sent?: number;
  delivered?: number;
  clicked?: number;
  failed?: number;
  opted_out?: number;
};

export type TtInboxMessage = {
  chat_id: string;
  from: string;
  to: string;
  message: string;
  direction: "incoming" | "outgoing";
  created_at: string;
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

export function sendSms(
  creds: TextTorrentCredentials,
  args: { number: string; message: string; sender_id?: string },
): Promise<{ data: { message_id?: string } }> {
  return ttFetch(creds, "/inbox/message/send", { body: args });
}

export function startChat(
  creds: TextTorrentCredentials,
  args: { number: string; initial_message: string },
): Promise<{ data: { chat_id: string } }> {
  return ttFetch(creds, "/inbox/chat/start", { body: args });
}

export function getInbox(
  creds: TextTorrentCredentials,
  opts: { limit?: number; page?: number } = {},
): Promise<{ data: TtInboxMessage[] }> {
  return ttFetch(creds, "/inbox", { query: opts });
}

export function getThread(
  creds: TextTorrentCredentials,
  chatId: string,
): Promise<{ data: TtInboxMessage[] }> {
  return ttFetch(creds, `/inbox/${encodeURIComponent(chatId)}`);
}

export function replyToThread(
  creds: TextTorrentCredentials,
  args: { number: string; message: string; sender_id?: string },
): Promise<{ data: { message_id?: string } }> {
  // Reuses /inbox/message/send — TT threads by sender/number internally.
  return sendSms(creds, args);
}

// --- Bulk campaigns --------------------------------------------------------

export function createCampaign(
  creds: TextTorrentCredentials,
  args: { list_id: string; message: string; scheduled_time?: string },
): Promise<{ data: TtCampaign }> {
  return ttFetch(creds, "/campaign/create", { body: args });
}

export function listCampaigns(
  creds: TextTorrentCredentials,
  opts: { limit?: number; page?: number } = {},
): Promise<{ data: TtCampaign[] }> {
  return ttFetch(creds, "/campaign", { query: opts });
}

export function campaignMessages(
  creds: TextTorrentCredentials,
  campaignId: string,
  opts: { limit?: number; page?: number } = {},
): Promise<{ data: TtInboxMessage[] }> {
  return ttFetch(creds, `/campaign/${encodeURIComponent(campaignId)}/messages`, {
    query: opts,
  });
}

export function campaignCounts(
  creds: TextTorrentCredentials,
  campaignId: string,
): Promise<{
  data: { sent: number; delivered: number; clicked: number; failed: number; opted_out: number };
}> {
  return ttFetch(creds, `/campaign/${encodeURIComponent(campaignId)}/messages/counts`);
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

export function listNumbers(
  creds: TextTorrentCredentials,
): Promise<{ data: Array<{ number: string; label?: string; active: boolean }> }> {
  return ttFetch(creds, "/inbox/active-numbers");
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
