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
 */
import { notFound } from "next/navigation";
import Link from "next/link";

import { Card, PageHeader } from "@/components/Card";
import { resolveFounder } from "@/lib/founders/gate";
import { platformLabel } from "@/lib/founders-marketing-core";
import {
  engagements,
  retention,
  type PerfRow,
} from "@/lib/founders-performance-core";
import { getPerformance } from "@/lib/founders/performance-queries";

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

  const perf = await getPerformance(founder.tenantId, 30);
  const { totals, byPlatform, rows } = perf;

  const topByViews = [...rows].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 5);
  const withRetention = rows
    .map((r) => ({ r, ret: retention(r) }))
    .filter((x): x is { r: PerfRow; ret: number } => x.ret !== null)
    .sort((a, b) => b.ret - a.ret)
    .slice(0, 3);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Performance"
        subtitle={
          perf.degraded
            ? "Could not read the metrics — the numbers below are not a zero, they are unknown"
            : totals.posts === 0
              ? "Nothing published in the last 30 days"
              : `${totals.posts}${perf.truncated ? "+" : ""} posts · last 30 days · per channel, with provenance`
        }
        action={
          <Link
            href="/founders/marketing"
            className="text-xs font-semibold text-accent hover:underline"
          >
            Back to Studio
          </Link>
        }
      />

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
            The analytics read failed. This is not &ldquo;no data&rdquo; — it is no answer. The
            reason is in the server log under <code>[founders:performance]</code>.
          </p>
        </Card>
      )}

      {!perf.degraded && totals.posts === 0 && (
        <Card>
          <p className="text-sm text-fg-muted">
            No posts in the window yet. Numbers appear here within a few minutes of publishing —
            they are pulled from Zernio on a schedule, not pushed.
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

          <Card title="By channel" subtitle="Same asset, six networks, six different answers">
            <div className="space-y-2">
              {byPlatform.map((p) => {
                const share = totals.views ? (p.views / totals.views) * 100 : 0;
                return (
                  <div key={p.platform} className="flex items-center gap-3">
                    <span className="w-20 shrink-0 text-xs font-medium text-fg-muted">
                      {platformLabel(p.platform)}
                    </span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-bg-deep">
                      <div
                        className="h-full rounded-full bg-accent/70"
                        style={{ width: `${Math.max(share, share > 0 ? 2 : 0)}%` }}
                      />
                    </div>
                    <span className="w-28 shrink-0 text-right text-xs tabular-nums text-fg-muted">
                      {nf.format(p.views)} views
                    </span>
                    <span className="w-24 shrink-0 text-right text-xs tabular-nums text-fg-dim">
                      {nf.format(p.engagements)} eng
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>

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
                      <div className="truncate text-sm text-fg-muted">
                        {r.content_excerpt || "(no caption)"}
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
                        <td className="max-w-[22rem] truncate py-2 pr-3 text-fg-muted">
                          <span className="mr-2 text-[10px] uppercase tracking-wider text-fg-dim">
                            {platformLabel(r.platform)}
                          </span>
                          {r.content_excerpt || "(no caption)"}
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
              Pulled from Zernio{" "}
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
