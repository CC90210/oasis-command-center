/**
 * lib/slack/client.ts - the few Slack Web API calls OASIS makes, and nothing
 * else. Each one returns a result (never throws for a Slack or network
 * failure) so the caller decides what a failure means, and each one is bounded
 * by a timeout so a slow Slack never holds a request open.
 *
 *   oauth.v2.access     finish an install (the code for a bot token)
 *   auth.test           the connection's health probe: is the token alive,
 *                       and which team is it for
 *   users.info          who wrote a message: guest? another company's user?
 *                       which email (to link to a teammate)?
 *   conversations.list  the public channels the Settings channel map offers
 *   chat.postMessage    a reply in a thread (only ever from an approved
 *                       send_slack_message, or the approval card itself)
 *   response_url        replace an interactive message after a button press
 *
 * Tokens are passed in by the caller from the encrypted store; they are never
 * logged. Error strings are Slack's own error CODES ("invalid_auth",
 * "channel_not_found"), never message content.
 */
import "server-only";

export const SLACK_API = "https://slack.com/api";
export const SLACK_DEFAULT_TIMEOUT_MS = 5_000;

export type SlackFetch = typeof fetch;

export type SlackCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number | null; retryAfterSec?: number | null };

type Opts = { fetchImpl?: SlackFetch; timeoutMs?: number };

async function call<T>(
  method: string,
  body: Record<string, unknown> | URLSearchParams,
  opts: Opts & { token?: string | null },
): Promise<SlackCallResult<T>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? SLACK_DEFAULT_TIMEOUT_MS);
  const form = body instanceof URLSearchParams;
  try {
    const res = await fetchImpl(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        "content-type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8",
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: form ? body.toString() : JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      return { ok: false, error: "rate_limited", status: 429, retryAfterSec: Number.isFinite(ra) ? ra : null };
    }
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      return { ok: false, error: "unexpected_response", status: res.status };
    }
    const o = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: typeof o.error === "string" ? o.error : `http_${res.status}`, status: res.status };
    if (o.ok !== true) return { ok: false, error: typeof o.error === "string" ? o.error : "not_ok", status: res.status };
    return { ok: true, data: o as T };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, error: aborted ? "timeout" : "network_error", status: null };
  } finally {
    clearTimeout(timer);
  }
}

// -- oauth.v2.access ---------------------------------------------------------

export type SlackInstall = {
  access_token: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: { id?: string; name?: string } | null;
  enterprise?: { id?: string; name?: string } | null;
  is_enterprise_install?: boolean;
  authed_user?: { id?: string } | null;
};

export function exchangeInstallCode(
  input: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  opts: Opts = {},
): Promise<SlackCallResult<SlackInstall>> {
  return call<SlackInstall>(
    "oauth.v2.access",
    new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
    opts,
  );
}

// -- auth.test ---------------------------------------------------------------

export type SlackAuthTest = { team_id?: string; team?: string; user_id?: string; bot_id?: string };

export function authTest(token: string, opts: Opts = {}): Promise<SlackCallResult<SlackAuthTest>> {
  return call<SlackAuthTest>("auth.test", {}, { ...opts, token });
}

// -- users.info --------------------------------------------------------------

export type SlackUser = {
  id: string;
  team_id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_stranger?: boolean;
  profile?: { email?: string; display_name?: string; real_name?: string } | null;
};

export async function usersInfo(token: string, userId: string, opts: Opts = {}): Promise<SlackCallResult<SlackUser>> {
  const r = await call<{ user?: SlackUser }>("users.info", new URLSearchParams({ user: userId }), { ...opts, token });
  if (!r.ok) return r;
  if (!r.data.user || typeof r.data.user.id !== "string") return { ok: false, error: "unexpected_response", status: 200 };
  return { ok: true, data: r.data.user };
}

// -- conversations.list ------------------------------------------------------

export type SlackChannel = {
  id: string;
  name: string;
  is_member: boolean;
  is_archived: boolean;
  /** Shared with another company (Slack Connect). OASIS never answers or mirrors there. */
  is_ext_shared: boolean;
};

/** Public channels, up to `max`, following Slack's cursor. */
export async function listPublicChannels(
  token: string,
  opts: Opts & { max?: number } = {},
): Promise<SlackCallResult<{ channels: SlackChannel[]; truncated: boolean }>> {
  const max = Math.max(1, Math.min(1000, opts.max ?? 500));
  const out: SlackChannel[] = [];
  let cursor = "";
  for (let page = 0; page < 10; page += 1) {
    const params = new URLSearchParams({ types: "public_channel", exclude_archived: "true", limit: "200" });
    if (cursor) params.set("cursor", cursor);
    const r = await call<{ channels?: Array<Record<string, unknown>>; response_metadata?: { next_cursor?: string } }>(
      "conversations.list",
      params,
      { ...opts, token },
    );
    if (!r.ok) return r;
    for (const c of r.data.channels ?? []) {
      if (typeof c.id !== "string" || typeof c.name !== "string") continue;
      out.push({
        id: c.id,
        name: c.name,
        is_member: c.is_member === true,
        is_archived: c.is_archived === true,
        is_ext_shared: c.is_ext_shared === true || c.is_shared === true,
      });
      if (out.length >= max) return { ok: true, data: { channels: out, truncated: true } };
    }
    cursor = r.data.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return { ok: true, data: { channels: out, truncated: Boolean(cursor) } };
}

/** One channel's facts (conversations.info): its name and whether it is shared with another company. */
export async function channelInfo(token: string, channelId: string, opts: Opts = {}): Promise<SlackCallResult<SlackChannel>> {
  const r = await call<{ channel?: Record<string, unknown> }>("conversations.info", new URLSearchParams({ channel: channelId }), { ...opts, token });
  if (!r.ok) return r;
  const c = r.data.channel;
  if (!c || typeof c.id !== "string" || typeof c.name !== "string") return { ok: false, error: "unexpected_response", status: 200 };
  return {
    ok: true,
    data: {
      id: c.id,
      name: c.name,
      is_member: c.is_member === true,
      is_archived: c.is_archived === true,
      is_ext_shared: c.is_ext_shared === true || c.is_shared === true,
    },
  };
}

// -- chat.postMessage --------------------------------------------------------

export type SlackPosted = { ts: string; channel: string };

export async function postMessage(
  token: string,
  message: { channel: string; text: string; thread_ts?: string | null; blocks?: unknown[] },
  opts: Opts = {},
): Promise<SlackCallResult<SlackPosted>> {
  const r = await call<{ ts?: string; channel?: string }>(
    "chat.postMessage",
    {
      channel: message.channel,
      text: message.text,
      ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}),
      ...(message.blocks ? { blocks: message.blocks } : {}),
      // A reply names the department in its own text; no link unfurls in a
      // client's channel from an agent's draft.
      unfurl_links: false,
      unfurl_media: false,
    },
    { ...opts, token },
  );
  if (!r.ok) return r;
  if (typeof r.data.ts !== "string") return { ok: false, error: "unexpected_response", status: 200 };
  return { ok: true, data: { ts: r.data.ts, channel: String(r.data.channel ?? message.channel) } };
}

// -- response_url ------------------------------------------------------------

/** Only Slack's own hooks host: a response_url is untrusted input until it is checked. */
export function isSlackResponseUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "hooks.slack.com";
  } catch {
    return false;
  }
}

export async function respondToAction(
  responseUrl: string,
  body: Record<string, unknown>,
  opts: Opts = {},
): Promise<{ ok: boolean; error: string | null }> {
  if (!isSlackResponseUrl(responseUrl)) return { ok: false, error: "response_url_not_slack" };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? SLACK_DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return res.ok ? { ok: true, error: null } : { ok: false, error: `http_${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error && err.name === "AbortError" ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}
