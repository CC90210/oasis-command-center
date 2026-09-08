/**
 * lib/integrations/oasis-shared-gmail-send.ts — send an OASIS rep's email from
 * ONE shared mailbox, with the rep CC'd.
 *
 * WHY THIS SHAPE (CC, 2026-09-08): "use my app password, then just CC/forward
 * the reps with their emails, and make this as easy as possible." One mailbox
 * for the whole team, not a Gmail connection per rep. A rep never has to set
 * anything up, and a new rep works on day one.
 *
 * WHAT IT REPLACES. Every OASIS rep email was going out through the bridge to
 * send_gateway on CC's own machine. That path is brand-correct and it works,
 * but it is only alive while that machine is. Five emails have sat queued since
 * 2026-08-20 because of it, and a rep sending into that silence cannot tell a
 * slow send from a dead one. This path runs from Vercel and does not care
 * whether any particular computer is switched on.
 *
 * THE REP IS CC'd, ALWAYS. Sending from a shared mailbox means the message
 * lands in nobody's personal Sent folder, so without the CC a rep has no copy
 * anywhere and a successful send is indistinguishable from a failure. That is
 * exactly what happened on 2026-09-08: a send the ledger recorded as delivered
 * was reported as never sent, and the rep pressed the button again.
 *
 * OASIS FOOTER, NOT THE DEFAULT. appendSignatureAndFooter defaults to SunBiz's
 * legal footer, which is correct for that portal and false on an OASIS lead
 * (wrong company, wrong country, and it tells a cold prospect they submitted a
 * funding inquiry). `brand: "oasis"` is not optional here.
 *
 * NEVER THROWS. Returns a typed result so the route can fall back to the bridge
 * exactly as it does today. Until the credential is stored this returns
 * `not_configured` on every call and the existing path carries on unchanged.
 */

import "server-only";
import { getTenantIntegrationBundle } from "@/lib/tenant-integration-store";
import { checkEmailSuppressed } from "@/lib/lead-interactions-queries";
import { appendSignatureAndFooter, type EmailSigner } from "@/lib/config/email-signature";

/**
 * `tenant_integration_credentials.service` holding the shared OASIS mailbox.
 *
 * Deliberately NOT "gws". That service key is the Google Workspace row the
 * integrations settings page already manages for Calendar/Drive/Docs, and
 * overloading it would mean a rep rotating a Calendar credential silently
 * changes who outbound sales email comes from. A separate key keeps the two
 * decisions separate.
 */
export const OASIS_MAIL_SERVICE = "oasis_gmail";

export type OasisSharedSendResult =
  | { ok: true; provider: "oasis_shared_gmail"; gmail_message_id: string; from_address: string }
  | {
      ok: false;
      provider: "oasis_shared_gmail";
      reason: "not_configured" | "send_failed" | "suppressed" | "suppression_error";
      error: string;
    };

/** True when the shared OASIS mailbox is configured for this tenant. */
export async function oasisSharedMailboxConfigured(tenantId: string): Promise<boolean> {
  if (!tenantId) return false;
  const b = await getTenantIntegrationBundle(tenantId, OASIS_MAIL_SERVICE).catch(
    () => ({}) as Record<string, string>,
  );
  return !!(b.from_address && b.app_password);
}

export async function sendOasisSharedGmail(args: {
  tenantId: string;
  to: string;
  /** The acting rep, CC'd so they get a copy. Skipped when it equals `to`. */
  cc?: string | null;
  subject: string;
  body: string;
  /** The acting rep, so the sign-off is theirs and not the mailbox owner's. */
  signer?: EmailSigner | null;
}): Promise<OasisSharedSendResult> {
  // OPT-OUT GATE FIRST, before any credential work or send. Fail closed: a
  // suppression lookup that errors must not be read as "not suppressed".
  // checkEmailSuppressed CATCHES ITS OWN ERRORS and returns
  // { suppressed: false, checkFailed: true } rather than throwing
  // (lib/lead-interactions-queries.ts:144-147). So a try/catch around it is
  // dead code, and reading only `.suppressed` treats a FAILED LOOKUP as
  // "not suppressed" and emails someone who may have opted out. `checkFailed`
  // is the whole point of the return shape and has to be read.
  let supp: { suppressed: boolean; checkFailed: boolean };
  try {
    supp = await checkEmailSuppressed(args.tenantId, args.to);
  } catch (e) {
    // Belt and braces: it does not throw today, but a future rewrite that does
    // must not silently become a fail-open.
    return {
      ok: false,
      provider: "oasis_shared_gmail",
      reason: "suppression_error",
      error: e instanceof Error ? e.message.slice(0, 200) : "suppression_check_failed",
    };
  }
  if (supp.checkFailed) {
    return {
      ok: false,
      provider: "oasis_shared_gmail",
      reason: "suppression_error",
      error: "suppression lookup failed; refusing to send rather than assume consent",
    };
  }
  if (supp.suppressed) {
    return {
      ok: false,
      provider: "oasis_shared_gmail",
      reason: "suppressed",
      error: "recipient in email_suppressions",
    };
  }

  const bundle = await getTenantIntegrationBundle(args.tenantId, OASIS_MAIL_SERVICE).catch(
    () => ({}) as Record<string, string>,
  );
  const fromAddress = (bundle.from_address || "").trim();
  // Strip ALL whitespace, not just the ends. Google displays an app password as
  // four spaced groups, and a value pasted that way is 19 characters for a
  // 16-character secret — which authenticates against IMAP in some clients and
  // returns 535 on SMTP, so the channel looks half-alive and the failure reads
  // as a wrong password when it is really a formatting one. The SunBiz path
  // learned this on 2026-07-02; inherited here rather than re-learned.
  const appPassword = (bundle.app_password || "").replace(/\s+/g, "");
  if (!fromAddress || !appPassword) {
    return {
      ok: false,
      provider: "oasis_shared_gmail",
      reason: "not_configured",
      error: `no ${OASIS_MAIL_SERVICE} from_address/app_password for this tenant`,
    };
  }

  // Never put the same address in To and Cc.
  const cc = (args.cc || "").trim();
  const ccFinal = cc && cc.toLowerCase() !== args.to.trim().toLowerCase() ? cc : undefined;

  try {
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: { user: fromAddress, pass: appPassword },
      // EXPLICIT TIMEOUTS, well inside the route's 60s maxDuration.
      //
      // Nodemailer defaults to a 120s connection timeout and a 600s socket
      // timeout. This call runs BEFORE the bridge fallback, so on a hung SMTP
      // the defaults would keep sendMail pending until Vercel terminated the
      // whole request: the fallback never runs, the rep gets no answer, and the
      // "immediate send, else bridge" contract is quietly lost. Failing fast
      // here is what keeps the fallback reachable.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    const info = await transporter.sendMail({
      from: fromAddress,
      to: args.to,
      ...(ccFinal ? { cc: ccFinal } : {}),
      // Replies go to the REP, not the shared mailbox. Without this the prospect
      // answers into an inbox the rep does not watch, which is the same
      // invisibility the CC exists to fix, one step later in the conversation.
      ...(ccFinal ? { replyTo: ccFinal } : {}),
      subject: args.subject,
      text: appendSignatureAndFooter(args.body, {
        signer: args.signer,
        fromAddress,
        brand: "oasis",
      }),
    });
    return {
      ok: true,
      provider: "oasis_shared_gmail",
      gmail_message_id: info.messageId || "",
      from_address: fromAddress,
    };
  } catch (e) {
    return {
      ok: false,
      provider: "oasis_shared_gmail",
      reason: "send_failed",
      // First line only: SMTP errors carry multi-line server chatter and the
      // useful part is the code. Truncated so a credential can never ride out
      // in an error string.
      error: e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "smtp_error",
    };
  }
}
