import { createHash } from "node:crypto";

/**
 * A stable RFC-5322 Message-ID for every transport attempted by one logical
 * dashboard send. This is not a substitute for the interaction reservation,
 * but it gives Gmail and recipient systems one identity when a confirmed
 * pre-delivery failure falls through to a second transport.
 */
export function gmailMessageIdForIdempotencyKey(idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
  return `<oasis-${digest}@oasisai.work>`;
}

type SmtpErrorLike = {
  code?: unknown;
  command?: unknown;
  responseCode?: unknown;
};

/**
 * Classify whether an SMTP failure proves that delivery never happened.
 *
 * A provider rejection (4xx/5xx), authentication failure, or failure before
 * DATA is definitely unsent and may safely use another transport. A timeout,
 * socket loss, or unclassified exception can happen after the server accepted
 * DATA, so it is deliberately terminal `delivery_unknown`: automatically
 * retrying that case is how one click becomes two emails.
 */
export function smtpFailureReason(error: unknown): "send_failed" | "delivery_unknown" {
  const candidate = (error && typeof error === "object" ? error : {}) as SmtpErrorLike;
  const responseCode = Number(candidate.responseCode);
  if (Number.isFinite(responseCode) && responseCode >= 400) return "send_failed";

  const code = String(candidate.code ?? "").trim().toUpperCase();
  if (code === "EAUTH" || code === "EENVELOPE") return "send_failed";

  const command = String(candidate.command ?? "").trim().toUpperCase();
  if (["CONN", "CONNECT", "EHLO", "HELO", "AUTH", "MAIL FROM", "RCPT TO"].includes(command)) {
    return "send_failed";
  }

  return "delivery_unknown";
}
