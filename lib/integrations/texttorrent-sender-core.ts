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
