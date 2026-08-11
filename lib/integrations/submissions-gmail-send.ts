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
import { domainOfAddress, messageIdDomain } from "@/lib/email/sending-identity";
import type { BrandKey } from "@/lib/email/brands";

export type SendPayload = {
  to: string;
  cc?: string[];
  subject: string;
  body: string;
  /**
   * Optional HTML alternative — nodemailer sends a proper multipart/
   * alternative when both `html` and `text` (body, below) are set, so
   * `body` MUST stay a true plaintext rendering (not markup-stripped
   * HTML) as the fallback for clients that can't render HTML. Omit for
   * plaintext-only sends (every existing caller keeps working unchanged).
   */
  html?: string;
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
  /**
   * RFC 8058 List-Unsubscribe header value, e.g.
   * `<https://…/unsubscribe?…>, <mailto:…?subject=unsubscribe>`. When set, both
   * `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
   * are emitted (Gmail/Yahoo bulk-sender one-click opt-out). Omit for
   * transactional/reply sends — every existing caller keeps working unchanged.
   */
  listUnsubscribe?: string;
  /**
   * Optional display name for the From header, e.g. "Bluerise Business Capital".
   * Omit to keep the shared default from getSubmissionsFrom(). Exists so ONE
   * caller can rebrand without dragging lender shop-out mail along with it; the
   * sending address is unchanged either way.
   */
  fromName?: string;
  /** Per-tenant credential lookup; pass through from the route's auth context. */
  tenantId: string;
  /**
   * Which brand sends this message. Selects the credential row, and therefore
   * the mailbox that authenticates and the domain that DKIM-signs.
   *
   * Omit for SunBiz, which is every existing caller. Lender shop-out mail must
   * NEVER set this: lenders only ever receive paper from the SunBiz brand,
   * whatever brand the merchant sits on (Adon, 2026-08-05). That rule is held
   * by tests/shopout-brand-lock.test.ts, not by convention.
   */
  brand?: BrandKey;
  /** Disable the built-in 60s retry for request-bound callers with a queue fallback. */
  retryTransient?: boolean;
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
      /**
       * The From header this message was ACTUALLY sent with, display name and
       * all. Returned rather than left for the caller to re-derive, because a
       * caller that re-derives gets the shared default and would audit a
       * rebranded send under the wrong identity (Codex review P2).
       */
      from_identity: string;
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
function synthesizeMessageId(senderDomain?: string): string {
  // Derived from the domain of the address the recipient will actually SEE
  // (2026-07-29). A Message-Id whose domain does not match the visible sender is
  // scored against by some filters.
  //
  // `senderDomain` is the RESOLVED per-tenant sender. It matters that this is not
  // simply the global configured domain: sendOnce resolves From per tenant via
  // getSubmissionsFrom, so stamping a globally-configured domain here would put
  // one tenant's domain on another tenant's mail, and would put the new brand's
  // domain on mail still going out under the old sender during a cutover. That is
  // the very mismatch this work exists to remove (Codex review P1).
  //
  // Falls back to the configured identity, then to the legacy domain.
  return `<${randomUUID()}@${senderDomain || messageIdDomain()}>`;
}

async function sendOnce(
  payload: SendPayload,
  generatedMessageId: string,
): Promise<{ ok: true; nodemailerMessageId: string; fromIdentity: string } | { ok: false; error: string; transient: boolean }> {
  try {
    const nodemailer = await import("nodemailer");
    // The brand selects the CREDENTIAL, which is what makes the visible sender
    // and the DKIM signature agree. Absent brand = SunBiz = today's behaviour,
    // and lender shop-out mail deliberately never passes one.
    const creds = await getSubmissionsCreds(payload.tenantId, payload.brand);
    // The display name in front of the address. getSubmissionsFrom() supplies a
    // shared default ("SunBiz Submissions") used by lender shop-out mail as well,
    // so a caller that needs to rebrand ONLY its own mail passes `fromName` and
    // leaves every other caller untouched. The ADDRESS is always the tenant's
    // real authenticated mailbox either way — only the label changes.
    const from = payload.fromName
      ? `${payload.fromName} <${creds.fromAddress}>`
      : await getSubmissionsFrom(payload.tenantId, payload.brand);

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
    if (payload.listUnsubscribe && payload.listUnsubscribe.trim().length > 0) {
      headers["List-Unsubscribe"] = payload.listUnsubscribe.trim();
      headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    }

    const info = await transporter.sendMail({
      from,
      to: payload.to,
      cc: payload.cc && payload.cc.length > 0 ? payload.cc.join(", ") : undefined,
      subject: payload.subject,
      text: payload.body,
      ...(payload.html ? { html: payload.html } : {}),
      headers,
    });
    return { ok: true, nodemailerMessageId: info.messageId, fromIdentity: from };
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
  // Resolve the tenant's real sender FIRST so the Message-Id domain matches the
  // From header the recipient sees. sendOnce resolves the same value for the
  // actual send; a failure here is non-fatal because the Message-Id is only a
  // threading aid, and sendOnce will surface a genuine credential problem.
  let senderDomain: string | undefined;
  try {
    senderDomain =
      domainOfAddress(await getSubmissionsFrom(payload.tenantId, payload.brand)) || undefined;
  } catch {
    /* fall back to the configured identity */
  }
  // Fall back to the BRAND's Message-Id domain, not the global one: on a
  // Bluerise send whose credential lookup transiently failed, stamping the
  // SunBiz domain would put the wrong brand in the Message-Id of a message the
  // retry then sends as Bluerise.
  const generatedMessageId = synthesizeMessageId(senderDomain || messageIdDomain(payload.brand));

  let attempt = await sendOnce(payload, generatedMessageId);

  // Transient failure → wait 60s + retry once (mirrors Adon spec's 429
  // semantics; Gmail SMTP returns 4.x.x rather than HTTP 429).
  if (!attempt.ok && attempt.transient && payload.retryTransient !== false) {
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
    from_identity: attempt.fromIdentity,
    rfc822_message_id: generatedMessageId,
    thread_id: threadAnchor,
  };
}
