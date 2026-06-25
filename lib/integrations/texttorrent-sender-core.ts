/**
 * lib/integrations/texttorrent-sender-core.ts — pure (no IO, no server-only)
 * helpers for resolving a TextTorrent per-send sender number. Split from
 * texttorrent-sender.ts (which imports the encrypted credential stores and is
 * server-only) so the precedence ladder is unit-testable without a DB. See
 * tests/user-credential-resolver.test.ts.
 */

/** Per-user credential field holding a rep's own TextTorrent sending DID. */
export const TEXTTORRENT_FROM_NUMBER_FIELD = "texttorrent_from_number";

/**
 * Per-user credential field holding a rep's own TextTorrent sub-account email —
 * sent as the X-ACT-AS-USER header so the rep's sends go out UNDER THEIR OWN
 * TextTorrent account (their daily limit, their inbox), not the tenant owner's.
 * The analogue of Kixie's kixie_agent_email. When unset, sends use the master
 * key with no act-as (tenant-owner identity).
 */
export const TEXTTORRENT_ACT_AS_EMAIL_FIELD = "texttorrent_act_as_email";

/**
 * Per-send sender precedence: the rep's own number wins, then the tenant
 * "Default Business Number", then undefined (let the TextTorrent account
 * default apply). Whitespace-only values are treated as unset.
 */
export function pickTextTorrentSenderId(
  userNumber: string | null | undefined,
  tenantDefault: string | null | undefined,
): string | undefined {
  const own = (userNumber || "").trim();
  if (own) return own;
  const def = (tenantDefault || "").trim();
  if (def) return def;
  return undefined;
}
