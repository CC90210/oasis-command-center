/**
 * lib/integrations/texttorrent-credits.ts — Text Torrent credit math.
 *
 * TT has no pre-send quote endpoint (createBulkCampaign only returns total_credit
 * once a blast COMMITS). So the pre-send "how many credits will this blast use?"
 * figure is computed locally from the owner-confirmed rule:
 *
 *   3 credits per recipient for a one-segment template.
 *   → estimate = recipients × 3 × segments
 *
 * Single tunable constant so the rate lives in exactly one place. Like
 * send-mode.ts this is intentionally NOT `import "server-only"` — the client
 * compose widget imports the constant + estimator for the live estimate.
 */

/** Owner-confirmed: a 1-segment template costs 3 credits per recipient. */
export const CREDITS_PER_SEGMENT_PER_RECIPIENT = 3;

/** Warn (amber) when the account balance drops below this many credits. */
export const LOW_BALANCE_THRESHOLD = 500;

/**
 * Pre-send credit estimate for a TT bulk blast.
 * @param recipients number of leads in the selected contact list
 * @param segments   SMS segments per message (from lib/sms-segments.countSegments)
 */
export function estimateCredits({
  recipients,
  segments,
}: {
  recipients: number;
  segments: number;
}): number {
  const r = Math.max(0, Math.floor(recipients || 0));
  const s = Math.max(1, Math.floor(segments || 1));
  return r * CREDITS_PER_SEGMENT_PER_RECIPIENT * s;
}
