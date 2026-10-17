/**
 * /founders/marketing/extracted - Content > Extracted videos: every video the
 * Video extractor (Content Tools) saved, kept apart from the Library.
 *
 * CC, 2026-10-17: "there needs to be a video extractor - that's perfect - but it
 * should get stored in a separate category, like extracted videos or whatever,
 * rather than the main library."
 *
 * These are other people's posts (TikTok, YouTube, Instagram) with unknown
 * rights, saved for reference. So this page offers what that work is for:
 * watch, see where it came from, Download, Delete. It offers no review verdicts
 * and no posting, and the founders publish route refuses any brand but OASIS's
 * own, so nothing here can go out from OASIS's accounts.
 *
 * THE SAME ROWS, A DIFFERENT PAGE. The runner still writes brand `downloads`
 * (lib/tools/runner-handlers.ts). This page reads that group through the
 * Library's own loader (loadLibraryPage: tenant-scoped, one page plus a COUNT,
 * media signed for that page only), so a video extracted before this page
 * existed shows here with no migration. The Library no longer has a Downloads
 * tab (LIBRARY_BRAND_GROUPS) and sends ?group=downloads here.
 *
 * FOUNDERS ONLY: resolveFounder() here and in the layouts above, so a client
 * gets a 404, never the tab bar.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { PageFrame } from "@/components/os/PageFrame";
import { ExtractedVideoActions } from "@/components/founders/ExtractedVideoActions";
import { safe } from "@/lib/api-helpers";
import { resolveFounder } from "@/lib/founders/gate";
import { loadLibraryPage, type LibraryPage } from "@/lib/founders/marketing-queries";
import { libraryPageCount, parseLibraryPage } from "@/lib/founders-marketing-core";
import {
  EXTRACTED_BRAND_GROUP,
  EXTRACTED_ROOT,
  extractedAnchor,
  extractedVideoFacts,
  formatBytes,
  formatCount,
  formatDuration,
} from "@/lib/founders/extracted-videos";

export const dynamic = "force-dynamic";
export const metadata = { title: "Extracted videos · Content · OASIS" };

const TOOLS_HREF = "/founders/marketing/tools";

export default async function ExtractedVideosPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const founder = await resolveFounder();
  if (!founder) notFound();

  const sp = await searchParams;
  const requestedPage = parseLibraryPage(sp.page);
  const lib = await safe<LibraryPage | null>(
    "marketing.extracted",
    loadLibraryPage(founder.tenantId, { group: EXTRACTED_BRAND_GROUP, page: requestedPage }),
    null,
  );

  const pages = lib ? libraryPageCount(lib.total, lib.pageSize) : 0;
  const pageHref = (n: number) => (n <= 1 ? EXTRACTED_ROOT : `${EXTRACTED_ROOT}?page=${n}`);

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
          Extract a video
        </Link>
      }
      className="space-y-6"
    >
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
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {lib.tiles.map((t) => {
              const a = t.asset;
              const f = extractedVideoFacts((a as { meta?: unknown }).meta);
              const length = formatDuration(a.duration_s);
              const size = formatBytes(f.bytes);
              const stats = [
                f.views !== null ? `${formatCount(f.views)} views` : null,
                f.likes !== null ? `${formatCount(f.likes)} likes` : null,
                f.comments !== null ? `${formatCount(f.comments)} comments` : null,
              ].filter(Boolean);
              return (
                <li
                  key={a.id}
                  id={extractedAnchor(a.id)}
                  className="scroll-mt-24 space-y-3 rounded-lg border border-hairline p-3"
                  data-testid="extracted-video"
                >
                  {/* One frame height for every card, the video centred in it, so a
                      tall TikTok and a wide YouTube clip line up in the grid. */}
                  <div className="flex h-80 items-center justify-center overflow-hidden rounded-md bg-black">
                    {t.playbackUrl ? (
                      // preload="metadata" + #t=0.1 shows the first frame instead of a black
                      // box, and costs little here: the extractor's MP4s carry their index
                      // (moov) at the front (yt-dlp's ffmpeg merge; measured on 2026-10-17
                      // downloads), so metadata is a small range read, not the whole file
                      // (the Library's TileVideo note is about files that end with it).
                      <video
                        src={`${t.playbackUrl}#t=0.1`}
                        poster={t.posterUrl ?? undefined}
                        controls
                        preload="metadata"
                        playsInline
                        aria-label={a.title}
                        className="h-full max-w-full"
                        style={{ aspectRatio: t.mediaW && t.mediaH ? `${t.mediaW} / ${t.mediaH}` : "9 / 16" }}
                      />
                    ) : (
                      <p className="px-4 text-center text-xs text-fg-muted">The video couldn&apos;t be loaded. Download still works.</p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <p className="line-clamp-2 text-sm font-medium text-fg">{f.postTitle ?? a.title}</p>
                    <p className="text-xs text-fg-muted">
                      {[f.platform, f.creator].filter(Boolean).join(" · ") || "Source unknown"}
                    </p>
                    <p className="text-[11px] text-fg-dim">
                      {[
                        length,
                        size,
                        f.hasAudio === false ? "no sound" : null,
                        f.postedOn ? `posted ${f.postedOn}` : null,
                        `saved ${String(a.created_at).slice(0, 10)}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {stats.length > 0 && <p className="text-[11px] text-fg-dim">{stats.join(" · ")} when saved</p>}
                    {f.originalUrl && (
                      <a
                        href={f.originalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block text-xs text-accent hover:underline"
                      >
                        Open the original post
                      </a>
                    )}
                  </div>
                  <ExtractedVideoActions assetId={a.id} title={a.title} />
                </li>
              );
            })}
          </ul>
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
