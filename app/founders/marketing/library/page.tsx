/**
 * /founders/marketing/library — every artifact OASIS has produced, watchable in place.
 *
 * Adon: "Whenever you update or generate a new type of video, I'm able to watch
 * it seamlessly on there, whether that's an ad, whether that's HTML, whether
 * that's a video, short term, long form."
 *
 * FOUNDERS ONLY, same gate as /founders/marketing.
 *
 * Bytes live in Supabase Storage, not Postgres, so a 400 MB long-form video
 * never touches the database. Playback URLs are signed server-side per object
 * and expire in an hour; the browser never holds a service key.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { Card, PageHeader } from "@/components/Card";
import { safe } from "@/lib/api-helpers";
import { resolveFounder } from "@/lib/founders/gate";
import {
  getMarketingAssets,
  getMarketingBrands,
  mediaKey,
  signMediaUrls,
  type MarketingAssetRow,
} from "@/lib/founders/marketing-queries";
import {
  TRACKS,
  channelLabel,
  channelsForTrack,
  isAssetStatus,
  isChannel,
  trackForChannel,
  trackLabel,
  type AssetStatus,
  type Channel,
  type Track,
} from "@/lib/founders-marketing-core";
import { AssetTile, MarketingEmpty } from "@/components/founders/marketing-shared";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Library · Marketing · OASIS",
};

function isTrack(v: string | undefined): v is Track {
  return !!v && (TRACKS as readonly string[]).includes(v);
}

export default async function MarketingLibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ track?: string; channel?: string; brand?: string; status?: string }>;
}) {
  const founder = await resolveFounder();
  if (!founder) notFound();

  const sp = await searchParams;
  const track = isTrack(sp.track) ? sp.track : undefined;
  const channel = isChannel(sp.channel) ? (sp.channel as Channel) : undefined;
  const brand = typeof sp.brand === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sp.brand)
    ? sp.brand
    : undefined;
  // Studio's pipeline tiles link here with ?status=; validated against the
  // canonical list so an arbitrary string never reaches the query.
  const status = isAssetStatus(sp.status) ? sp.status : undefined;

  // `null` rather than `[]` as the fallback: an empty array cannot say whether
  // the library is empty or the query failed, and the page renders very
  // different copy for those two. getMarketingAssets throws on a broken read and
  // returns [] only when the table genuinely is not there yet.
  const [assetsOrNull, brands] = await Promise.all([
    safe<MarketingAssetRow[] | null>(
      "marketing.library",
      getMarketingAssets(founder.tenantId, { track, channel, brand, status }),
      null,
    ),
    safe("marketing.library.brands", getMarketingBrands(founder.tenantId), []),
  ]);
  const libraryDegraded = assetsOrNull === null;
  const assets = assetsOrNull ?? [];

  // Pick the objects each tile needs, then sign them ALL in one batched call per
  // bucket. Signing per object was one Storage round-trip each — 400 sequential
  // requests on a full 200-asset library, which is the entire render time.
  const pick = (a: (typeof assets)[number]) => {
    const media = a.media || [];
    return {
      video: media.find((m) => m.kind === "video"),
      poster:
        media.find((m) => m.kind === "poster") ||
        media.find((m) => m.kind === "thumb") ||
        media.find((m) => m.kind === "preview") ||
        media.find((m) => m.kind === "image"),
    };
  };

  const refs = assets.flatMap((a) => {
    const { video, poster } = pick(a);
    return [video, poster]
      .filter((m): m is NonNullable<typeof m> => !!m)
      .map((m) => ({ bucket: m.storage_bucket, path: m.storage_path }));
  });
  const urls = await safe("marketing.library.sign", signMediaUrls(refs), new Map<string, string>());

  const signed = assets.map((a) => {
    const { video, poster } = pick(a);
    const shape = video ?? poster;
    return {
      asset: a,
      playbackUrl: video ? (urls.get(mediaKey(video.storage_bucket, video.storage_path)) ?? null) : null,
      posterUrl: poster ? (urls.get(mediaKey(poster.storage_bucket, poster.storage_path)) ?? null) : null,
      mediaW: shape?.width ?? null,
      mediaH: shape?.height ?? null,
    };
  });

  // Derive ONE supported-channel list and use it for row visibility, pill
  // rendering and active state. The earlier version made `activeChannels` a
  // length-1 array as soon as a channel was picked, so the channel row unmounted
  // and there was no way to switch or clear the filter — a dead end. It also
  // matched channels with startsWith(track), which happens to work only because
  // every channel name is currently prefixed by its track; channelsForTrack()
  // uses the real mapping and cannot drift.
  const activeTrack: Track | undefined = track ?? (channel ? trackForChannel(channel) : undefined);
  const channelOptions: Channel[] = activeTrack ? channelsForTrack(activeTrack) : [];
  // `status` is preserved like every other dimension. It was omitted here while
  // Studio's pipeline tiles link in WITH it, so arriving on "In review" and then
  // touching any pill — including "All" — silently widened the view to every
  // status while the page gave no sign it had. You were reviewing, then you were
  // not, and nothing said so.
  const filterHref = (next: {
    track?: Track | null;
    channel?: Channel | null;
    brand?: string | null;
    status?: AssetStatus | null;
  }) => {
    const params = new URLSearchParams();
    const nextTrack = next.track === undefined ? track : next.track || undefined;
    const nextChannel = next.channel === undefined ? channel : next.channel || undefined;
    const nextBrand = next.brand === undefined ? brand : next.brand || undefined;
    const nextStatus = next.status === undefined ? status : next.status || undefined;
    if (nextTrack) params.set("track", nextTrack);
    if (nextChannel) params.set("channel", nextChannel);
    if (nextBrand) params.set("brand", nextBrand);
    if (nextStatus) params.set("status", nextStatus);
    const query = params.toString();
    return `/founders/marketing/library${query ? `?${query}` : ""}`;
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Library"
        subtitle={
          assets.length === 0
            ? "Everything produced lands here"
            : `${assets.length} ${assets.length === 1 ? "asset" : "assets"}${
                channel ? ` · ${channelLabel(channel)}` : track ? ` · ${trackLabel(track)}` : ""
              }`
        }
        action={
          <Link href="/founders/marketing" className="text-xs font-semibold text-accent hover:underline">
            Back to Studio
          </Link>
        }
      />

      {/* Filters. Plain links so the page stays a server component and every
          view is a shareable URL. */}
      {/* A status filter arrives from Studio's pipeline tiles, never from a pill
          here, so without this row the page silently showed a subset with no
          indication of why — and no way back. */}
      {status && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-dim">Stage</span>
          <FilterPill href={filterHref({})} label={status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())} active />
          <Link
            href={filterHref({ status: null })}
            className="text-[11px] font-semibold text-fg-dim transition-colors hover:text-fg"
          >
            Clear stage
          </Link>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <FilterPill href={filterHref({ track: null, channel: null })} label="All" active={!track && !channel} />
        {TRACKS.map((t) => (
          <FilterPill
            key={t}
            href={filterHref({ track: t, channel: null })}
            label={trackLabel(t)}
            // Stays lit while drilled into one of its channels, so the view
            // always shows where you are.
            active={activeTrack === t}
          />
        ))}
      </div>

      {brands.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-dim">Brand</span>
          <FilterPill href={filterHref({ brand: null })} label="All brands" active={!brand} subtle />
          {brands.map((item) => (
            <FilterPill
              key={item.slug}
              href={filterHref({ brand: item.slug })}
              label={item.name}
              active={brand === item.slug}
              subtle
            />
          ))}
        </div>
      )}

      {channelOptions.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          {/* "All <track>" clears the channel filter without losing the track. */}
          <FilterPill
            href={filterHref({ track: activeTrack as Track, channel: null })}
            label={`All ${trackLabel(activeTrack as Track)}`}
            active={!channel}
            subtle
          />
          {channelOptions.map((c) => (
            <FilterPill
              key={c}
              href={filterHref({ track: null, channel: c })}
              label={channelLabel(c)}
              active={channel === c}
              subtle
            />
          ))}
        </div>
      )}

      {assets.length === 0 ? (
        <Card>
          <MarketingEmpty
            // `status` counts as a filter. Arriving from a Studio pipeline tile
            // with zero matches used to say "The library is empty" — flatly false
            // when the library is full and only that stage is empty, and it made
            // the stage row above look broken. `libraryDegraded` outranks both:
            // when the read FAILED we know nothing about what is in here.
            headline={
              libraryDegraded
                ? "Couldn't load the library"
                : status
                ? "Nothing at this stage"
                : track || channel
                  ? "Nothing in this channel yet"
                  : "The library is empty"
            }
            detail={
              libraryDegraded
                ? "The query failed, so this is not a statement about what the library holds. Nothing has been lost — refresh, and if it persists the server log carries the reason under [marketing:assets]."
                : status
                ? "No assets are sitting at this stage right now. Clear the stage to see the rest of the library."
                : track || channel
                  ? "No assets are registered for this channel. Produce something, or clear the filter to see everything."
                  : "Assets appear here as Maven produces them. Nothing is registered yet, and nothing is being invented to fill the space."
            }
            hint="Migration 133 creates the tables. Ingestion lands in Phase 2."
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {/* items-start: tiles now differ in height because each takes its asset's own
              shape. Without it the grid stretches every tile to the tallest in its row,
              leaving a 9:16 tile's worth of empty panel beside every 16:9 one — dead
              space created BY the fix. */}
          {signed.map(({ asset, playbackUrl, posterUrl, mediaW, mediaH }) => (
            <AssetTile
              key={asset.id}
              id={asset.id}
              title={asset.title}
              brandName={asset.brand_name}
              channel={asset.channel}
              status={asset.status}
              hook={asset.hook}
              aspect={asset.aspect}
              durationS={asset.duration_s}
              format={asset.format}
              playbackUrl={playbackUrl}
              posterUrl={posterUrl}
              mediaW={mediaW}
              mediaH={mediaH}
              openReviews={asset.open_reviews}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterPill({
  href,
  label,
  active,
  subtle = false,
}: {
  href: string;
  label: string;
  active: boolean;
  subtle?: boolean;
}) {
  const base = "px-3 py-1.5 rounded-full text-xs border transition-all";
  const cls = active
    ? "bg-accent-soft text-accent border-accent/30 font-semibold"
    : subtle
      ? "bg-bg-deep/40 text-fg-dim border-bg-border hover:bg-bg-hover font-medium"
      : "bg-bg-elev text-fg-muted border-bg-border hover:bg-bg-hover font-medium";
  return (
    <Link href={href} className={`${base} ${cls}`}>
      {label}
    </Link>
  );
}
