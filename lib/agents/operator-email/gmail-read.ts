/**
 * lib/agents/operator-email/gmail-read.ts — read-only Gmail poller for the
 * Operator Email Agent. Uses the operator's stored OAuth bundle (gmail_oauth /
 * gmail_oauth_personal) with the gmail.readonly scope to list + fetch recent
 * messages. NEVER modifies mail. NEVER throws — returns [] on any failure so a
 * bad tick can't crash the cron. Mirrors the JARVIS deal-checker read pattern.
 */

import "server-only";
import { getUserIntegrationBundle, setUserIntegrationValue } from "@/lib/user-integration-store";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REFRESH_SKEW_MS = 60_000;

export interface MonitoredMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  /** The `Date` HEADER — sender-controlled. Display only; never drive a cursor from it. */
  date: string;
  /**
   * Gmail's own receipt time (ms since epoch, as a string). Set by the server,
   * not by the sender, so this is the one timestamp safe to make scheduling
   * decisions on. Undefined only if the API omits it.
   */
  internalDate?: string;
  body: string;
  mailboxAddress: string; // the connected account (Alex's work/personal address)
}

type Service = "gmail_oauth" | "gmail_oauth_personal";

/** Fresh access token for a mailbox; refreshes + persists if stale. null on failure. */
async function ensureAccessToken(
  tenantId: string,
  userId: string,
  service: Service,
  bundle: Record<string, string>,
): Promise<string | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret || !bundle.refresh_token) return null;

  const expiresAt = bundle.expires_at ? Date.parse(bundle.expires_at) : 0;
  if (bundle.access_token && expiresAt && expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return bundle.access_token;
  }
  try {
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: bundle.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await r.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (j.error || !j.access_token) return null; // invalid_grant → operator must reconnect
    const newExpiry = new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString();
    await setUserIntegrationValue(tenantId, userId, service, "access_token", j.access_token);
    await setUserIntegrationValue(tenantId, userId, service, "expires_at", newExpiry);
    return j.access_token;
  } catch {
    return null;
  }
}

function header(headers: { name?: string; value?: string }[], name: string): string {
  for (const h of headers || []) if ((h.name || "").toLowerCase() === name.toLowerCase()) return h.value || "";
  return "";
}

/** Recursively pull the best text body (prefer text/plain) and base64url-decode it. */
function extractBody(payload: unknown): string {
  const p = payload as { mimeType?: string; body?: { data?: string }; parts?: unknown[] };
  if (!p) return "";
  const decode = (d?: string) => (d ? Buffer.from(d, "base64url").toString("utf8") : "");
  if (p.mimeType === "text/plain" && p.body?.data) return decode(p.body.data);
  if (p.parts?.length) {
    // prefer a text/plain part; fall back to the first text/* we find
    for (const part of p.parts) {
      const got = extractBody(part);
      if (got && (part as { mimeType?: string }).mimeType === "text/plain") return got;
    }
    for (const part of p.parts) {
      const got = extractBody(part);
      if (got) return got;
    }
  }
  if (p.mimeType?.startsWith("text/") && p.body?.data) return decode(p.body.data);
  return "";
}

/**
 * List + fetch recent messages for one mailbox. `query` is Gmail search syntax
 * (e.g. "newer_than:2d -in:chats"). Read-only. Returns [] on any error.
 */
export async function readMailbox(
  tenantId: string,
  userId: string,
  mailbox: "work" | "personal",
  opts: { query?: string; max?: number } = {},
): Promise<{ messages: MonitoredMessage[]; diag: string }> {
  const service: Service = mailbox === "personal" ? "gmail_oauth_personal" : "gmail_oauth";
  let bundle: Record<string, string>;
  try {
    bundle = await getUserIntegrationBundle(tenantId, userId, service);
  } catch {
    return { messages: [], diag: "no_bundle" };
  }
  if (!(bundle.scope || "").includes("gmail.readonly")) {
    return { messages: [], diag: "scope_missing_readonly" }; // connected with send-only scope
  }
  const token = await ensureAccessToken(tenantId, userId, service, bundle);
  if (!token) return { messages: [], diag: "token_refresh_failed" };
  const mailboxAddress = bundle.gmail_address || "";
  const query = opts.query || "newer_than:2d -in:chats";
  const max = Math.min(opts.max || 25, 50);
  const H = { authorization: `Bearer ${token}` };

  try {
    const listRes = await fetch(
      `${GMAIL_API}/messages?q=${encodeURIComponent(query)}&maxResults=${max}`,
      { headers: H, signal: AbortSignal.timeout(20_000) },
    );
    if (!listRes.ok) {
      const body = await listRes.text().catch(() => "");
      return { messages: [], diag: `list_http_${listRes.status}:${body.replace(/\s+/g, " ").slice(0, 160)}` };
    }
    const list = (await listRes.json()) as { messages?: { id: string }[] };
    const ids = (list.messages || []).map((m) => m.id);
    const out: MonitoredMessage[] = [];
    for (const id of ids) {
      try {
        const mr = await fetch(`${GMAIL_API}/messages/${id}?format=full`, { headers: H, signal: AbortSignal.timeout(20_000) });
        if (!mr.ok) continue;
        const msg = (await mr.json()) as {
          id: string; threadId: string; internalDate?: string;
          payload?: { headers?: { name?: string; value?: string }[] };
        };
        const hs = msg.payload?.headers || [];
        out.push({
          id: msg.id,
          threadId: msg.threadId,
          subject: header(hs, "Subject"),
          from: header(hs, "From"),
          to: header(hs, "To"),
          date: header(hs, "Date"),
          internalDate: msg.internalDate,
          body: extractBody(msg.payload).slice(0, 8000),
          mailboxAddress,
        });
      } catch {
        // skip a single unreadable message; keep the tick alive
      }
    }
    return { messages: out, diag: `ok_${out.length}` };
  } catch {
    return { messages: [], diag: "exception" };
  }
}
