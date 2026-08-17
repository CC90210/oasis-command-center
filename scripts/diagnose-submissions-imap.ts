/**
 * Why is the submissions mailbox refusing IMAP?
 *
 * /api/cron/scan-lender-replies collapses every connect failure into
 * `imap_connect_<message>` and returns 502, and ImapFlow's message for a
 * rejected login is the unhelpfully generic "Command failed". The offers
 * scanner has been logging exactly that every 8 minutes since 2026-08-06,
 * which tells you it is broken and nothing about why.
 *
 * This reproduces the same connect through the same credential path and prints
 * the FULL error — authenticationFailed, responseText, response code — so the
 * answer is "the password is wrong" or "IMAP is disabled on the account" rather
 * than a guess between them.
 *
 * NEVER prints the password. Length and a whitespace flag only, which is enough
 * to catch the 2026-07-02 failure mode where Google's four spaced groups were
 * stored verbatim (19 chars for a 16-char secret).
 *
 *   node --conditions=react-server --import tsx scripts/diagnose-submissions-imap.ts
 */
import { ImapFlow } from "imapflow";
import { getSubmissionsCreds } from "@/lib/integrations/submissions-gmail";

const SUNBIZ_TENANT_ID = process.env.SUNBIZ_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

async function main() {
  let creds;
  try {
    creds = await getSubmissionsCreds(SUNBIZ_TENANT_ID);
  } catch (e) {
    console.error("CREDS LOOKUP FAILED:", e instanceof Error ? e.message : e);
    process.exit(2);
  }

  const raw = creds.appPassword;
  console.log("from_address :", creds.fromAddress);
  console.log("password len :", raw.length, raw.length === 16 ? "(expected 16)" : "(!! Google app passwords are 16 chars)");
  console.log("has spaces   :", /\s/.test(raw) ? "YES (should already be stripped)" : "no");

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: creds.fromAddress, pass: raw.replace(/\s+/g, "") },
    logger: false,
    greetingTimeout: 12_000,
    socketTimeout: 25_000,
  });

  try {
    await client.connect();
    console.log("\nCONNECT: OK");
    const lock = await client.getMailboxLock("INBOX");
    try {
      const status = await client.status("INBOX", { messages: true, unseen: true });
      console.log(`INBOX: ${status.messages} messages, ${status.unseen} unseen`);
    } finally {
      lock.release();
    }
    await client.logout();
    console.log("VERDICT: credentials work and IMAP is enabled.");
  } catch (e) {
    const err = e as Error & { authenticationFailed?: boolean; responseText?: string; response?: string; code?: string };
    console.error("\nCONNECT FAILED");
    console.error("  message            :", err.message);
    console.error("  authenticationFailed:", err.authenticationFailed);
    console.error("  responseText       :", err.responseText);
    console.error("  response           :", err.response);
    console.error("  code               :", err.code);
    console.error(
      "\nREADING IT: authenticationFailed true with a responseText mentioning " +
        "credentials = wrong/revoked app password, or the password belongs to a " +
        "different account than from_address. A responseText mentioning IMAP " +
        "being disabled = the password is fine and IMAP is off in Gmail settings.",
    );
    process.exit(1);
  }
}

main();
