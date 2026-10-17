import { Tag } from "@/components/Card";

/**
 * The two stamps an offer page leaves on a Library cut, drawn as small
 * read-only badges: which offer page it is the video for (meta.offer_slug) and
 * whether its captions are burned into the picture (meta.burned_captions).
 * Nothing here changes either; the offer pages own them
 * (lib/offer-pages/store.ts, lib/offer-pages/confirm-list.ts).
 *
 * Renders nothing when neither is set, so a tile without them is unchanged.
 * No client hooks, so the Library tiles (server) and the hook comparison
 * (client) both use it.
 */
export function MetaBadges({
  offerSlug,
  burnedCaptions,
}: {
  offerSlug?: string | null;
  burnedCaptions?: boolean;
}) {
  if (!offerSlug && !burnedCaptions) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {offerSlug && <Tag tone="info">{`Offer: ${offerSlug}`}</Tag>}
      {burnedCaptions && <Tag tone="neutral">Captions in picture</Tag>}
    </div>
  );
}
