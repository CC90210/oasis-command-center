/**
 * /founders/marketing/extracted - Extracted videos: every video the Video
 * extractor (Content Tools) saved, kept apart from the Library. Reached from
 * inside that tool since 2026-10-25 (CC: a tab of its own cluttered Content's
 * bar); the URL stays valid and lights the Content Tools tab.
 *
 * CC, 2026-10-17: "there needs to be a video extractor - that's perfect - but it
 * should get stored in a separate category, like extracted videos or whatever,
 * rather than the main library."
 *
 * These are other people's posts (TikTok, YouTube, Instagram) with unknown
 * rights, saved for reference. So this page offers what that work is for:
 * watch, see where it came from, Download, Delete. It offers no review verdicts
 * and no posting: the founders publish route refuses any brand but OASIS's own,
 * and the asset PATCH route refuses any verdict on an extracted video.
 *
 * THE SAME ROWS, A DIFFERENT PAGE. The runner still writes brand `downloads`
 * (lib/tools/runner-handlers.ts). This page reads that group through the
 * Library's own loader (loadLibraryPage: tenant-scoped, one page plus a COUNT,
 * media signed for that page only), every status included (allStatuses: there
 * is no review lifecycle here, so a video is on this page or deleted, and the
 * count matches the Overview tile's). A video extracted before this page
 * existed shows here with no migration. The Library has no Downloads tab
 * (LIBRARY_BRAND_GROUPS) and sends ?group=downloads here.
 *
 * ?video=<id> (the Video extractor's "Open in Extracted videos", the asset
 * page's way back) shows that one video first, even when it sits past page one.
 *
 * Videos mount lazily (components/founders/LazyVideo.tsx): the server markup
 * holds no <video>, so a page of 24 cards fetches nothing until a card nears
 * the screen.
 *
 * FOUNDERS ONLY: resolveFounder() here and in the layouts above, so a client
 * gets a 404, never the tab bar.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { PageFrame } from "@/components/os/PageFrame";
import { DownloadFailureNotice } from "@/components/founders/DownloadFailureNotice";
import { ExtractedVideoActions } from "@/components/founders/ExtractedVideoActions";
import { LazyVideo } from "@/components/founders/LazyVideo";
import { safe } from "@/lib/api-helpers";
import { resolveFounder } from "@/lib/founders/gate";
import {
  getMarketingAsset,
  loadLibraryPage,
  signMediaUrl,
  type LibraryPage,
  type LibraryTile,
} from "@/lib/founders/marketing-queries";
import { libraryPageCount, parseLibraryPage } from "@/lib/founders-marketing-core";
import {
  EXTRACTED_BRAND_GROUP,
  EXTRACTED_BRAND_SLUG,
  EXTRACTED_ROOT,
  extractedAnchor,
  extractedVideoFacts,
  formatBytes,
  formatCount,
  formatDuration,
} from "@/lib/founders/extracted-videos";

export const dynamic = "force-dynamic";
export const metadata = { title: "Extracted videos \u00B7 Content \u00B7 OASIS" };

const TOOLS_HREF = "/founders/marketing/tools#video-extractor";
const DOT = " \u00B7 ";
const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One extracted video by id, signed, or null when it is not this workspace's extracted video. */
async function pinnedTile(tenantId: string, id: string): Promise<LibraryTile | null> {
  const asset = await getMarketingAsset(tenantId, id);
  if (!asset || asset.brand_slug !== EXTRACTED_BRAND_SLUG) return null;
  const video = (asset.media || []).find((m) => m.kind === "video");
  return {
    asset,
    playbackUrl: video ? await signMediaUrl(video.storage_bucket, video.storage_path) : null,
    posterUrl: null,
    mediaW: video?.width ?? null,
    mediaH: video?.height ?? null,
    slideUrls: [],
  };
}

function VideoCard({ t, pinned = false }: { t: LibraryTile; pinned?: boolean }) {
  const a = t.asset;
  const f = extractedVideoFacts((a as { meta?: unknown }).meta);
  const stats = [
    f.views !== null ? `${formatCount(f.views)} views` : null,
    f.likes !== null ? `${formatCount(f.likes)} likes` : null,
    f.comments !== null ? `${formatCount(f.comments)} comments` : null,
  ].filter(Boolean);
  return (
    <li
      id={extractedAnchor(a.id)}
      className={`scroll-mt-24 space-y-3 rounded-lg border p-3 ${pinned ? "border-accent" : "border-hairline"}`}
      data-testid={pinned ? "extracted-pinned" : "extracted-video"}
    >
      {/* One frame height for every card, the video centred in it, so a tall
          TikTok and a wide YouTube clip line up in the grid. */}
      <div className="flex h-80 items-center justify-center overflow-hidden rounded-md bg-black">
        {t.playbackUrl ? (
          <LazyVideo src={t.playbackUrl} posterUrl={t.posterUrl} width={t.mediaW} height={t.mediaH} title={a.title} />
        ) : (
          <p className="px-4 text-center text-xs text-fg-muted">The video couldn&apos;t be loaded. Download still works.</p>
        )}
      </div>
      <div className="space-y-1">
        <p className="line-clamp-2 text-sm font-medium text-fg">{f.postTitle ?? a.title}</p>
        <p className="text-xs text-fg-muted">{[f.platform, f.creator].filter(Boolean).join(DOT) || "Source unknown"}</p>
        <p className="text-[11px] text-fg-dim">
          {[
            formatDuration(a.duration_s),
            formatBytes(f.bytes),
            f.hasAudio === false ? "no sound" : null,
            f.postedOn ? `posted ${f.postedOn}` : null,
            `saved ${String(a.created_at).slice(0, 10)}`,
          ]
            .filter(Boolean)
            .join(DOT)}
        </p>
        {stats.length > 0 && <p className="text-[11px] text-fg-dim">{stats.join(DOT)} when saved</p>}
        {f.originalUrl && (
          <a href={f.originalUrl} target="_blank" rel="noopener noreferrer" className="inline-block text-xs text-accent hover:underline">
            Open the original post
          </a>
        )}
      </div>
      <ExtractedVideoActions assetId={a.id} title={a.title} />
    </li>
  );
}

export default async function ExtractedVideosPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; video?: string; download?: string }>;
}) {
  const founder = await resolveFounder();
  if (!founder) notFound();

  const sp = await searchParams;
  const requestedPage = parseLibraryPage(sp.page);
  const wanted = typeof sp.video === "string" && ASSET_ID.test(sp.video) ? sp.video : null;
  const [lib, pinned] = await Promise.all([
    safe<LibraryPage | null>(
      "marketing.extracted",
      loadLibraryPage(founder.tenantId, { group: EXTRACTED_BRAND_GROUP, allStatuses: true, page: requestedPage }),
      null,
    ),
    wanted ? safe<LibraryTile | null>("marketing.extracted.pinned", pinnedTile(founder.tenantId, wanted), null) : null,
  ]);

  const pages = lib ? libraryPageCount(lib.total, lib.pageSize) : 0;
  const pageHref = (n: number) => (n <= 1 ? EXTRACTED_ROOT : `${EXTRACTED_ROOT}?page=${n}`);
  // The opened video leads; the grid below never repeats it.
  const rest = lib ? lib.tiles.filter((t) => t.asset.id !== pinned?.asset.id) : [];

  return (
    <PageFrame
      title="Extracted videos"
      subtitle={
        <>
          Videos saved from TikTok, YouTube and Instagram with the{" "}
          <Link href={TOOLS_HREF} className="text-accent hover:underline">
            Video extractor
          </Link>
          . They&apos;re other people&apos;s posts, kept here for reference and download, apart from the Library.
        </>
      }
      actions={
        <Link href={TOOLS_HREF} className="btn-secondary inline-flex min-h-11 items-center">
          Back to Video extractor
        </Link>
      }
      className="space-y-6"
    >
      {/* A Download pressed on this page that failed comes back here with ?download=<code>. */}
      <DownloadFailureNotice code={sp.download} />
      {pinned && (
        <section aria-label="The video you opened" className="space-y-2">
          <p className="px-1 text-xs text-fg-muted">The video you opened</p>
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <VideoCard t={pinned} pinned />
          </ul>
        </section>
      )}
      {!lib ? (
        <p className="text-[13px] text-status-hot" data-testid="extracted-error">
          Couldn&apos;t load the extracted videos. Reload the page.
        </p>
      ) : lib.tiles.length === 0 ? (
        <div className="rounded-lg border border-hairline px-4 py-6 text-[13px] text-fg-muted" data-testid="extracted-empty">
          Nothing extracted yet. Paste a TikTok, YouTube or Instagram link into the{" "}
          <Link href={TOOLS_HREF} className="text-accent hover:underline">
            Video extractor
          </Link>{" "}
          and the video lands here.
        </div>
      ) : (
        <>
          <p className="px-1 text-xs text-fg-muted" data-testid="extracted-count">
            {lib.total === 1 ? "1 video" : `${lib.total} videos`}
          </p>
          {rest.length > 0 && (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {rest.map((t) => (
                <VideoCard key={t.asset.id} t={t} />
              ))}
            </ul>
          )}
          {pages > 1 && (
            <nav className="flex items-center justify-between text-xs" aria-label="Extracted videos pages">
              {lib.page > 1 ? (
                <Link href={pageHref(lib.page - 1)} className="btn-secondary inline-flex min-h-11 items-center">
                  Newer
                </Link>
              ) : (
                <span />
              )}
              <span className="text-fg-muted">
                Page {lib.page} of {pages}
              </span>
              {lib.page < pages ? (
                <Link href={pageHref(lib.page + 1)} className="btn-secondary inline-flex min-h-11 items-center">
                  Older
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </>
      )}
    </PageFrame>
  );
}
