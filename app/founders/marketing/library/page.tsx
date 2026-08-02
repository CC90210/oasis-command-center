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
import { getMarketingAssets, signMediaUrl } from "@/lib/founders/marketing-queries";
import {
  CHANNELS,
  TRACKS,
  channelLabel,
  isChannel,
  trackLabel,
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
  searchParams: Promise<{ track?: string; channel?: string }>;
}) {
  const founder = await resolveFounder();
  if (!founder) notFound();

  const sp = await searchParams;
  const track = isTrack(sp.track) ? sp.track : undefined;
  const channel = isChannel(sp.channel) ? (sp.channel as Channel) : undefined;

  const assets = await safe(
    "marketing.library",
    getMarketingAssets(founder.tenantId, { track, channel }),
    [],
  );

  // Sign every playable object in one pass. Failures resolve to null so a single
  // missing object degrades one tile instead of blanking the grid.
  const signed = await Promise.all(
    assets.map(async (a) => {
      const media = a.media || [];
      const video = media.find((m) => m.kind === "video");
      const poster =
        media.find((m) => m.kind === "poster") ||
        media.find((m) => m.kind === "thumb") ||
        media.find((m) => m.kind === "preview");
      const [playbackUrl, posterUrl] = await Promise.all([
        video ? signMediaUrl(video.storage_bucket, video.storage_path) : Promise.resolve(null),
        poster ? signMediaUrl(poster.storage_bucket, poster.storage_path) : Promise.resolve(null),
      ]);
      return { asset: a, playbackUrl, posterUrl };
    }),
  );

  const activeChannels = channel ? [channel] : track ? CHANNELS.filter((c) => c) : [];

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
      <div className="flex flex-wrap items-center gap-2">
        <FilterPill href="/founders/marketing/library" label="All" active={!track && !channel} />
        {TRACKS.map((t) => (
          <FilterPill
            key={t}
            href={`/founders/marketing/library?track=${t}`}
            label={trackLabel(t)}
            active={track === t && !channel}
          />
        ))}
      </div>

      {activeChannels.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          {CHANNELS.filter((c) => !track || c.startsWith(track === "email" ? "email" : track)).map(
            (c) => (
              <FilterPill
                key={c}
                href={`/founders/marketing/library?channel=${c}`}
                label={channelLabel(c)}
                active={channel === c}
                subtle
              />
            ),
          )}
        </div>
      )}

      {assets.length === 0 ? (
        <Card>
          <MarketingEmpty
            headline={
              track || channel ? "Nothing in this channel yet" : "The library is empty"
            }
            detail={
              track || channel
                ? "No assets are registered for this channel. Produce something, or clear the filter to see everything."
                : "Assets appear here as Maven produces them. Nothing is registered yet, and nothing is being invented to fill the space."
            }
            hint="Migration 133 creates the tables. Ingestion lands in Phase 2."
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {signed.map(({ asset, playbackUrl, posterUrl }) => (
            <AssetTile
              key={asset.id}
              id={asset.id}
              title={asset.title}
              channel={asset.channel}
              status={asset.status}
              hook={asset.hook}
              aspect={asset.aspect}
              durationS={asset.duration_s}
              format={asset.format}
              playbackUrl={playbackUrl}
              posterUrl={posterUrl}
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
