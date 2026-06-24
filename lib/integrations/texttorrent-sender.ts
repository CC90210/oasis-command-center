/**
 * lib/integrations/texttorrent-sender.ts — resolve the per-send TextTorrent
 * sender number (sender_id) for one outbound SMS. Server-only.
 *
 * Per-agent SMS (2026-06-24): SunBiz reps (Matt/owner, Jordan, Alex) share ONE
 * TextTorrent API key (tenant-level) but each texts from their OWN number. This
 * is the TextTorrent analogue of Kixie's per-rep `kixie_from_number` over the
 * tenant "Default Business Number" — see resolveKixieAgentEmail in
 * lib/cloud-tool-runner.ts and the inline Kixie ladder in
 * app/api/conversations/reply/route.ts.
 *
 * Resolution ladder:
 *   1. the user's own `texttorrent_from_number` (user_integration_credentials)
 *   2. the tenant "Default Business Number" (texttorrent.from_number) — the
 *      owner number used for automated (Helios) sends + as the fallback
 *   3. undefined → the TextTorrent account default applies server-side
 *
 * Pass `userId` for a human-in-the-loop send (lead/application drawer, inbox
 * reply, chat tool): the rep texts from THEIR number when set. Omit `userId`
 * (headless / automated) to use the tenant default (owner) number.
 *
 * Attribution is NOT decided here — each call site already stamps the correct
 * lead_interactions.agent_source + actor_user_id (manual → the human rep;
 * automated daemon sends → "helios"), which activity-feed.ts resolveAgent()
 * maps to the actor shown on the Settings → Activity page.
 */

import "server-only";

import { getUserIntegrationValue } from "@/lib/user-integration-store";
import { getTenantIntegrationBundle } from "@/lib/tenant-integration-store";
import {
  TEXTTORRENT_FROM_NUMBER_FIELD,
  pickTextTorrentSenderId,
} from "@/lib/integrations/texttorrent-sender-core";

// Re-export the pure helpers so existing server-side import sites
// (the personal route, etc.) can keep importing from this module.
export { TEXTTORRENT_FROM_NUMBER_FIELD, pickTextTorrentSenderId };

export async function resolveTextTorrentSenderId(args: {
  tenantId: string;
  /** The acting user's auth id — present for any human-in-the-loop send. */
  userId?: string | null;
}): Promise<string | undefined> {
  const { tenantId, userId } = args;

  // 1. The rep's own number (only looked up for human-in-the-loop sends).
  let userNumber: string | null = null;
  if (userId) {
    try {
      userNumber = await getUserIntegrationValue(
        tenantId,
        userId,
        "texttorrent",
        TEXTTORRENT_FROM_NUMBER_FIELD,
      );
    } catch {
      // soft-fail → tenant default
    }
  }

  // 2. Tenant "Default Business Number" — owner number for automated sends and
  //    the fallback when a rep hasn't set their own.
  let tenantDefault: string | undefined;
  try {
    const bundle = await getTenantIntegrationBundle(tenantId, "texttorrent");
    tenantDefault = bundle.from_number;
  } catch {
    // soft-fail → TT account default
  }

  return pickTextTorrentSenderId(userNumber, tenantDefault);
}
