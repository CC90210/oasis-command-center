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
    return readMailboxImap(tenantId, userId, mailbox, opts);
  }
  return readOAuth(tenantId, userId, mailbox, opts);
}
