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
import {
  fromAddress as configuredFromAddress,
  fromDisplayName,
} from "@/lib/email/sending-identity";
import { getBrand, resolveBrandKey, type BrandKey } from "@/lib/email/brands";

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
 * 2-step /inbox/chat path.
 *
 * The ACCOUNT comes from the identity, not from here. It used to be hardcoded to
 * "texttorrent" with the note that act-as only works on the main SID — true of
 * the accounts that existed then, and false since 2026-08-14, when the Legacy
 * parent arrived carrying its own "AI Follow-Up" sub-account. A sub-account
 * email only authenticates against the parent that owns it, so the pair travels
 * together: send Legacy's act-as against the SunBiz SID and TT returns 401.
 * Absent means "texttorrent", so every pre-existing caller is unchanged.
 */
export async function sendDripSms(
  tenantId: string,
  toPhone: string,
  body: string,
  identity: DripSmsIdentity,
): Promise<DripSmsResult> {
  try {
    const creds = await getTextTorrentCredentials(tenantId, {
      service: identity.service || "texttorrent",
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
  opts?: { html?: string; listUnsubscribe?: string; brand?: BrandKey },
): Promise<DripEmailResult> {
  const brand = resolveBrandKey(opts?.brand);
  const result = await sendGmail({
    tenantId,
    to: toEmail,
    subject,
    body,
    html: opts?.html,
    listUnsubscribe: opts?.listUnsubscribe,
    // The brand picks the credential, so the visible sender and the DKIM
    // signature agree. Absent = SunBiz = today's behaviour.
    brand,
    // Drip-only display name. DRIP_FROM_NAME still wins when set (it exists so a
    // rebrand could move drips without dragging lender mail along); otherwise the
    // brand supplies its own name, and SunBiz's resolves to the shared default.
    fromName: fromDisplayName() ?? (brand === "sunbiz" ? undefined : getBrand(brand).displayName),
  });
  if (!result.ok) return { ok: false, error: result.error };
  // Report the From header the message was ACTUALLY sent with. The executor
  // persists this as from_identity, so re-deriving it here would audit a
  // DRIP_FROM_NAME-rebranded send under the shared default and record an
  // identity the recipient never saw (Codex review P2).
  //
  // The fallbacks exist only for the impossible case of a send that succeeded
  // without reporting its own From, and prefer the configured identity over a
  // literal so they do not keep saying SunBiz after the cutover either.
  let fromAddress = result.from_identity;
  if (!fromAddress) {
    fromAddress = configuredFromAddress(brand);
    try {
      fromAddress = await getSubmissionsFrom(tenantId, brand);
    } catch {
      /* best-effort label only — the send already succeeded */
    }
  }
  return { ok: true, messageId: result.rfc822_message_id, fromAddress };
}
