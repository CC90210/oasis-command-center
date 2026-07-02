/**
 * lib/agents/operator-email/imap-read.ts — app-password IMAP reader for the
 * Operator Email Agent. The alternative to gmail-read.ts (OAuth): when an
 * operator connects a mailbox by Gmail App Password instead of OAuth, we
 * monitor it over IMAP (imap.gmail.com:993) — no Google Cloud project, no API
 * enablement, no test users, no verification. Read-only (ImapFlow fetches with
 * BODY.PEEK, never sets \Seen). NEVER throws — returns { messages: [], diag }
 * on any failure so a bad tick can't crash the cron.
 *
 * Emits the SAME MonitoredMessage shape as gmail-read.ts, so ingest.ts (privacy
 * gate + classify + lead-match) is unchanged. Creds live per-user in
 * user_integration_credentials (service gmail_imap / gmail_imap_personal):
 * { address, app_password }, encrypted with BRAVO_FIELD_ENCRYPTION_KEY.
 */

import "server-only";
import { getUserIntegrationBundle } from "@/lib/user-integration-store";
import type { MonitoredMessage } from "./gmail-read";

type Mailbox = "work" | "personal";
const serviceOf = (mailbox: Mailbox) => (mailbox === "personal" ? "gmail_imap_personal" : "gmail_imap");

/** True if this operator has an app-password mailbox configured for this box. */
export async function hasImapMailbox(tenantId: string, userId: string, mailbox: Mailbox): Promise<boolean> {
  try {
    const b = await getUserIntegrationBundle(tenantId, userId, serviceOf(mailbox));
    return !!(b.address && b.app_password);
  } catch {
    return false;
  }
}

/** Translate the cron's Gmail-style window ("after:<unix>" / "newer_than:Nd") into a Date. */
function sinceFromQuery(query?: string): Date {
  if (query) {
    const after = query.match(/after:(\d+)/);
    if (after) return new Date(parseInt(after[1], 10) * 1000);
    const newer = query.match(/newer_than:(\d+)d/);
    if (newer) return new Date(Date.now() - parseInt(newer[1], 10) * 24 * 3600 * 1000);
  }
  return new Date(Date.now() - 2 * 24 * 3600 * 1000);
}

/** "Name <addr>" when a display name exists, else the bare address — matches gmail-read's header form. */
function fmtAddr(a?: { name?: string; address?: string }): string {
  if (!a?.address) return "";
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

export async function readMailboxImap(
  tenantId: string,
  userId: string,
  mailbox: Mailbox,
  opts: { query?: string; max?: number } = {},
): Promise<{ messages: MonitoredMessage[]; diag: string }> {
  let bundle: Record<string, string>;
  try {
    bundle = await getUserIntegrationBundle(tenantId, userId, serviceOf(mailbox));
  } catch {
    return { messages: [], diag: "no_bundle" };
  }
  const address = (bundle.address || "").trim();
  const appPassword = (bundle.app_password || "").replace(/\s+/g, "");
  if (!address || !appPassword) return { messages: [], diag: "no_creds" };

  const { ImapFlow } = await import("imapflow");
  const { simpleParser } = await import("mailparser");
  const max = Math.min(opts.max || 40, 60);
  const since = sinceFromQuery(opts.query);

  const client = new ImapFlow({
    host: "imap.gmail.com", port: 993, secure: true,
    auth: { user: address, pass: appPassword },
    logger: false,
    // Bound the connection so a hung socket can't ride out the whole maxDuration.
    greetingTimeout: 12_000, socketTimeout: 25_000,
  });

  try {
    await client.connect();
  } catch (e) {
    return { messages: [], diag: "imap_connect_" + (e instanceof Error ? e.message.split("\n")[0].slice(0, 80) : "unknown") };
  }

  const out: MonitoredMessage[] = [];
  const lock = await client.getMailboxLock("INBOX");
  try {
    const found = (await client.search({ since }, { uid: true })) || [];
    const recent = (Array.isArray(found) ? found : []).slice(-max);
    if (recent.length) {
      for await (const msg of client.fetch(
        recent,
        { uid: true, envelope: true, source: true, threadId: true, emailId: true },
        { uid: true },
      )) {
        try {
          const env = msg.envelope;
          let body = "";
          try {
            const parsed = await simpleParser(msg.source as Buffer);
            body = (parsed.text || parsed.html || "").toString();
          } catch {
            body = "";
          }
          const id = msg.emailId || env?.messageId || String(msg.uid);
          out.push({
            id,
            threadId: msg.threadId || id,
            subject: env?.subject || "",
            from: fmtAddr(env?.from?.[0]),
            to: fmtAddr(env?.to?.[0]),
            date: env?.date instanceof Date ? env.date.toISOString() : "",
            body: body.slice(0, 8000),
            mailboxAddress: address,
          });
        } catch {
          // skip a single unreadable message; keep the tick alive
        }
      }
    }
  } catch {
    // search/fetch failure — return whatever we already collected
  } finally {
    lock.release();
    try { await client.logout(); } catch { /* ignore */ }
  }
  return { messages: out, diag: `ok_${out.length}` };
}
