/**
 * lib/drips/send.ts — thin, no-session adapters over the two proven Vercel
 * send paths (TextTorrent SMS + submissions@ SMTP email), built for the
 * drip dispatch cron (no cookies/session — always headless, unlike the
 * lead-drawer/Conversations send routes which resolve a per-rep identity from
 * the acting user).
 *
 * SMS: sends AS the LEAD REP'S TextTorrent sub-account (act-as) from that rep's
 * own number — the identity is resolved once per row by the executor via
 * lib/drips/rep-sms-identity.ts and passed in here. Sub-account act-as only
 * works on the MAIN "texttorrent" account (the parent SID that owns the
 * sub-accounts), so this always authenticates on the main account — NOT the
 * dedicated follow-up account (a different SID with no sub-accounts). Drip SMS
 * therefore shares the main account's 60/min budget with the live inbox line;
 * that's an accepted trade-off of Adon's per-rep-account requirement and is
 * held in check by the drip enroll ramp (DRIPS_ENROLL_LIMIT).
 *
 * Email: always submissions@sunbizfunding.com via the same App-Password SMTP
 * path lender shop-out uses live today (lib/integrations/
 * submissions-gmail-send.ts sendGmail / lib/integrations/submissions-gmail.ts).
 *
 * NEITHER function applies the DRIPS_LIVE / isDryRun gate — both always send
 * for real when called. That mirrors dispatch-scheduled-sends' processSms/
 * processEmail: the low-level sender is unconditional; the gate lives one
 * level up, in the executor, immediately before the call. Keeping the gate
 * out of this file means a unit test or a future caller can't accidentally
 * end up "double dry-run" (gate checked here AND there) or, worse, assume
 * this file is safe to call unconditionally when it isn't.
 */

import "server-only";
import {
  getTextTorrentCredentials,
  sendSms as ttSendSms,
  TextTorrentError,
} from "@/lib/integrations/texttorrent";
import type { DripSmsIdentity } from "@/lib/drips/rep-sms-identity";
import { sendGmail } from "@/lib/integrations/submissions-gmail-send";
import { getSubmissionsFrom } from "@/lib/integrations/submissions-gmail";
import { fromAddress as configuredFromAddress } from "@/lib/email/sending-identity";

export type DripSmsResult =
  | {
      ok: true;
      chatId: string;
      messageId?: string;
      fromNumber: string;
      actAsEmail: string | null;
      repKey: string;
    }
  /** `code` is the TextTorrentError code when the failure came from TT — the
   *  executor branches on "insufficient_credits" to halt the run instead of
   *  burning each lead's retry budget on an account-wide outage. */
  | { ok: false; error: string; code?: string };

export type DripEmailResult =
  | { ok: true; messageId: string; fromAddress: string }
  | { ok: false; error: string };

/**
 * Send one drip SMS AS the resolved rep identity. The act-as email routes the
 * chat into that rep's sub-account inbox (so replies thread to the right rep);
 * the sender number is that rep's own DID. `actAsEmail: null` means the parent/
 * admin account (Matt / owner / unattributed leads). Always on the LIVE-VERIFIED
 * 2-step /inbox/chat path, on the MAIN account (act-as requires it).
 */
export async function sendDripSms(
  tenantId: string,
  toPhone: string,
  body: string,
  identity: DripSmsIdentity,
): Promise<DripSmsResult> {
  try {
    const creds = await getTextTorrentCredentials(tenantId, {
      service: "texttorrent", // per-rep act-as only works on the parent/main account
      actAsEmail: identity.actAsEmail, // string = sub-account, null = parent/admin
    });
    const sent = await ttSendSms(creds, {
      number: toPhone,
      message: body,
      sender_id: identity.senderId,
    });
    return {
      ok: true,
      chatId: sent.data.chat_id,
      messageId: sent.data.message_id,
      fromNumber: identity.senderId,
      actAsEmail: identity.actAsEmail,
      repKey: identity.repKey,
    };
  } catch (err) {
    const reason =
      err instanceof TextTorrentError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : "send_failed";
    return {
      ok: false,
      error: reason,
      code: err instanceof TextTorrentError ? err.code : undefined,
    };
  }
}

/**
 * Send one drip email as submissions@sunbizfunding.com. Thin wrapper over
 * sendGmail — drips don't reply-chain the way lender shop-out threads do
 * (no In-Reply-To/References), so each step is a fresh Message-Id and no
 * threadId is passed.
 */
export async function sendDripEmail(
  tenantId: string,
  toEmail: string,
  subject: string,
  body: string,
  opts?: { html?: string; listUnsubscribe?: string },
): Promise<DripEmailResult> {
  const result = await sendGmail({
    tenantId,
    to: toEmail,
    subject,
    body,
    html: opts?.html,
    listUnsubscribe: opts?.listUnsubscribe,
  });
  if (!result.ok) return { ok: false, error: result.error };
  // Label only — the send already happened. Falls back to the configured sending
  // identity rather than a literal so it does not keep reporting SunBiz after the
  // Bluerise cutover; the per-tenant lookup below still wins when it resolves.
  let fromAddress = configuredFromAddress();
  try {
    fromAddress = await getSubmissionsFrom(tenantId);
  } catch {
    /* best-effort label only — the send already succeeded */
  }
  return { ok: true, messageId: result.rfc822_message_id, fromAddress };
}
