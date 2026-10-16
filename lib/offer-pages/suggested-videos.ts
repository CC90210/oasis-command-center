/**
 * lib/offer-pages/suggested-videos.ts - the top video Bravo proposes for each
 * of OASIS's offer pages, shown on Confirm & publish (/forms/publish) so the
 * owner watches it and accepts it with one tick.
 *
 * CC 2026-10-16: one screen, no manual video uploads. Six offer pages sat as
 * drafts and each one meant a builder visit, a Library search and an upload.
 * Here Bravo names the cut, and the owner's tick ("We own this video and may
 * use it here") attaches it through the builder's own draft save, which stamps
 * the rights confirmation with the saving owner and the time
 * (claims.ts stampConfirmations). Nothing here attaches anything by itself.
 *
 * WHAT A VALUE IS. A Library ASSET id (marketing_asset.id), never a media row
 * id: a page's LibraryVideoRef needs the asset's video file id (and its poster
 * and captions when it has them), and those are resolved on the server from
 * the asset, the way the builder's "Choose from Library" does
 * (app/api/forms/[id]/offer/library-videos). The aspect is the cut's shape.
 *
 * THE FALLBACK. A cut tagged for a page in the Library (meta.offer_slug, which
 * Maven's publish_to_library.py writes with --offer-slug) is proposed first,
 * with no entry here (confirm-list.ts taggedHeroVideo): that is how a NEW
 * offer gets its video. This map answers only for a page no tagged cut serves.
 *
 * WHO FILLS IT. Bravo, from the asset ids Maven hands over for each offer.
 * An asset still "in review" in the Library is offered with the tick "Approve
 * this video and confirm we own it": approving is the owner's call, made
 * through the Library's own route, never written here.
 *
 * SCOPE. OASIS's own workspace only (tenant slug oasis-ai-cc): a key is a form
 * slug in that workspace, and another workspace with a form of the same slug
 * is offered nothing. A slug with no entry ("vsl", the Start here router) shows
 * "No video proposed yet" and publishes without one.
 *
 * Pure and ASCII: the page, its loader and the tests read it.
 */
import type { Aspect } from "./types";

export type SuggestedVideo = { assetId: string; aspect: Aspect };

/** The only workspace these proposals belong to. */
export const SUGGESTED_VIDEOS_TENANT_SLUG = "oasis-ai-cc";

/**
 * Form slug -> the proposed top video (Maven's picks, 2026-10-16, all 9:16).
 * FLEET and PROTOCOL moved to Maven's newer motion cuts; FLEET's older pack
 * film (35f0bd3b) named the house agents and is no longer proposed.
 */
export const SUGGESTED_HERO_VIDEOS: Readonly<Record<string, SuggestedVideo>> = {
  "ai-audit": { assetId: "234693f1-d82a-4b72-a5a8-13c1c66dca32", aspect: "9:16" },
  protocol: { assetId: "d216493c-002b-4ce4-9a0e-846f5895e749", aspect: "9:16" },
  command: { assetId: "4afa20aa-9558-4803-8aa1-dcf63686a1ce", aspect: "9:16" },
  community: { assetId: "b99f760e-ddad-471c-b418-af70f1b10b43", aspect: "9:16" },
  fleet: { assetId: "20a179c9-b263-45c9-b2c3-e83656d09319", aspect: "9:16" },
};

/**
 * The proposal for one offer page, or null. Own keys only, as
 * offerShareablePath reads its map: a slug such as "constructor" must never
 * pick up an inherited Object member as its proposal.
 */
export function suggestedHeroVideo(
  tenantSlug: string | null,
  formSlug: string,
  map: Readonly<Record<string, SuggestedVideo>> = SUGGESTED_HERO_VIDEOS,
): SuggestedVideo | null {
  if (tenantSlug !== SUGGESTED_VIDEOS_TENANT_SLUG) return null;
  return Object.prototype.hasOwnProperty.call(map, formSlug) ? map[formSlug] : null;
}
