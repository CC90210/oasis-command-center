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
  isOwnBrand,
  isRenderableCarousel,
  libraryReturnPath,
  madeByLabel,
  parsePlatforms,
  parseSlideUrls,
  authorName,
  phoneChromeFor,
  platformLabel,
  stalePublishWarning,
  trackLabel,
  type Channel,
  type Track,
} from "@/lib/founders-marketing-core";
import { StatusTag, isPortrait, mediaFrame } from "@/components/founders/marketing-shared";
import { CarouselFrame } from "@/components/founders/CarouselFrame";
import { EnlargeButton, PhoneEnlarge } from "@/components/founders/PhoneEnlarge";
import { PhoneFrame, PhoneTextCard, type PhoneFrameShape } from "@/components/founders/PhoneFrame";
import { TileVideo } from "@/components/founders/TileVideo";
import { SlideReorder } from "@/components/founders/SlideReorder";
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

/** A preview toggle. A link, so the choice lives in the URL and survives a reload. */
function PreviewLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={
        "rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors " +
        (active
          ? "border-accent/30 bg-accent-soft text-accent"
          : "border-bg-border bg-bg-deep/40 text-fg-dim hover:bg-bg-hover hover:text-fg")
      }
    >
      {label}
    </Link>
  );
}

export default async function AssetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ frame?: string; chrome?: string; guides?: string; from?: string }>;
}) {
  const founder = await resolveFounder();
  if (!founder) notFound();
  const { id } = await params;
  const sp = await searchParams;
  const guides = sp.guides === "1";
  // The Library view this asset was opened from (tab, filters, view, page),
  // validated to the Library's own path; anything else is its front page.
  const libraryBack = libraryReturnPath(sp.from);

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

  // The phone preview is the default view of an asset; ?frame=original shows
  // the media alone at its own shape - except a video's.
  //
  // A VIDEO IS ALWAYS A PHONE. CC, 2026-10-01: "make all of these videos that
  // are currently displayed as rectangular shapes into iPhone shapes". The
  // Original view drew a video as a rectangle at the file's shape, with the
  // browser's player, whose full-screen button made it a big rectangle rather
  // than the big iPhone. So a video has no Original view: the pill is not
  // offered and ?frame=original shows the phone. Pictures, decks and text keep
  // it, as they keep the plain card in the Library's grid.
  const isVideo = asset.format === "video" || Boolean(video);
  const original = sp.frame === "original" && !isVideo;

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
  // PATHS AND URLS MUST STAY INDEX-ALIGNED. Mapping then filtering breaks that
  // the moment one slide fails to sign: every later URL shifts down a position,
  // so slide 4's image renders as slide 3. On a re-order screen that is not a
  // cosmetic bug — the operator would rearrange based on a picture that is not
  // the order, and submit it.
  //
  // So they travel as pairs, and a partial signing failure is visible rather
  // than silently absorbed.
  const slidePairs = slidePaths
    .map((path) => ({ path, url: signed.get(mediaKey("marketing-media", path)) }))
    .filter((s): s is { path: string; url: string } => Boolean(s.url));
  const slideUrls = slidePairs.map((s) => s.url);
  const signedSlidePaths = slidePairs.map((s) => s.path);
  // Re-ordering submits the WHOLE list and the server requires a permutation of
  // what is stored, so a partial view cannot be reordered safely — offering the
  // control would produce a 400 the operator could not act on.
  const slidesFullySigned = slidePairs.length === slidePaths.length && slidePaths.length > 1;
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

  // ONE media element for both views, so the phone and the original can never
  // show different things. A video plays the way a Reel does (TileVideo, no
  // control bar over the caption), and only ever in a phone (isVideo above).
  // initialOpen: this page IS the opened asset, so the player is there from
  // the start with its first frame - not a cover, which for most videos (no
  // poster on file) was a black "No cover image".
  const carousel = isRenderableCarousel(asset.asset_type, slideUrls);
  const phoneMediaEl = carousel ? (
    <CarouselFrame slides={slideUrls} title={asset.title} width={w} height={h} className="h-full w-full" />
  ) : videoUrl ? (
    <TileVideo src={videoUrl} posterUrl={posterUrl} width={w} height={h} title={asset.title} variant="phone" initialOpen />
  ) : imageUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- signed R2 URL, not a static asset
    <img src={imageUrl} alt={asset.title} decoding="async" width={w ?? undefined} height={h ?? undefined} className="h-full w-full object-contain" />
  ) : null;
  // What the phone's screen shows, in place and in the big phone: the media,
  // or the asset's own copy when it has none.
  const phoneScreen = phoneMediaEl ?? (
    <PhoneTextCard
      kicker={asset.format === "html" ? "HTML page" : asset.format === "video" ? "Video - no render on file yet" : "Text post"}
      text={asset.hook || asset.body || asset.title}
      note="No media is attached to this asset yet."
    />
  );

  // Instagram unless the asset is TikTok-first; ?chrome= switches it.
  const chrome = phoneChromeFor(sp.chrome, asset.channel);
  // The phone's shape, for the preview and the big phone alike.
  const phoneShape: PhoneFrameShape = {
    mediaW: w,
    mediaH: h,
    aspect: asset.aspect,
    handle: asset.brand_name || asset.brand_slug,
    caption: phoneMediaEl ? asset.hook : null,
    chrome,
    guides,
  };
  const detailHref = (next: { original?: boolean; chrome?: "instagram" | "tiktok"; guides?: boolean }) => {
    const q = new URLSearchParams();
    const nextOriginal = next.original ?? original;
    if (nextOriginal) q.set("frame", "original");
    const nextChrome = next.chrome ?? (sp.chrome === "instagram" || sp.chrome === "tiktok" ? sp.chrome : null);
    if (!nextOriginal && nextChrome) q.set("chrome", nextChrome);
    if (!nextOriginal && (next.guides ?? guides)) q.set("guides", "1");
    // A preview toggle keeps the way back to the Library view.
    if (libraryBack !== "/founders/marketing/library") q.set("from", libraryBack);
    const s = q.toString();
    return `/founders/marketing/asset/${asset.id}${s ? `?${s}` : ""}`;
  };

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
    // Named, not addressed — two founders contribute here and "Adon" is a
    // person you recognise where adon@oasisai.work is a string you parse.
    ["Added by", authorName(asset.author_email)],
    ["Format", asset.format],
    ["Aspect", asset.aspect],
    ["Duration", fmtDuration(asset.duration_s as unknown as number)],
    ["Size", fmtBytes(video?.bytes ?? image?.bytes)],
    ["Campaign", asset.campaign],
    // The role, never the agent's internal name.
    ["Made by", madeByLabel(asset.author_agent)],
    ["Published", asset.published_at ? new Date(asset.published_at).toLocaleString() : null],
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title={asset.title}
        subtitle={asset.hook || "No hook recorded"}
        action={
          // Back to the Library view this asset was opened from, not page 1 of
          // the default tab.
          <Link
            href={libraryBack}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Library
          </Link>
        }
      />

      <div className={`grid gap-6 ${vertical || !original ? "lg:grid-cols-[minmax(0,380px)_1fr]" : "lg:grid-cols-2"}`}>
        {/* Enlarge opens this asset in the big phone, in either view; a video
            playing here carries on there from the same second. */}
        <PhoneEnlarge title={asset.title} frame={phoneShape} media={phoneScreen} className="space-y-3">
          {original ? (
            <Card noPadding>
              <div
                className={`relative flex items-center justify-center overflow-hidden rounded-xl bg-bg-deep ${frame.className}`}
                style={frame.style}
              >
                {phoneMediaEl ?? (
                  <div className="p-8 text-center text-sm text-fg-dim">
                    No playable media is attached to this asset.
                  </div>
                )}
              </div>
            </Card>
          ) : (
            // THE PHONE IS THE DEFAULT VIEW. The asset at its real shape inside a
            // 9:19.5 screen with the app's own chrome over it, so the caption,
            // the action column and the letterbox are judged where they will be
            // seen. An asset with no media still shows its copy on the screen.
            <PhoneFrame {...phoneShape} label={asset.title} className="mx-auto max-w-[360px]">
              {phoneScreen}
            </PhoneFrame>
          )}
          <div className="flex flex-wrap items-center justify-center gap-1.5" aria-label="Preview options">
            {/* A video has one view, the phone, so it is offered no choice of view. */}
            {!isVideo && (
              <>
                <PreviewLink href={detailHref({ original: false })} active={!original} label="Phone" />
                <PreviewLink href={detailHref({ original: true })} active={original} label="Original" />
              </>
            )}
            {!original && (
              <>
                {!isVideo && <span className="mx-1 h-4 w-px bg-bg-border" aria-hidden />}
                <PreviewLink href={detailHref({ chrome: "instagram" })} active={chrome === "instagram"} label="Instagram" />
                <PreviewLink href={detailHref({ chrome: "tiktok" })} active={chrome === "tiktok"} label="TikTok" />
                <span className="mx-1 h-4 w-px bg-bg-border" aria-hidden />
                <PreviewLink href={detailHref({ guides: !guides })} active={guides} label="Safe zones" />
              </>
            )}
            <span className="mx-1 h-4 w-px bg-bg-border" aria-hidden />
            <EnlargeButton title={asset.title} />
          </div>
        </PhoneEnlarge>

        <div className="space-y-6">
          <Card title="Status" subtitle="Where this sits, and what you can do about it">
            <div className="mb-4 flex items-center gap-3">
              <StatusTag status={asset.status} publishedAt={asset.published_at} />
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

          {isRenderableCarousel(asset.asset_type, slideUrls) && (
            <Card title="Slide order" subtitle="What the audience reads, and what publishes">
              {slidesFullySigned ? (
                <SlideReorder
                  assetId={asset.id}
                  slidePaths={signedSlidePaths}
                  slideUrls={slideUrls}
                />
              ) : (
                <p className="text-xs text-fg-dim">
                  {slidePaths.length - slidePairs.length} of {slidePaths.length} slides could not
                  be loaded, so the order cannot be changed safely from a partial view. Try again
                  in a minute; the cause is logged for the OASIS team.
                </p>
              )}
            </Card>
          )}

          {/* PUBLISHING IS OASIS-OWN ONLY, and the panel now says so instead of
              offering controls that cannot work.

              This page stopped brand-scoping its read so the four client assets
              in the Library would have a detail page instead of a dead link. The
              publish ROUTE kept its own `brand_slug !== "oasis-ai" -> 404`, which
              is correct — reviewing a client's ad in our library is not licence
              to broadcast it from CC's accounts. But the panel rendered anyway,
              so every asset this change made reachable gained a working-looking
              channel picker whose only possible outcome was `not_found`.

              Making a surface visible is not the same as making every control on
              it applicable, and shipping the second by accident is how the first
              becomes a bug report. Caught by Codex's audit of this change. */}
          {isOwnBrand(asset.brand_slug) ? (
            <Card title="Post to channels" subtitle="Posted from OASIS's connected accounts">
              <AssetPublishPanel
                assetId={asset.id}
                // Was `hasVideo={Boolean(videoUrl)}`. A carousel has no video and
                // never will, so that arrived false and the panel announced that
                // every channel would refuse the asset — about the format CC
                // pivoted the whole feed to on 2026-08-21. The drain publishes
                // image decks correctly (fetch_media returns cover + ordered
                // slides for asset_type "carousel"), so the gate, not the
                // backend, was what stood in the way.
                mediaKind={
                  videoUrl ? "video" : slideUrls.length > 0 || imageUrl ? "images" : "none"
                }
                slideCount={slideUrls.length}
                lastIntent={lastIntent}
                // Server-computed: the panel is a client component and anything
                // derived from `new Date()` inside it would mismatch on hydration.
                staleWarning={stalePublishWarning(lastIntent)}
              />
            </Card>
          ) : (
            <Card title="Post to channels" subtitle="Not available for this brand">
              <p className="text-xs leading-5 text-fg-dim">
                {asset.brand_name} is client work. It is here so you can review and reference it,
                but OASIS&apos;s connected accounts only publish OASIS&apos;s own brand — posting
                this would put a client&apos;s asset out under our handles.
              </p>
            </Card>
          )}

          <Card title="Copy" subtitle="The words that go out with it">
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
