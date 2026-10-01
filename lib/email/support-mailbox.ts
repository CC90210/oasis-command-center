/**
 * lib/email/support-mailbox.ts - may OASIS's system mail leave FROM
 * support@oasisai.work yet?
 *
 * The ADDRESS is published from one place, lib/legal/constants.ts
 * (OASIS_SUPPORT_EMAIL): the legal pages, the marketing site, the error and
 * opt-out pages, and the Reply-To of every email OASIS sends a client. SENDING
 * from it needs its credential on the Worker, which arrives separately. Until
 * then each sender keeps the mailbox it used before and says so in ONE log line
 * (logSupportSenderFallback): "support@ is not configured" must be readable in
 * the logs, never inferred from a From header nobody looked at.
 *
 * WHO SENDS AS SUPPORT (2026-10-01):
 *   - the support desk: client acknowledgements and replies, and the desk's
 *     alerts to the team (lib/delivery/notify.ts)
 *   - a teammate writing to a client from the Clients hub
 *     (app/api/clients/[id]/reply/route.ts)
 *   - an approved agent email to a client (lib/os/approvals/executors.ts)
 *   - invoices and reminders (lib/founders-finances/invoice-email.ts), after an
 *     explicit INVOICE_FROM_* override
 *   - account-security mail: invites and password resets (lib/auth-email.ts),
 *     after a dedicated AUTH_* sender
 * Rep email to leads and prospects is SALES mail and is untouched: it keeps the
 * shared OASIS mailbox (lib/email/brands.ts) and the founder's own outreach.
 *
 * THE SECRET NAMES. SUPPORT_GMAIL_USER + SUPPORT_GMAIL_APP_PASSWORD: the same
 * shape as the live GMAIL_USER + GMAIL_APP_PASSWORD pair, and the names the
 * support account's credentials already carry in BEA's .env.agents, so the
 * Worker secret manifest pushes them one to one. A Google app password over
 * SMTP, like every other mailbox here: no OAuth client, no redirect URI.
 *
 * THE USER MUST BE THE PUBLISHED ADDRESS. A support credential for any other
 * mailbox is refused and logged as an error: mail that says "write to support@"
 * while leaving from somewhere else is the drift this module exists to rule
 * out. The brand guard (mailboxBrandConflict) still runs on every send after
 * this.
 *
 * Pure over its env argument; no I/O beyond the one log line.
 */
import { OASIS_SUPPORT_EMAIL } from "@/lib/legal/constants";

/** Worker secret holding the support mailbox's login. Must equal OASIS_SUPPORT_EMAIL. */
export const SUPPORT_MAILBOX_USER_ENV = "SUPPORT_GMAIL_USER";
/** Worker secret holding that mailbox's Google app password. */
export const SUPPORT_MAILBOX_PASSWORD_ENV = "SUPPORT_GMAIL_APP_PASSWORD";

/** The display name on mail that leaves from the support mailbox. */
export const OASIS_SUPPORT_FROM_NAME = "OASIS AI Support";

/**
 * What an OASIS email is for, which decides where it leaves from, where replies
 * go and which footer it carries. "sales": a rep's email to a lead (the
 * default, unchanged). "support": OASIS's system mail to its clients and its
 * desk (the list in this file's header).
 */
export type OasisMailPurpose = "sales" | "support";

type Env = Record<string, string | undefined>;

export type SupportMailboxResolution =
  | { ok: true; address: string; password: string }
  | { ok: false; reason: "not_configured" | "wrong_mailbox"; detail: string };

/** The support mailbox's credential, when the Worker holds a usable one for support@. */
export function resolveSupportMailbox(env: Env = process.env): SupportMailboxResolution {
  const user = (env[SUPPORT_MAILBOX_USER_ENV] || "").trim().toLowerCase();
  // Google shows an app password as four spaced groups, and a value pasted that
  // way authenticates against IMAP in some clients and fails SMTP with 535.
  const password = (env[SUPPORT_MAILBOX_PASSWORD_ENV] || "").replace(/\s+/g, "");
  if (!user || !password) {
    const missing = [user ? null : SUPPORT_MAILBOX_USER_ENV, password ? null : SUPPORT_MAILBOX_PASSWORD_ENV]
      .filter(Boolean)
      .join(" and ");
    return { ok: false, reason: "not_configured", detail: `${missing} not set` };
  }
  if (user !== OASIS_SUPPORT_EMAIL) {
    // The configured value is not echoed: the name of the secret is enough to
    // find it, and a log line is no place for credentials-adjacent values.
    return { ok: false, reason: "wrong_mailbox", detail: `${SUPPORT_MAILBOX_USER_ENV} is not ${OASIS_SUPPORT_EMAIL}` };
  }
  return { ok: true, address: OASIS_SUPPORT_EMAIL, password };
}

/**
 * The one log line a sender writes when support mail cannot leave from
 * support@ and goes out from its previous mailbox instead (or not at all).
 * A wrong mailbox is a misconfiguration and logs as an error; a missing one is
 * the expected state until the secrets are pushed, and logs as a warning.
 */
export function logSupportSenderFallback(
  surface: string,
  resolution: Extract<SupportMailboxResolution, { ok: false }>,
  fallbackFrom: string | null,
): void {
  const line =
    `[support-mail] ${surface}: not sent from ${OASIS_SUPPORT_EMAIL} (${resolution.detail}); ` +
    (fallbackFrom
      ? `sending from ${fallbackFrom} instead, replies still go to ${OASIS_SUPPORT_EMAIL}`
      : "no other mailbox is configured either");
  if (resolution.reason === "wrong_mailbox") console.error(line);
  else console.warn(line);
}
