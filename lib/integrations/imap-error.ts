import "server-only";

/**
 * Turn an ImapFlow connect failure into something an operator can act on.
 *
 * WHY THIS EXISTS. `scan-lender-replies` and `scan-bounces` both did
 * `"imap_connect_" + e.message`, and ImapFlow's message for a rejected login is
 * the entirely generic **"Command failed"**. The offers scanner logged exactly
 * `http 502 imap_connect_Command failed imap` every 8 minutes from 2026-08-06
 * to 2026-08-10 — 838 blocked ticks that said the mailbox was broken and
 * nothing whatsoever about why.
 *
 * That cost real time: Adon rotated the Gmail app password on the reasonable
 * assumption it had been revoked, and the error afterwards was byte-identical,
 * so the rotation could not be confirmed or ruled out. A failure message that
 * cannot distinguish "wrong password" from "IMAP is switched off" turns a
 * five-minute fix into guesswork.
 *
 * ImapFlow already carries the answer on the error object — `authenticationFailed`
 * and `responseText`, which for Gmail is its actual IMAP response ("Invalid
 * credentials (Failure)", "[ALERT] Application-specific password required",
 * "[ALERT] Please log in via your web browser"). This surfaces it.
 *
 * SAFE TO LOG. It reads only the server's own response text. It never touches
 * the password, and Gmail's IMAP failure responses do not echo credentials.
 */
export interface ImapFailure {
  /** Compact machine-ish string for the error field and the scanner log. */
  summary: string;
  /** True when the server explicitly rejected the login. */
  authFailed: boolean;
  /** The server's own words, when it gave any. */
  serverSaid: string | null;
  /** What the operator should actually do about it. */
  hint: string;
}

const MAX = 200;

export function describeImapError(e: unknown): ImapFailure {
  const err = (e ?? {}) as {
    message?: string;
    authenticationFailed?: boolean;
    responseText?: string;
    response?: string;
    code?: string;
  };

  const message = String(err.message || "unknown").slice(0, MAX);
  const serverSaidRaw = err.responseText || err.response || "";
  const serverSaid = serverSaidRaw ? String(serverSaidRaw).slice(0, MAX) : null;
  const authFailed = err.authenticationFailed === true;
  const blob = `${message} ${serverSaid ?? ""}`.toLowerCase();

  // Ordered most-specific first: Gmail says "application-specific password
  // required" for a plain-password attempt, and "invalid credentials" for a
  // wrong or revoked app password. They need different fixes, so they must not
  // collapse into one message.
  let hint: string;
  if (/application-specific password/.test(blob)) {
    hint = "Gmail wants an APP PASSWORD, not the account password. Generate one at myaccount.google.com/apppasswords and store that.";
  } else if (/invalid credentials|authentication fail|username and password not accepted/.test(blob)) {
    hint = "Gmail rejected the app password. Regenerate it, and confirm it belongs to the SAME account as from_address — an app password from a different Google account fails exactly like a revoked one.";
  } else if (/imap access is disabled|imap is disabled|not enabled/.test(blob)) {
    hint = "The password is fine; IMAP is switched off for this mailbox. Enable it in Gmail settings, or in the Workspace admin console if the org disabled it.";
  } else if (/log in via your web browser|web login required|unusual activity/.test(blob)) {
    hint = "Google has flagged the sign-in. Log into the mailbox in a browser once to clear the block, then let the next scan run.";
  } else if (/timeout|etimedout|econnreset|enotfound|socket/.test(blob)) {
    hint = "Network or DNS, not credentials — the connection never completed. Usually transient; check again after the next tick.";
  } else if (authFailed) {
    hint = "The server rejected the login but gave no reason. Treat as a bad or revoked app password.";
  } else {
    hint = "Not an authentication failure. Check the server response above before touching the password.";
  }

  const summary = serverSaid ? `${message} :: ${serverSaid}` : message;
  return { summary: summary.slice(0, MAX * 2), authFailed, serverSaid, hint };
}
