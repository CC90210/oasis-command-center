/**
 * lib/drips/send.ts — thin, no-session adapters over the two proven Vercel
 * send paths (TextTorrent SMS + submissions@ SMTP email), built for the
 * drip dispatch cron (no cookies/session — always headless, unlike the
 * lead-drawer/Conversations send routes which resolve a per-rep identity).
 *
 * SMS: prefers the dedicated "texttorrent_followup" TextTorrent account
 * (its own SID/public key + its own 60/min rate budget — see
 * lib/tenant-integration-store.ts ENV_FALLBACKS.texttorrent_followup and
 * lib/integrations/send-mode.ts's LIVE_SEND_TEXTTORRENT_FOLLOWUP channel
 * key) so drip cadences never starve the live Jordan/Inbox line on the
 * shared main SID. Falls back to the main "texttorrent" account when the
 * follow-up account has no credentials on file yet (tenant hasn't wired it) —
 * this keeps drips working while the operator provisions the dedicated
 * account, at the cost of sharing the main account's rate budget until then.
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
import { resolveTextTorrentSenderId } from "@/lib/integrations/texttorrent-sender";
import { sendGmail } from "@/lib/integrations/submissions-gmail-send";
import { getSubmissionsFrom } from "@/lib/integrations/submissions-gmail";

export type DripTextTorrentService = "texttorrent_followup" | "texttorrent";

export type DripSmsResult =
  | {
      ok: true;
      chatId: string;
      messageId?: string;
      fromNumber: string;
      service: DripTextTorrentService;
    }
  | { ok: false; error: string };

export type DripEmailResult =
  | { ok: true; messageId: string; fromAddress: string }
  | { ok: false; error: string };

const FOLLOWUP_SERVICE: DripTextTorrentService = "texttorrent_followup";
const DEFAULT_SERVICE: DripTextTorrentService = "texttorrent";

/**
 * Resolve which TextTorrent account (service key) a drip SMS to this tenant
 * should go out on: the dedicated follow-up account if it has credentials on
 * file, else the shared main account. Exported so the executor can resolve
 * this ONCE per row and reuse it both for the isDryRun(channel) check and for
 * the actual send — resolving twice could theoretically observe a credential
 * change mid-row and gate on a different account than it sends from.
 */
export async function resolveDripTextTorrentService(
  tenantId: string,
): Promise<DripTextTorrentService> {
  try {
    await getTextTorrentCredentials(tenantId, { service: FOLLOWUP_SERVICE });
    return FOLLOWUP_SERVICE;
  } catch {
    return DEFAULT_SERVICE;
  }
}

/**
 * Send one drip SMS on the given (already-resolved) account. Resolves the
 * tenant's Default Business Number for that account — no userId, since a
 * drip is a headless/automated send, not a rep-attributed one (see the
 * resolution ladder documented in texttorrent-sender.ts: omitting userId
 * skips straight to the tenant default) — and fires via the LIVE-VERIFIED
 * 2-step /inbox/chat path.
 */
export async function sendDripSms(
  tenantId: string,
  toPhone: string,
  body: string,
  service: DripTextTorrentService,
): Promise<DripSmsResult> {
  try {
    const creds = await getTextTorrentCredentials(tenantId, { service });
    const senderId = await resolveTextTorrentSenderId({ tenantId, service });
    if (!senderId) {
      return { ok: false, error: "no_sender_number_resolved" };
    }
    const sent = await ttSendSms(creds, { number: toPhone, message: body, sender_id: senderId });
    return {
      ok: true,
      chatId: sent.data.chat_id,
      messageId: sent.data.message_id,
      fromNumber: senderId,
      service,
    };
  } catch (err) {
    const reason =
      err instanceof TextTorrentError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : "send_failed";
    return { ok: false, error: reason };
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
): Promise<DripEmailResult> {
  const result = await sendGmail({ tenantId, to: toEmail, subject, body });
  if (!result.ok) return { ok: false, error: result.error };
  let fromAddress = "submissions@sunbizfunding.com";
  try {
    fromAddress = await getSubmissionsFrom(tenantId);
  } catch {
    /* best-effort label only — the send already succeeded */
  }
  return { ok: true, messageId: result.rfc822_message_id, fromAddress };
}
