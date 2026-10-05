/**
 * provision-oasis-mailbox.mjs — store the shared OASIS sending mailbox.
 *
 * WHAT IT DOES. Writes `from_address` and `app_password` into
 * tenant_integration_credentials under service `oasis_gmail`, AES-256-GCM
 * encrypted by the same helper every other credential uses. Once those two rows
 * exist, /api/leads/[id]/email sends OASIS rep email straight from Vercel
 * through that mailbox, with the rep CC'd, instead of routing through the
 * bridge to send_gateway on a particular machine.
 *
 * WHY A SCRIPT RATHER THAN A SETTINGS SCREEN. The value already exists in the
 * operator's .env.agents. Retyping a 16-character secret into a web form is a
 * chance to mistype it, and the failure mode of a mistyped app password is an
 * SMTP 535 that reads like a broken feature. This moves the value machine-to-
 * machine. It is also readable start to finish, which a settings form is not.
 *
 * THE SECRET IS NEVER PRINTED, LOGGED, OR RETURNED. It is read from the
 * environment, passed to encryptField, and written. The script prints only
 * lengths and a masked tail so an operator can confirm WHICH credential landed
 * without the value appearing on a screen, in a scrollback, or in a transcript.
 *
 * USAGE (from the repo root, values supplied by the caller's environment):
 *
 *   OASIS_MAIL_FROM=you@oasisai.work \
 *   OASIS_MAIL_APP_PASSWORD='xxxx xxxx xxxx xxxx' \
 *   OASIS_TENANT_ID=<uuid> \
 *   node --import tsx scripts/provision-oasis-mailbox.mjs
 *
 *   Add --verify to send a real test email to the from_address itself and
 *   confirm the mailbox actually authenticates before any rep depends on it.
 */

import process from "node:process";

const FROM = (process.env.OASIS_MAIL_FROM || "").trim();
// Google shows an app password as four spaced groups. Strip ALL whitespace, not
// just the ends: a spaced 19-character paste authenticates on IMAP in some
// clients and returns 535 on SMTP, so the channel looks half-alive and the
// failure reads as a wrong password when it is really a formatting one.
const APP_PASSWORD = (process.env.OASIS_MAIL_APP_PASSWORD || "").replace(/\s+/g, "");
const TENANT_ID = (process.env.OASIS_TENANT_ID || "").trim();
const VERIFY = process.argv.includes("--verify");

function die(msg) {
  console.error(`[provision-oasis-mailbox] ${msg}`);
  process.exit(1);
}

if (!FROM || !FROM.includes("@")) die("OASIS_MAIL_FROM missing or not an email address");
if (!APP_PASSWORD) die("OASIS_MAIL_APP_PASSWORD missing");
if (!TENANT_ID) die("OASIS_TENANT_ID missing");
if (!process.env.BRAVO_FIELD_ENCRYPTION_KEY) {
  die(
    "BRAVO_FIELD_ENCRYPTION_KEY missing. Credentials are encrypted at rest with " +
      "it, and a row written without it cannot be read back by the app.",
  );
}
// A Gmail app password is 16 characters once spaces are stripped. This is a
// WARNING rather than a hard stop: Workspace has issued other lengths, and
// refusing a valid credential is worse than flagging an odd one.
if (APP_PASSWORD.length !== 16) {
  console.warn(
    `[provision-oasis-mailbox] note: app password is ${APP_PASSWORD.length} chars, ` +
      "expected 16 for a Gmail app password. Continuing.",
  );
}

const { setTenantIntegrationValue } = await import("../lib/tenant-integration-store.ts");
const { OASIS_MAIL_SERVICE } = await import("../lib/integrations/oasis-shared-gmail-send.ts");

const masked = `${"*".repeat(Math.max(0, APP_PASSWORD.length - 4))}${APP_PASSWORD.slice(-4)}`;
console.log(`[provision-oasis-mailbox] tenant   ${TENANT_ID}`);
console.log(`[provision-oasis-mailbox] service  ${OASIS_MAIL_SERVICE}`);
console.log(`[provision-oasis-mailbox] from     ${FROM}`);
console.log(`[provision-oasis-mailbox] password ${masked} (${APP_PASSWORD.length} chars)`);

// CHECK THE WRITE. setTenantIntegrationValue returns { ok: false } for
// encryption and database failures rather than throwing, so an unchecked loop
// prints "wrote app_password" and exits 0 having stored nothing — and --verify
// would then PASS, because it authenticates with the environment values rather
// than the row. A green run over an empty tenant record is the worst outcome
// this script could produce.
for (const [field_key, value] of [
  ["from_address", FROM],
  ["app_password", APP_PASSWORD],
]) {
  const result = await setTenantIntegrationValue({
    tenantId: TENANT_ID,
    service: OASIS_MAIL_SERVICE,
    fieldKey: field_key,
    value,
  });
  if (!result?.ok) {
    die(
      `failed to store ${field_key}: ${result?.error || "unknown error"}. ` +
        "Nothing usable was written; fix the cause and re-run.",
    );
  }
  console.log(`[provision-oasis-mailbox] wrote ${field_key}`);
}

if (!VERIFY) {
  console.log(
    "\n[provision-oasis-mailbox] stored. Re-run with --verify to prove the mailbox " +
      "actually authenticates before a rep depends on it.",
  );
  process.exit(0);
}

// PROVE IT AUTHENTICATES. A stored credential is not a working one, and the
// first person to find out otherwise should not be a rep on a live call. Sends
// to the from_address itself, so the test cannot reach a prospect.
console.log("\n[provision-oasis-mailbox] verifying by sending to the mailbox itself...");
const nodemailer = await import("nodemailer");
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: { user: FROM, pass: APP_PASSWORD },
});
try {
  const info = await transporter.sendMail({
    from: FROM,
    to: FROM,
    subject: "OASIS shared mailbox: connection test",
    text:
      "This is an automated test from provision-oasis-mailbox.\n\n" +
      "If you can read this, rep emails will send from this mailbox and each rep " +
      "will be CC'd on their own.\n",
  });
  console.log(`[provision-oasis-mailbox] VERIFIED. message id ${info.messageId}`);
  console.log("[provision-oasis-mailbox] check this mailbox's inbox for the test message.");
} catch (e) {
  const first = e instanceof Error ? e.message.split("\n")[0] : String(e);
  console.error(`[provision-oasis-mailbox] VERIFY FAILED: ${first}`);
  console.error(
    "  535 means Gmail rejected the credential: the app password is wrong, or it " +
      "belongs to a different account than OASIS_MAIL_FROM.\n" +
      "  The rows are stored either way; fix the value and re-run to overwrite them.",
  );
  process.exit(2);
}
