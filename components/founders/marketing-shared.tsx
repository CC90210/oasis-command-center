/**
 * Presentational pieces shared by the Marketing surfaces.
 *
 * Pure calc lives in lib/founders-marketing-core.ts — keep it out of this file. Mixing
 * the two makes Next treat the calc helpers as client references and the page
 * crashes at render (same lesson as components/renewals/renewals-shared.tsx).
 */

import Link from "next/link";
import { Tag } from "@/components/Card";
import {
  channelLabel,
  fmtDuration,
  type AssetStatus,
  type Channel,
} from "@/lib/founders-marketing-core";

type Tone = "neutral" | "accent" | "hot" | "warm" | "engaged" | "info";

const STATUS_TONE: Record<AssetStatus, Tone> = {
  draft: "neutral",
  in_review: "warm",
  approved: "accent",
  scheduled: "info",
  published: "engaged",
  rejected: "hot",
  archived: "neutral",
};

export function StatusTag({ status }: { status: AssetStatus }) {
  return <Tag tone={STATUS_TONE[status] ?? "neutral"}>{status.replace("_", " ")}</Tag>;
}

/**
 * One library tile. `playbackUrl` is a short-lived signed Storage URL resolved
 * server-side — the browser never receives a service key.
 */
export function AssetTile({
  id,
  title,
  channel,
  status,
  hook,
  aspect,
  durationS,
  playbackUrl,
  posterUrl,
  format,
  openReviews = 0,
}: {
  id: string;
  title: string;
  channel: Channel;
  status: AssetStatus;
  hook?: string | null;
  aspect?: string | null;
  durationS?: number | null;
  playbackUrl?: string | null;
  posterUrl?: string | null;
  format: string;
  openReviews?: number;
}) {
  const duration = fmtDuration(durationS);
  return (
    <article className="rounded-xl border border-bg-border bg-bg-panel shadow-card overflow-hidden transition-all hover:border-accent/40 hover:shadow-ironman group">
      <div className="relative aspect-video bg-bg-deep flex items-center justify-center overflow-hidden">
        {playbackUrl && format === "video" ? (
          // preload="metadata" so a 200-tile library does not pull 200 videos.
          <video
            src={playbackUrl}
            poster={posterUrl || undefined}
            controls
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
          />
        ) : posterUrl ? (
          // Signed Storage URLs are short-lived and host-varying; next/image
          // would need every Supabase project host in remotePatterns and would
          // re-fetch through the optimizer, which cannot read a private object.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={posterUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="px-4 text-center text-xs text-fg-dim">
            {format === "html"
              ? "HTML page"
              : format === "video"
                ? "no render on file yet"
                : "no preview"}
          </div>
        )}
        {aspect && (
          <span className="absolute left-2 top-2 rounded-full bg-bg-deep/80 px-2 py-0.5 text-[9px] font-bold tracking-wider text-fg-muted">
            {aspect}
          </span>
        )}
        {duration && (
          <span className="absolute bottom-2 right-2 rounded-full bg-bg-deep/80 px-2 py-0.5 text-[9px] font-bold tabular-nums text-fg-muted">
            {duration}
          </span>
        )}
        {openReviews > 0 && (
          <span
            className="absolute right-2 top-2 h-2 w-2 rounded-full bg-accent shadow-glow"
            aria-label={`${openReviews} unread review${openReviews === 1 ? "" : "s"}`}
          />
        )}
      </div>

      <div className="flex flex-col gap-2 p-4">
        <Link
          href={`/founders/marketing/asset/${id}`}
          className="text-sm font-medium text-fg hover:text-accent transition-colors line-clamp-2"
        >
          {title}
        </Link>
        {hook && <p className="text-xs text-fg-muted line-clamp-2 italic">{hook}</p>}
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <span className="text-[10px] uppercase tracking-[0.12em] text-fg-dim font-bold">
            {channelLabel(channel)}
          </span>
          <StatusTag status={status} />
        </div>
      </div>
    </article>
  );
}

/**
 * Honest empty state. Says what is missing AND what to do, because a dashboard
 * that shows nothing without a next action is one people stop opening.
 */
export function MarketingEmpty({
  headline,
  detail,
  hint,
}: {
  headline: string;
  detail: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-dashed border-bg-border bg-bg-deep/30 px-6 py-12 text-center">
      <div className="text-base font-semibold text-fg">{headline}</div>
      <p className="mx-auto mt-2 max-w-lg text-sm text-fg-muted leading-relaxed">{detail}</p>
      {hint && (
        <p className="mx-auto mt-3 max-w-lg text-xs text-fg-dim font-mono leading-relaxed">
          {hint}
        </p>
      )}
    </div>
  );
}
