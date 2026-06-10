/**
 * Submissions account SMTP send — Adon spec section 4 (2026-06-10),
 * pivoted to App Password auth (2026-06-10 PM).
 *
 * Builds RFC822 MIME via nodemailer + sends through Gmail's SMTP relay.
 * Returns the synthesized RFC822 Message-Id so the caller can persist
 * it for chained replies (In-Reply-To + References).
 *
 * Gmail threading on the recipient side:
 *   Gmail groups conversations on the recipient by matching In-Reply-To
 *   / References headers to a Message-Id they've seen before. We
 *   synthesize deterministic Message-Ids per (application, lender,
 *   sequence) so the reply endpoint's chain is reconstructable from the
 *   DB without needing a Gmail API thread_id.
 *
 * Retry policy:
 *   SMTP transient failures (timeout, ECONNRESET, code 4xx) → wait 60s
 *   retry once. Second failure returns {ok:false, error:'rate_limit_persisted'}
 *   to match Adon spec section 4's 429 semantics.
 *   Permanent failures (5xx, auth failure) → no retry, return immediately.
 */

import "server-only";
import { randomUUID } from "node:crypto";
import { getSubmissionsCreds, getSubmissionsFrom } from "./submissions-gmail";

export type SendPayload = {
  to: string;
  cc?: string[];
  subject: string;
  body: string;
  /**
   * Synthesized thread anchor — passed back from a prior send on the
   * same (application, lender) pair. NOT a Gmail API thread_id; it's
   * the FIRST RFC822 Message-Id of the chain so we can persist it as
   * the per-thread anchor in application_lender_threads.gmail_thread_id.
   * Omit on initial sends — the caller persists the returned Message-Id
   * as the anchor.
   */
  threadId?: string;
  /** Most recent Message-Id in the chain (for In-Reply-To). Required on replies. */
  inReplyTo?: string;
  /** Full chain of prior Message-Ids, oldest first (for References). */
  references?: string[];
  /** Per-tenant credential lookup; pass through from the route's auth context. */
  tenantId: string;
};

export type SendResult =
  | {
      ok: true;
      /** Nodemailer's envelope/messageId — useful for SMTP-level audit. */
      message_id: string;
      /**
       * RFC822 Message-Id we generated — angle-bracketed, persistable.
       * Goes into application_lender_threads.last_message_id and gets
       * appended to message_id_history.
       */
      rfc822_message_id: string;
      /**
       * Thread anchor — equals the FIRST RFC822 Message-Id on this
       * (application, lender) thread. Initial sends return the same
       * value as rfc822_message_id; replies preserve the original
       * anchor passed in via payload.threadId.
       */
      thread_id: string;
    }
  | { ok: false; error: string };

/**
 * Synthesize an RFC 5322-compliant Message-Id. Format:
 *   <{uuid}@sunbizfunding.com>
 * Angle-bracketed per spec. The domain part MUST be a real domain (not
 * a label like 'sunbiz-submissions') — some lender mail systems run
 * SPF / Message-Id sanity checks and reject messages whose Message-Id
 * domain doesn't resolve. uuid is random per-message; Gmail's SMTP
 * relay preserves client-set Message-Ids when the format is valid,
 * which is what makes our chain-via-References work on the recipient
 * side without needing the Gmail API.
 */
function synthesizeMessageId(): string {
  return `<${randomUUID()}@sunbizfunding.com>`;
}

async function sendOnce(
  payload: SendPayload,
  generatedMessageId: string,
): Promise<{ ok: true; nodemailerMessageId: string } | { ok: false; error: string; transient: boolean }> {
  try {
    const nodemailer = await import("nodemailer");
    const creds = await getSubmissionsCreds(payload.tenantId);
    const from = await getSubmissionsFrom(payload.tenantId);

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: creds.fromAddress, pass: creds.appPassword },
    });

    const headers: Record<string, string> = {
      "Message-Id": generatedMessageId,
    };
    if (payload.inReplyTo && payload.inReplyTo.trim().length > 0) {
      headers["In-Reply-To"] = payload.inReplyTo.trim();
    }
    if (payload.references && payload.references.length > 0) {
      headers["References"] = payload.references.join(" ");
    }

    const info = await transporter.sendMail({
      from,
      to: payload.to,
      cc: payload.cc && payload.cc.length > 0 ? payload.cc.join(", ") : undefined,
      subject: payload.subject,
      text: payload.body,
      headers,
    });
    return { ok: true, nodemailerMessageId: info.messageId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Common transient signals from Gmail SMTP: 4.x.x status codes, network errors.
    const transient =
      /ETIMEDOUT|ECONNRESET|ECONNREFUSED|421|450|451|452/i.test(msg);
    return { ok: false, error: msg, transient };
  }
}

/**
 * Send the email. Synthesizes a Message-Id, builds the RFC822 envelope,
 * fires through Gmail SMTP. Returns the persistable IDs.
 */
export async function sendGmail(payload: SendPayload): Promise<SendResult> {
  const generatedMessageId = synthesizeMessageId();

  let attempt = await sendOnce(payload, generatedMessageId);

  // Transient failure → wait 60s + retry once (mirrors Adon spec's 429
  // semantics; Gmail SMTP returns 4.x.x rather than HTTP 429).
  if (!attempt.ok && attempt.transient) {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    attempt = await sendOnce(payload, generatedMessageId);
    if (!attempt.ok) {
      return { ok: false, error: "rate_limit_persisted" };
    }
  }

  if (!attempt.ok) {
    return { ok: false, error: attempt.error.slice(0, 240) };
  }

  // Thread anchor: caller-supplied threadId (existing thread on reply)
  // OR the generated id (new thread on initial send).
  const threadAnchor =
    payload.threadId && payload.threadId.trim().length > 0
      ? payload.threadId.trim()
      : generatedMessageId;

  return {
    ok: true,
    message_id: attempt.nodemailerMessageId,
    rfc822_message_id: generatedMessageId,
    thread_id: threadAnchor,
  };
}
