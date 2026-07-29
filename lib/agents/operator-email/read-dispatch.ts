/**
 * lib/agents/operator-email/read-dispatch.ts — picks the read mechanism per
 * mailbox. If the operator connected the box by Gmail App Password we monitor it
 * over IMAP (imap-read); otherwise we fall back to the OAuth Gmail API reader
 * (gmail-read). Same signature + return shape as gmail-read.readMailbox, so the
 * cron and ingest are agnostic to which transport ran.
 */

import "server-only";
import { readMailbox as readOAuth, type MonitoredMessage } from "./gmail-read";
import { readMailboxImap, hasImapMailbox } from "./imap-read";

export type { MonitoredMessage };

export async function readMailbox(
  tenantId: string,
  userId: string,
  mailbox: "work" | "personal",
  opts: { query?: string; max?: number } = {},
): Promise<{ messages: MonitoredMessage[]; diag: string }> {
  if (await hasImapMailbox(tenantId, userId, mailbox)) {
    const imap = await readMailboxImap(tenantId, userId, mailbox, opts);
    if (!imap.diag.startsWith("imap_")) return imap;
    // A stale app password must not hide a valid Gmail OAuth connection.
    // OAuth remains read-only and returns its own diagnostic on failure.
    const oauth = await readOAuth(tenantId, userId, mailbox, opts);
    return oauth.messages.length > 0 || oauth.diag.startsWith("ok_")
      ? oauth
      : { messages: [], diag: `${imap.diag}; oauth=${oauth.diag}` };
  }
  return readOAuth(tenantId, userId, mailbox, opts);
}
