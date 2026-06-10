/**
 * Submissions account Gmail send — Adon spec section 4 (2026-06-10).
 *
 * Builds RFC822 MIME, base64-url encodes, POSTs to
 * gmail.users.messages.send. Returns the Gmail message id, thread id,
 * and the RFC822 Message-Id header (needed for downstream reply
 * chaining via In-Reply-To / References).
 *
 * Retry policy (spec section 4):
 *   - 401 → refresh access token once, retry once. Second 401 bubbles.
 *   - 429 → wait 60s and retry once. Second 429 returns
 *           { ok: false, error: 'rate_limit_persisted' }.
 *   - Other 4xx/5xx → returns error with status + truncated body.
 *
 * Hard rules:
 *   - Never logs env vars (they're not in this file's reach anyway).
 *   - Never returns the access token in the response shape.
 *   - cc[] is rendered only when non-empty. No empty Cc: header.
 *   - In-Reply-To / References are written ONLY on reply sends (when
 *     inReplyTo is non-empty). Initial sends omit them entirely.
 */

import "server-only";
import {
  getAccessToken,
  getSubmissionsEmail,
  invalidateAccessToken,
} from "./submissions-gmail";

const SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GET_MESSAGE_METADATA_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages";

export type SendPayload = {
  to: string;
  cc?: string[];
  subject: string;
  body: string;
  /** Present on replies (so Gmail attaches to the existing thread). Omit on initial sends. */
  threadId?: string;
  /** RFC822 Message-Id of the prior message — required on replies for In-Reply-To. */
  inReplyTo?: string;
  /** Full chain of prior Message-Ids, oldest first — concatenated for References. */
  references?: string[];
};

export type SendResult =
  | {
      ok: true;
      /** Gmail's own message id (different from rfc822_message_id). */
      message_id: string;
      /** Gmail's thread id — persist on application_lender_threads.gmail_thread_id. */
      thread_id: string;
      /** RFC822 Message-Id header value (angle-bracketed). Used for In-Reply-To chains. */
      rfc822_message_id: string;
    }
  | { ok: false; error: string };

const FROM_ADDRESS_CACHE: { value: string } = { value: "" };

function fromHeader(): string {
  if (!FROM_ADDRESS_CACHE.value) {
    FROM_ADDRESS_CACHE.value = getSubmissionsEmail();
  }
  return `SunBiz Submissions <${FROM_ADDRESS_CACHE.value}>`;
}

/**
 * Base64-URL encoding per RFC 4648 §5. Gmail's API wants this shape
 * (standard base64 with + and / replaced and padding stripped).
 */
function base64UrlEncode(s: string): string {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Build the RFC822 message text. Headers, blank line, body. No
 * MIME-Version multipart for v1 — Adon's spec asks for a plain-text
 * email in Jordan's format. Attachments are deferred to a future
 * revision (out of scope for this build per the spec section 3.5
 * "out of scope for this build" note).
 */
function buildRfc822(payload: SendPayload, fromAddress: string): string {
  const headers: string[] = [];
  headers.push(`From: ${fromAddress}`);
  headers.push(`To: ${payload.to}`);
  if (payload.cc && payload.cc.length > 0) {
    headers.push(`Cc: ${payload.cc.join(", ")}`);
  }
  headers.push(`Subject: ${payload.subject}`);
  if (payload.inReplyTo && payload.inReplyTo.trim().length > 0) {
    headers.push(`In-Reply-To: ${payload.inReplyTo.trim()}`);
  }
  if (payload.references && payload.references.length > 0) {
    headers.push(`References: ${payload.references.join(" ")}`);
  }
  // RFC822: MIME-Version is optional for plain-text but Gmail prefers it
  // when present. Content-Type with charset prevents Gmail from
  // double-encoding em-dashes / accented characters.
  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: 7bit");
  return headers.join("\r\n") + "\r\n\r\n" + payload.body;
}

/**
 * Fetch the RFC822 Message-Id header for a freshly-sent message.
 * Gmail's send response returns its own message id + thread id but NOT
 * the RFC822 Message-Id we need for chaining replies. We GET the
 * message metadata immediately after send to extract it.
 *
 * Returns the angle-bracketed Message-Id, or empty string if we can't
 * find one (caller treats empty as "won't chain" — the reply still
 * sends but Gmail won't link it).
 */
async function fetchRfc822MessageId(
  messageId: string,
  accessToken: string,
): Promise<string> {
  try {
    const url = `${GET_MESSAGE_METADATA_URL}/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=Message-Id`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return "";
    const data = (await res.json()) as {
      payload?: { headers?: Array<{ name?: string; value?: string }> };
    };
    const headers = data.payload?.headers || [];
    for (const h of headers) {
      if (h?.name?.toLowerCase() === "message-id" && typeof h.value === "string") {
        return h.value.trim();
      }
    }
    return "";
  } catch {
    return "";
  }
}

async function sendOnce(
  payload: SendPayload,
  accessToken: string,
): Promise<Response> {
  const rfc822 = buildRfc822(payload, fromHeader());
  const raw = base64UrlEncode(rfc822);
  const body: Record<string, unknown> = { raw };
  if (payload.threadId && payload.threadId.trim().length > 0) {
    body.threadId = payload.threadId.trim();
  }
  return fetch(SEND_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/**
 * Send the email. Retries per spec section 4. Returns the discriminated
 * SendResult union; caller persists thread_id + rfc822_message_id to
 * application_lender_threads and message_id_history.
 */
export async function sendGmail(payload: SendPayload): Promise<SendResult> {
  try {
    let token = await getAccessToken();
    let res = await sendOnce(payload, token);

    // 401: refresh token once, retry once (spec section 4).
    if (res.status === 401) {
      invalidateAccessToken();
      token = await getAccessToken();
      res = await sendOnce(payload, token);
      if (res.status === 401) {
        const txt = (await res.text()).slice(0, 240);
        return { ok: false, error: `unauthorized_after_refresh:${txt}` };
      }
    }

    // 429: wait 60s and retry once (spec section 4).
    if (res.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      res = await sendOnce(payload, token);
      if (res.status === 429) {
        return { ok: false, error: "rate_limit_persisted" };
      }
    }

    if (!res.ok) {
      const txt = (await res.text()).slice(0, 240);
      return { ok: false, error: `gmail_http_${res.status}:${txt}` };
    }

    const data = (await res.json()) as {
      id?: string;
      threadId?: string;
    };
    if (!data.id || !data.threadId) {
      return { ok: false, error: "gmail_send_missing_ids" };
    }

    const rfc822 = await fetchRfc822MessageId(data.id, token);
    return {
      ok: true,
      message_id: data.id,
      thread_id: data.threadId,
      rfc822_message_id: rfc822,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "send_unknown_error",
    };
  }
}
