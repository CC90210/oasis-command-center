/**
 * lib/integrations/gmail-apppassword-send.ts — send a single email AS the
 * operator, from THEIR own Gmail, using a Gmail App Password over SMTP. The
 * OAuth-free sibling of sendGmailAsOperator.
 *
 * When an operator connected their mailbox by app password (the same creds the
 * IMAP monitor reads: user_integration_credentials service='gmail_imap' =
 * { address, app_password }), this sends FROM that address via smtp.gmail.com:587
 * STARTTLS — no Google Cloud project, no API enablement, no OAuth. Mirrors
 * submissions-gmail-send.ts's transport and the gmail-oauth-send.ts contract:
 * suppression gate FIRST + fail closed, CAN-SPAM footer appended, and NEVER
 * throws (returns a typed result so the route can fall back to the queue).
 */

import "server-only";
import { getUserIntegrationBundle } from "@/lib/user-integration-store";
import { checkEmailSuppressed } from "@/lib/lead-interactions-queries";

// Same footer as the OAuth path (gmail-oauth-send.ts). The submissions@ queue
// gets its footer from send_gateway; a direct send must append it here.
const CANSPAM_FOOTER =
  "\n\n---\nSunBiz Funding LLC\n1 East Broward Blvd, Suite 700\nFort Lauderdale, FL 33301\n\n" +
  "You received this email because you submitted a funding inquiry. To stop receiving emails, reply UNSUBSCRIBE.";

export type GmailAppPasswordSendResult =
  | { ok: true; provider: "gmail_apppassword"; gmail_message_id: string; from_address: string }
  | {
      ok: false;
      provider: "gmail_apppassword";
      reason: "not_connected" | "send_failed" | "suppressed" | "suppression_error";
      error: string;
    };

/** True when this operator has an app-password mailbox on file (address + app_password). */
export async function operatorHasAppPassword(tenantId: string, userId: string): Promise<boolean> {
  if (!tenantId || !userId) return false;
  const b = await getUserIntegrationBundle(tenantId, userId, "gmail_imap").catch(() => ({} as Record<string, string>));
  return !!(b.address && b.app_password);
}

/**
 * Send one email as the operator, from their app-password Gmail. Appends the
 * CAN-SPAM footer. Never throws.
 */
export async function sendGmailAppPasswordAsOperator(args: {
  tenantId: string;
  userId: string;
  to: string;
  subject: string;
  body: string;
}): Promise<GmailAppPasswordSendResult> {
  // Opt-out gate FIRST — before any credential work or send. Fail closed.
  const supp = await checkEmailSuppressed(args.tenantId, args.to);
  if (supp.suppressed) {
    return { ok: false, provider: "gmail_apppassword", reason: "suppressed", error: "recipient in email_suppressions" };
  }
  if (supp.checkFailed) {
    return { ok: false, provider: "gmail_apppassword", reason: "suppression_error", error: "suppression lookup failed — send blocked" };
  }

  const b = await getUserIntegrationBundle(args.tenantId, args.userId, "gmail_imap").catch(() => ({} as Record<string, string>));
  const fromAddress = (b.address || "").trim();
  const appPassword = (b.app_password || "").replace(/\s+/g, "");
  if (!fromAddress || !appPassword) {
    return { ok: false, provider: "gmail_apppassword", reason: "not_connected", error: "no gmail_imap bundle" };
  }

  try {
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com", port: 587, secure: false, requireTLS: true,
      auth: { user: fromAddress, pass: appPassword },
    });
    const info = await transporter.sendMail({
      from: fromAddress,
      to: args.to,
      subject: args.subject,
      text: args.body.replace(/\s+$/, "") + CANSPAM_FOOTER,
    });
    return { ok: true, provider: "gmail_apppassword", gmail_message_id: info.messageId || "", from_address: fromAddress };
  } catch (e) {
    return {
      ok: false,
      provider: "gmail_apppassword",
      reason: "send_failed",
      error: e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "smtp_error",
    };
  }
}
