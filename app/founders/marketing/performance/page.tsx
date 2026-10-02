/**
 * /founders/marketing/performance — what the work actually did.
 *
 * This tab has been a greyed-out chip since the portal shipped, captioned "No
 * metrics connected yet. Phase 5." The metrics existed the whole time: Zernio
 * has been collecting them and nothing here ever read them. 68 of 79 published
 * posts carry non-zero numbers.
 *
 * The numbers arrive by POLLING, not a webhook — Zernio's /v1/webhooks path
 * returns the dashboard HTML rather than an API, so there is no event schema to
 * parse and no way to register an endpoint. Business-Empire-Agent's
 * sync_post_analytics.py fills post_analytics on a cron; see its docstring.
 *
 * RETENTION IS COMPUTED, NOT STORED — average watch time over duration, and only
 * Instagram Reels report watch time at all, so most rows have none. The table
 * says so rather than printing a zero that would read as "nobody watched".
 *
 * THE FRAME FIRST, THE NUMBERS STREAMED (2026-10-01). CC: "clicking on the
 * performance and whatnot, but it just takes a while". The page makes no
 * third-party call: it reads the stored post_analytics snapshot, one bounded
 * query. Its time is round trips: the founder gate (two) and that read (one),
 * and it used to await all three before sending anything (production, the
 * tab's own requests: 256-1,278 ms, CPU 15-28 ms). Now the title, the back link
 * and an honest loading line are sent once the gate passes, and the numbers
 * stream in behind <Suspense> from PerformanceNumbers, which says so in its own
 * section if the read fails. tests/content-speed.test.ts holds this: no
 * post_analytics read before the frame, two reads side by side after it (the
 * window, and each channel's last post), and no fetch() at all while the page
 * renders.
 *
 * EVERY CONNECTED CHANNEL (2026-10-02). The channel card drew one bar per
 * platform that posted in the window, so TikTok and YouTube, quiet since
 * 2026-08-21, were not on the page at all, and LinkedIn read "0 views" beside
 * the impressions it does report. Now every connected channel is listed, a
 * quiet one says how long ago it last posted, and LinkedIn is measured in
 * impressions (channelRows in lib/founders-performance-core.ts). On screen the
 * numbers come from "your posting account"; the vendor's name stays internal.
 */
import { Suspense } from "react";
import { notFound } from "next/navigation";

import { Card, PageHeader } from "@/components/Card";
import { safe } from "@/lib/api-helpers";
import { resolveFounder } from "@/lib/founders/gate";
import { platformLabel, postPermalink } from "@/lib/founders-marketing-core";
import {
  EMPTY_PERF,
  channelNote,
  channelRows,
  engagements,
  retention,
  type PerfRow,
} from "@/lib/founders-performance-core";
import { getPerformance } from "@/lib/founders/performance-queries";
import { PUBLISH_CHANNELS } from "@/lib/founders/publish-targets";

/** The window the page reads, in days. */
const WINDOW_DAYS = 30;

export const dynamic = "force-dynamic";
export const metadata = { title: "Performance · OASIS" };

const nf = new Intl.NumberFormat("en-US");

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums text-fg">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-fg-dim">{hint}</div>}
    </Card>
  );
}

export default async function PerformancePage() {
  const founder = await resolveFounder();
  if (!founder) notFound();

  return (
    <div className="space-y-6 animate-fade-in">
      {/* No "Back to Content" link: the Content tabs above already lead back. */}
      <PageHeader
        title="Performance"
        subtitle="Last 30 days, per channel, from the numbers stored at the last sync"
      />

      <Suspense fallback={<PerformanceLoading />}>
        <PerformanceNumbers tenantId={founder.tenantId} />
      </Suspense>
    </div>
  );
}

/**
 * What the page shows while the numbers are on their way. Shapes and one plain
 * line, never a number: a placeholder that looks like data would be read as
 * data (components/os/PageSkeleton.tsx).
 */
function PerformanceLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <p className="px-1 text-sm text-fg-muted">Loading the numbers...</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-xl border border-bg-border bg-bg-elev/60 animate-pulse-slow" />
        ))}
      </div>
      <div className="h-40 rounded-xl border border-bg-border bg-bg-elev/40 animate-pulse-slow" />
    </div>
  );
}

/**
 * Everything that needs the read, streamed in after the frame. The read is the
 * stored snapshot only (lib/founders/performance-queries.ts); a throw becomes
 * the degraded state below rather than an error page over the whole tab.
 */
async function PerformanceNumbers({ tenantId }: { tenantId: string }) {
  const perf = await safe("founders.performance", getPerformance(tenantId, WINDOW_DAYS), { ...EMPTY_PERF, degraded: true });
  const { totals, rows } = perf;
  // Every connected channel, quiet ones included, then any other that posted.
  const channels = channelRows(perf, PUBLISH_CHANNELS.map((c) => c.id));

  const topByViews = [...rows].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 5);
  const withRetention = rows
    .map((r) => ({ r, ret: retention(r) }))
    .filter((x): x is { r: PerfRow; ret: number } => x.ret !== null)
    .sort((a, b) => b.ret - a.ret)
    .slice(0, 3);

  return (
    <div className="space-y-6">
      <p className="px-1 text-sm text-fg-muted">
        {perf.degraded
          ? "Could not read the metrics — the numbers below are not a zero, they are unknown"
          : totals.posts === 0
            ? "Nothing published in the last 30 days"
            : `${totals.posts}${perf.truncated ? "+" : ""} posts · last 30 days · per channel`}
      </p>

      {/* Posts that have shipped but have no numbers yet. Reported rather than
          hidden: silently omitting a post CC published an hour ago sends him
          looking for a bug, and counting its schema-default zeros would put a
          failed-looking post in the totals. Neither — say it. */}
      {perf.awaitingMetrics > 0 && (
        <Card>
          <p className="text-sm text-fg-muted">
            {perf.awaitingMetrics} post{perf.awaitingMetrics === 1 ? "" : "s"} published
            recently{perf.awaitingMetrics === 1 ? " has" : " have"} no numbers yet — they are
            excluded from the totals above rather than counted as zero. Figures are pulled from
            your posting account on a schedule, not pushed, so they land within the hour.
          </p>
        </Card>
      )}

      {perf.truncated && (
        <Card>
          <p className="text-sm text-status-warm">
            More than {nf.format(rows.length)} posts in this window. The numbers below are the
            {" "}most recent {nf.format(rows.length)} — a partial sum, not a total.
          </p>
        </Card>
      )}

      {perf.degraded && (
        <Card>
          <p className="text-sm text-status-warm">
            Could not load these numbers right now. That is not the same as having none. Try
            again in a minute; the cause is logged for the OASIS team.
          </p>
        </Card>
      )}

      {!perf.degraded && totals.posts === 0 && (
        <Card>
          <p className="text-sm text-fg-muted">
            No posts in the window yet. Numbers appear here within a few minutes of publishing —
            they are pulled from your posting account on a schedule, not pushed.
          </p>
        </Card>
      )}

      {totals.posts > 0 && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Views" value={nf.format(totals.views)} hint="across every channel" />
            <Stat
              label="Engagements"
              value={nf.format(totals.likes + totals.comments + totals.shares + totals.saves)}
              hint={`${nf.format(totals.likes)} likes · ${nf.format(totals.saves)} saves`}
            />
            <Stat label="Impressions" value={nf.format(totals.impressions)} hint="where reported" />
            <Stat
              label="Follows earned"
              value={nf.format(totals.follows)}
              hint="attributed to a post"
            />
          </div>
        </>
      )}

      {/* EVERY connected channel, whether or not it posted in the window: a
          channel that went quiet is listed with how long ago it last posted,
          not dropped. Shown even when nothing posted this month, which is when
          it matters most. Not on a failed read: the card above says so. */}
      {!perf.degraded && channels.length > 0 && (
        <Card
          title="By channel"
          subtitle="Every connected channel. LinkedIn is counted in impressions, the rest in views."
        >
          <div className="space-y-3">
            {channels.map((c) => {
              const note = channelNote(c);
              return (
                <div key={c.platform} data-channel={c.platform}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="w-20 shrink-0 text-xs font-medium text-fg-muted">
                      {platformLabel(c.platform)}
                    </span>
                    <div className="h-2 min-w-[6rem] flex-1 overflow-hidden rounded-full bg-bg-deep">
                      <div
                        className="h-full rounded-full bg-accent/70"
                        style={{ width: `${Math.max(c.share * 100, c.share > 0 ? 2 : 0)}%` }}
                      />
                    </div>
                    {c.measured > 0 ? (
                      <>
                        <span className="w-32 shrink-0 text-right text-xs tabular-nums text-fg-muted">
                          {nf.format(c.reach)} {c.metric}
                        </span>
                        <span className="w-24 shrink-0 text-right text-xs tabular-nums text-fg-dim">
                          {nf.format(c.engagements)} eng
                        </span>
                      </>
                    ) : (
                      <span className="shrink-0 text-right text-xs text-fg-dim">
                        {c.posts > 0 ? "Numbers not in yet" : `No posts in the last ${WINDOW_DAYS} days`}
                      </span>
                    )}
                  </div>
                  {note && <p className="mt-1 pl-[5.75rem] text-[11px] text-status-warm">{note}</p>}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {totals.posts > 0 && (
        <>
          <Card
            title="Held attention longest"
            subtitle="Average watch time over duration — only Reels report it"
          >
            {withRetention.length === 0 ? (
              <p className="text-xs text-fg-dim">
                No post in this window reported watch time. That is a gap in what the networks
                return, not a zero — nothing here is being estimated to fill the space.
              </p>
            ) : (
              <ol className="space-y-3">
                {withRetention.map(({ r, ret }, i) => (
                  <li key={r.platform_post_id} className="flex items-start gap-3">
                    <span className="mt-0.5 text-sm font-semibold tabular-nums text-accent">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      {/* Cut to one line; the title carries the whole caption. */}
                      <div title={r.content_excerpt || undefined} className="truncate text-sm text-fg-muted">
                        <PostLink r={r}>{r.content_excerpt || "(no caption)"}</PostLink>
                      </div>
                      <div className="mt-0.5 text-[11px] text-fg-dim">
                        {platformLabel(r.platform)} · {(ret * 100).toFixed(0)}% watched ·{" "}
                        {Number(r.avg_watch_s).toFixed(1)}s of {Number(r.duration_s).toFixed(1)}s
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card title="Most seen" subtitle="Top 5 by views in the window">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] font-bold uppercase tracking-[0.14em] text-fg-dim">
                    <th className="pb-2 pr-3 font-bold">Post</th>
                    <th className="pb-2 pr-3 text-right font-bold">Views</th>
                    <th className="pb-2 pr-3 text-right font-bold">Eng</th>
                    <th className="pb-2 text-right font-bold">Retention</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-bg-border">
                  {topByViews.map((r) => {
                    const ret = retention(r);
                    return (
                      <tr key={r.platform_post_id}>
                        {/* CC, 2026-08-16: "on our performance page, where we can
                            see the most seen, it should be a clickable link that
                            takes me to that Instagram post."

                            A metrics table you cannot click out of makes checking
                            a number a manual hunt through the app it came from.
                            postPermalink returns null when the stored id cannot
                            build a real URL (Instagram hands back a numeric media
                            id, not the shortcode /p/ needs), and the caption then
                            renders as plain text — a dead link on an accounting
                            page is worse than none, because it looks like the
                            accounting works. */}
                        <td title={r.content_excerpt || undefined} className="max-w-[22rem] truncate py-2 pr-3 text-fg-muted">
                          <span className="mr-2 text-[10px] uppercase tracking-wider text-fg-dim">
                            {platformLabel(r.platform)}
                          </span>
                          <PostLink r={r}>{r.content_excerpt || "(no caption)"}</PostLink>
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums text-fg">
                          {nf.format(r.views)}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums text-fg-muted">
                          {nf.format(engagements(r))}
                        </td>
                        <td className="py-2 text-right tabular-nums text-fg-dim">
                          {ret === null ? "—" : `${(ret * 100).toFixed(0)}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {perf.lastSynced && (
            <p className="text-[11px] text-fg-dim">
              Last pulled from your posting account{" "}
              <time dateTime={perf.lastSynced}>
                {perf.lastSynced.replace("T", " ").slice(0, 16)} UTC
              </time>
              . Numbers are as fresh as the last sync, not live.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The caption, linked to the post itself where the platform id allows one.
 *
 * Falls back to plain text rather than a guessed URL. Instagram's analytics rows
 * carry a numeric media id and `/p/` needs the base64 shortcode, so those link to
 * the account instead — honest about what we can actually reach.
 */
function PostLink({
  r,
  children,
}: {
  r: { platform: string; platform_post_id: string; account_username: string | null };
  children: React.ReactNode;
}) {
  const href = postPermalink(r.platform, r.platform_post_id, r.account_username);
  if (!href) return <>{children}</>;
  // The link's own title is what shows on hover, so it carries the whole
  // caption too: the line it sits in is cut to one line.
  const where = `Open on ${platformLabel(r.platform)}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-fg-dim/40 underline-offset-2 transition-colors hover:text-accent hover:decoration-accent"
      title={typeof children === "string" ? `${children} (${where})` : where}
    >
      {children}
    </a>
  );
}
