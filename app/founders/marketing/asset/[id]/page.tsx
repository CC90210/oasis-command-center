/**
 * /founders/marketing/asset/[id] — one asset, and everything you can do to it.
 *
 * CC, 2026-08-14: *"when I click on one of these videos, it takes me to a page
 * that says 'Not Found: This route does not exist in the agent command centre.'
 * All I did was click on one of the videos inside the library, and that's true
 * for every single one of them."*
 *
 * He was right and it was literal. components/founders/marketing-shared.tsx has
 * linked every tile to `/founders/marketing/asset/${id}` since the Library
 * shipped, and this route never existed — so the entire library was a wall of
 * dead links. This is the page.
 *
 * It is also where posting belongs. Until now the only way to put a finished
 * asset on a channel was to ask an agent to run a script, which is the opposite
 * of a command centre. The Post panel calls
 * POST /api/founders/marketing/assets/[id]/publish, which runs Maven's
 * send_gateway (killswitch, daily caps, audit trail) before anything leaves the
 * building. No second publishing path — see that route's own note.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Card, PageHeader } from "@/components/Card";
import { resolveFounder } from "@/lib/founders/gate";
import {
  getLatestPublishIntent,
  getMarketingAsset,
  mediaKey,
  signMediaUrls,
} from "@/lib/founders/marketing-queries";
import {
  channelLabel,
  isRenderableCarousel,
  parsePlatforms,
  parseSlideUrls,
  platformLabel,
  trackLabel,
  type Channel,
  type Track,
} from "@/lib/founders-marketing-core";
import { StatusTag, isPortrait, mediaFrame } from "@/components/founders/marketing-shared";
import { CarouselFrame } from "@/components/founders/CarouselFrame";
import { AssetActions } from "@/components/founders/AssetActions";
import { AssetPublishPanel } from "@/components/founders/AssetPublishPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Asset · OASIS" };

function fmtBytes(n?: number | null) {
  if (!n) return null;
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

function fmtDuration(s?: number | null) {
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n >= 60 ? `${Math.floor(n / 60)}m ${Math.round(n % 60)}s` : `${n.toFixed(1)}s`;
}

export default async function AssetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const founder = await resolveFounder();
  if (!founder) notFound();
  const { id } = await params;

  // Null covers both "no such asset" and "not yours" — the caller cannot tell
  // them apart, which is the point. 404, never 403.
  const asset = await getMarketingAsset(founder.tenantId, id);
  if (!asset) notFound();

  const media = asset.media || [];
  const video = media.find((m) => m.kind === "video");
  const poster =
    media.find((m) => m.kind === "poster") ||
    media.find((m) => m.kind === "thumb") ||
    media.find((m) => m.kind === "preview");
  const image = media.find((m) => m.kind === "image");

  // Slides in the order `media_urls` recorded at migration time — never
  // re-derived from the media rows, whose row order means nothing. A carousel
  // read out of order is a different post.
  const slidePaths = parseSlideUrls(asset.media_urls);

  const signed = await signMediaUrls([
    ...[video, poster, image]
      .filter(Boolean)
      .map((m) => ({ bucket: m!.storage_bucket, path: m!.storage_path })),
    ...slidePaths.map((path) => ({ bucket: "marketing-media", path })),
  ]);
  const slideUrls = slidePaths
    .map((path) => signed.get(mediaKey("marketing-media", path)))
    .filter((u): u is string => Boolean(u));
  const url = (m?: typeof video) =>
    m ? signed.get(mediaKey(m.storage_bucket, m.storage_path)) || null : null;

  const videoUrl = url(video);
  const posterUrl = url(poster);
  const imageUrl = url(image);

  // Frame from the asset's OWN pixels, via the SAME helper the tile uses. I had
  // restated the rule here; Maven's note on the tile is right that a second copy
  // means the crop comes back on one page only.
  const w = video?.width || image?.width || poster?.width || null;
  const h = video?.height || image?.height || poster?.height || null;
  const frame = mediaFrame(w, h, asset.aspect);
  const vertical = isPortrait(w, h);

  // Most recent publish request, so the panel can say what already happened
  // rather than inviting the operator to fire a second one blind.
  const lastIntent = await getLatestPublishIntent(founder.tenantId, asset.id);

  const facts: Array<[string, string | null]> = [
    ["Brand", asset.brand_name || asset.brand_slug],
    ["Track", trackLabel(asset.track as Track)],
    ["Channel", channelLabel(asset.channel as Channel)],
    // Where it actually went, when we know. `channel` is one value; an asset
    // goes to as many as six places.
    ["Posted to", parsePlatforms(asset.platforms).map(platformLabel).join(" · ") || null],
    ["Slides", asset.asset_type === "carousel" ? `${slideUrls.length} of ${asset.slide_count}` : null],
    ["Added by", asset.author_email],
    ["Format", asset.format],
    ["Aspect", asset.aspect],
    ["Duration", fmtDuration(asset.duration_s as unknown as number)],
    ["Size", fmtBytes(video?.bytes ?? image?.bytes)],
    ["Campaign", asset.campaign],
    ["Made by", asset.author_agent],
    ["Published", asset.published_at ? new Date(asset.published_at).toLocaleString() : null],
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title={asset.title}
        subtitle={asset.hook || "No hook recorded"}
        action={
          <Link
            href="/founders/marketing/library"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Library
          </Link>
        }
      />

      <div className={`grid gap-6 ${vertical ? "lg:grid-cols-[minmax(0,380px)_1fr]" : "lg:grid-cols-2"}`}>
        <Card noPadding>
          <div
            className={`relative flex items-center justify-center overflow-hidden rounded-xl bg-bg-deep ${frame.className}`}
            style={frame.style}
          >
            {isRenderableCarousel(asset.asset_type, slideUrls) ? (
              <CarouselFrame slides={slideUrls} title={asset.title} className="h-full w-full" />
            ) : videoUrl ? (
              <video
                src={videoUrl}
                poster={posterUrl || undefined}
                controls
                playsInline
                preload="metadata"
                className="h-full w-full object-contain"
              />
            ) : imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- signed R2 URL, not a static asset
              <img src={imageUrl} alt={asset.title} className="h-full w-full object-contain" />
            ) : (
              <div className="p-8 text-center text-sm text-fg-dim">
                No playable media is attached to this asset.
              </div>
            )}
          </div>
        </Card>

        <div className="space-y-6">
          <Card title="Status" subtitle="Where this sits, and what you can do about it">
            <div className="mb-4 flex items-center gap-3">
              <StatusTag status={asset.status} />
              {asset.open_reviews ? (
                <span className="text-xs text-fg-dim">
                  {asset.open_reviews} open review{asset.open_reviews === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
            {/* The SAME verdict controls as the library tile, deliberately —
                one component, one behaviour. A second implementation here would
                drift and the two surfaces would start disagreeing about what
                "approve" does. */}
            <AssetActions id={asset.id} status={asset.status} title={asset.title} />
          </Card>

          <Card title="Post to channels" subtitle="Goes out through the send gateway">
            <AssetPublishPanel
              assetId={asset.id}
              hasVideo={Boolean(videoUrl)}
              lastIntent={lastIntent}
            />
          </Card>

          <Card title="Copy" subtitle="What Maven wrote for this">
            <dl className="space-y-3 text-sm">
              {[
                ["Hook", asset.hook],
                ["Body", asset.body],
                ["CTA", asset.cta],
                ["Landing", asset.landing_url],
              ].map(([k, v]) =>
                v ? (
                  <div key={k as string}>
                    <dt className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-dim">
                      {k}
                    </dt>
                    <dd className="mt-0.5 whitespace-pre-wrap leading-6 text-fg-muted">
                      {String(v)}
                    </dd>
                  </div>
                ) : null,
              )}
            </dl>
          </Card>

          <Card title="Details">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              {facts.map(([k, v]) =>
                v ? (
                  <div key={k}>
                    <dt className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-dim">
                      {k}
                    </dt>
                    <dd className="mt-0.5 text-fg-muted">{v}</dd>
                  </div>
                ) : null,
              )}
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}
