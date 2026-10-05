/**
 * verify-oasis-mailbox.mjs — prove the shared OASIS mailbox actually sends.
 *
 * A stored credential is not a working one, and the first person to discover
 * otherwise must not be a rep on a live call. This authenticates against Gmail
 * and, with --send, delivers one real message TO THE MAILBOX ITSELF so the test
 * can never reach a prospect.
 *
 * Reads OASIS_MAIL_FROM / OASIS_MAIL_APP_PASSWORD from the environment. Prints
 * neither: only the address, a masked tail, and the outcome.
 *
 *   node scripts/verify-oasis-mailbox.mjs           # auth only
 *   node scripts/verify-oasis-mailbox.mjs --send    # auth + one real email
 */

import process from "node:process";

const FROM = (process.env.OASIS_MAIL_FROM || "").trim();
// Google displays an app password as four spaced groups; a spaced paste is 19
// characters for a 16-character secret and returns 535 on SMTP while working
// over IMAP, so the channel looks half-alive and the failure reads as a wrong
// password. Strip all whitespace, exactly as the sender does.
const PASS = (process.env.OASIS_MAIL_APP_PASSWORD || "").replace(/\s+/g, "");
const SEND = process.argv.includes("--send");
/** Optional: prove the CC and Reply-To headers actually land in a real inbox. */
const CC_TO = (process.env.OASIS_TEST_CC || "").trim();

if (!FROM || !PASS) {
  console.error("[verify] OASIS_MAIL_FROM / OASIS_MAIL_APP_PASSWORD not set in this environment");
  process.exit(1);
}
console.log(`[verify] mailbox  ${FROM}`);
console.log(`[verify] password ${"*".repeat(Math.max(0, PASS.length - 4))}${PASS.slice(-4)} (${PASS.length} chars)`);

const nodemailer = await import("nodemailer");
const transporter = nodemailer.default.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: { user: FROM, pass: PASS },
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
});

try {
  await transporter.verify();
  console.log("[verify] SMTP AUTH: OK");
} catch (e) {
  const first = e instanceof Error ? e.message.split("\n")[0] : String(e);
  console.error(`[verify] SMTP AUTH: FAILED — ${first}`);
  console.error(
    "  535 means Gmail rejected the credential: wrong app password, or it belongs " +
      "to a different account than OASIS_MAIL_FROM.",
  );
  process.exit(2);
}

if (!SEND) process.exit(0);

try {
  const info = await transporter.sendMail({
    from: FROM,
    to: FROM,
    // CC + Reply-To exercised for real. The whole point of this feature is that
    // the rep gets a copy and the prospect's reply comes back to THEM, so a
    // test that omits both proves only that SMTP works.
    ...(CC_TO ? { cc: CC_TO, replyTo: CC_TO } : {}),
    subject: "OASIS shared mailbox: live connection test",
    text:
      "Automated test from verify-oasis-mailbox.\n\n" +
      "If you can read this, rep emails send from this mailbox and each rep is " +
      "CC'd on their own send, with replies routed back to them.\n",
  });
  console.log(`[verify] TEST EMAIL SENT. message id ${info.messageId}`);
  console.log(`[verify] check ${FROM} for it.`);
} catch (e) {
  const first = e instanceof Error ? e.message.split("\n")[0] : String(e);
  console.error(`[verify] TEST SEND FAILED — ${first}`);
  process.exit(3);
}
