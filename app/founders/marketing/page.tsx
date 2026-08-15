/**
 * /founders/marketing — Founders Portal, Studio landing.
 *
 * FOUNDERS ONLY. SunBiz and every other tenant get a 404, not a 403, so they
 * never learn this route exists. The gate keys on TENANT IDENTITY via the
 * FOUNDERS_TENANT_IDS env allowlist — never on role, because is_owner/team_role
 * are per-tenant and SunBiz has its own owners. See lib/founders-marketing-core.ts.
 *
 * This screen opens on DECISIONS, not charts. Research basis: internal
 * dashboards are abandoned overwhelmingly because they present data instead of
 * demanding an action, and adoption that has not happened in ~30 days does not
 * happen. So "what needs you" is the first thing on the page and the numbers
 * sit underneath it.
 *
 * NO ROADMAP PHASES IN THIS COMMENT, deliberately. It used to say "the queue
 * below renders its real (currently zero) counts" — written when the queue was
 * empty. It is 44. The same rot put "No metrics connected yet. Phase 5." on the
 * Performance card for hours after that tab shipped with real numbers behind
 * it, and a stale count in lib/api-helpers' docstring within an hour of my
 * writing it. A roadmap note describes the day it was written; the code moves
 * and the note does not, and then it actively misinforms whoever reads it next.
 *
 * What is true is checkable from here: "needs you" counts assets at `in_review`,
 * the tiles and cards all render an em dash rather than a zero when the read is
 * degraded (tests/marketing-degraded-render.test.ts enforces that), and the
 * Performance card links to a tab that is live.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { Card, PageHeader, Stat } from "@/components/Card";
import { Library, GraduationCap, Inbox, BarChart3 } from "lucide-react";
import { safe } from "@/lib/api-helpers";
import { resolveFounder } from "@/lib/founders/gate";
import {
  DEGRADED_MARKETING_SUMMARY,
  getMarketingSummary,
} from "@/lib/founders/marketing-queries";
import { MarketingEmpty } from "@/components/founders/marketing-shared";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Marketing · OASIS",
};

export default async function MarketingPage() {
  const founder = await resolveFounder();
  if (!founder) notFound();

  // DEGRADED_, not EMPTY_. safe() returns this fallback when the promise THROWS,
  // and a throw is a failure, not an absence — handing it the empty summary put
  // "Nothing waiting on you" back on the screen for every unexpected error, which
  // is precisely what MarketingSummary.degraded was added to stop.
  const summary = await safe(
    "marketing.summary",
    getMarketingSummary(founder.tenantId),
    DEGRADED_MARKETING_SUMMARY,
  );

  // An asset sitting at status `in_review` IS waiting on a verdict. The page
  // previously counted only rows in the marketing_review TABLE, which the review
  // loop (Phase 3) has never written to — so Studio said "Nothing waiting on
  // you" while the Library badged all thirteen assets IN REVIEW. Both were
  // reading truthfully from different sources, and the screen whose entire job
  // is "what needs you" was the one that was wrong.
  const awaitingVerdict = summary.by_status.in_review || 0;

  // A failed read has no number to show. Returning 0 here would put a measured
  // zero on screen next to a panel that just said the query failed.
  const trackCount = (t: "organic" | "paid" | "seo" | "email"): string | number =>
    summary.degraded ? "—" : summary.by_track[t];

  // "NEEDS YOU" MEANS NEEDS *CC*, and only assets awaiting a verdict do.
  //
  // This was `open_reviews + open_requests + awaitingVerdict`, which was wrong
  // twice over. First it double-counted: an asset at status `in_review` that also
  // carries an open marketing_review row is ONE piece of work and was counted as
  // two, inflating the number on the screen whose entire job is to be trusted
  // about workload. Second, and worse, neither of the other two terms is CC's
  // work at all — database/133_marketing_hub.sql is explicit about both:
  //
  //   marketing_review.acted_on_at  "Set when the agent has read and acted on
  //                                  this verdict."  -> open = waiting on MAVEN
  //   marketing_request             "Operator -> agent work queue."
  //                                                  -> open = waiting on MAVEN
  //
  // Both are things CC has already done, queued for Maven to pick up. Counting
  // them as waiting on CC turns his own outbox into his inbox.
  //
  // Identical output today (both are 0 — the Phase 3 loop has never written to
  // either table), and correct the moment Phase 3 starts writing. They are still
  // shown, as their own counts, just not summed into his queue.
  const needsYou = awaitingVerdict;
  /** Queued FOR Maven, not waiting on CC — shown, never summed into his queue. */
  const withMaven = summary.open_reviews + summary.open_requests;

  // The funnel, from the counts the reader already computes. `by_status` has
  // been fetched and thrown away since Phase 1 — this is the pipeline CC asked
  // for ("what has been posted, what hasn't, what needs to be created"), and it
  // costs no extra query.
  const stages: Array<{ key: string; label: string; hint: string }> = [
    { key: "draft", label: "Draft", hint: "not ready" },
    { key: "in_review", label: "In review", hint: "needs a verdict" },
    { key: "approved", label: "Approved", hint: "ready to book" },
    { key: "scheduled", label: "Scheduled", hint: "booked" },
    { key: "published", label: "Published", hint: "live" },
  ];
  const pipelineTotal = stages.reduce((n, st) => n + (summary.by_status[st.key] || 0), 0);

  // Assets whose status is NOT one of the five stages above — today `rejected`
  // and `archived`. They are counted in `summary.total` and appear in no tile,
  // so the header can exceed the pipeline and look like a counting bug.
  //
  // The tempting fix is to redefine total as the sum of the tiles. That would be
  // worse: the header would stop counting assets that genuinely exist, so
  // archiving something would make the Library appear to lose it. The honest fix
  // is to say where the difference went.
  const offPipeline = Math.max(summary.total - pipelineTotal, 0);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Marketing"
        subtitle={
          summary.degraded
            ? `OASIS's own work · at least ${summary.total} ${summary.total === 1 ? "asset" : "assets"} — counts incomplete`
            : summary.total === 0
              ? "Founders portal · nothing registered yet"
              : `OASIS's own work · ${summary.total} ${summary.total === 1 ? "asset" : "assets"} across every channel`
        }
      />

      {/* Decisions first. */}
      <section>
        <div className="mb-3 flex items-baseline justify-between gap-4 px-1">
          <span className="text-[10px] uppercase tracking-[0.14em] font-bold text-fg-muted">
            Needs you
          </span>
          {/* NOT nested under `needsYou > 0`. It was, which made the comment above
              ("they are still shown, as their own counts") false: with nothing
              awaiting a verdict, open_reviews had no surface anywhere on the page
              — open_requests at least still has the Requests card. Each half now
              appears whenever it is non-zero, independently. */}
          {(needsYou > 0 || withMaven > 0) && (
            <span className="text-xs text-fg-dim">
              {needsYou > 0 && <>{awaitingVerdict} awaiting your verdict</>}
              {needsYou > 0 && withMaven > 0 && <> · </>}
              {withMaven > 0 && <>{withMaven} with Maven</>}
            </span>
          )}
        </div>
        {summary.degraded ? (
          // NOT "nothing waiting on you". A query failed, so every number on this
          // page is a floor rather than a fact, and saying "nothing" would be a
          // confident lie about CC's own workload. See MarketingSummary.degraded.
          <MarketingEmpty
            headline="Couldn't load your queue"
            detail="A query failed, so these counts are incomplete — treat them as a floor, not a total. Nothing has been lost; this is a read-side failure. Refresh, and if it persists the server log carries the reason under [marketing:summary]."
            hint="Showing whatever did load, rather than a zero that would look like good news."
          />
        ) : needsYou === 0 ? (
          <MarketingEmpty
            headline="Nothing waiting on you"
            detail="When Maven produces something it lands here for a verdict. Approve, request changes, or reject — a change request with a reason is the most useful thing you can give her."
            hint="Open any asset from the Library to approve or archive it."
          />
        ) : (
          <Card noPadding>
            <div className="divide-y divide-bg-border">
              <div className="px-5 py-4 text-sm text-fg-muted">
                {awaitingVerdict > 0 ? (
                  <>
                    <Link href="/founders/marketing/library?status=in_review"
                          className="font-semibold text-accent hover:underline">
                      {awaitingVerdict} asset{awaitingVerdict === 1 ? "" : "s"}
                    </Link>{" "}
                    awaiting your verdict. The one-click approve/reject loop lands in Phase 3 —
                    until then, review them in the library.
                  </>
                ) : (
                  <>{needsYou} item{needsYou === 1 ? "" : "s"} pending. The review queue UI lands
                    in Phase 3.</>
                )}
              </div>
            </div>
          </Card>
        )}
      </section>

      {/* The pipeline. Where every piece of our own work actually is. */}
      {pipelineTotal > 0 && (
        <section>
          <div className="mb-3 flex items-baseline justify-between px-1">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
              Pipeline
            </span>
            {offPipeline > 0 && (
              <span className="text-[11px] text-fg-dim">
                +{offPipeline} rejected or archived, not shown above
              </span>
            )}
          </div>
          <Card noPadding>
            <div className="grid grid-cols-2 divide-y divide-bg-border sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-5">
              {stages.map((st) => {
                const n = summary.by_status[st.key] || 0;
                return (
                  <Link
                    key={st.key}
                    href={`/founders/marketing/library?status=${st.key}`}
                    className="px-5 py-4 transition-colors hover:bg-bg-hover"
                  >
                    <div className={`text-2xl font-semibold ${n > 0 ? "text-fg" : "text-fg-dim"}`}>
                      {n}
                    </div>
                    <div className="mt-0.5 text-xs font-medium text-fg-muted">{st.label}</div>
                    <div className="text-[10px] text-fg-dim">{st.hint}</div>
                  </Link>
                );
              })}
            </div>
          </Card>
        </section>
      )}

      {/* Counts underneath, never above.

          On a degraded read these show an em dash, not a zero. The queue above
          already says the read failed — printing "0" beside that panel is the
          same confident lie in a smaller font, and a zero is indistinguishable
          from a real measurement of nothing. */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Organic" value={trackCount("organic")} hint="IG · FB · TikTok · YT" />
        <Stat label="Paid" value={trackCount("paid")} hint="Meta · Google" />
        <Stat label="SEO" value={trackCount("seo")} hint="landing · articles" />
        <Stat label="Email" value={trackCount("email")} hint="lifecycle" />
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card
          title="Library"
          subtitle="Everything produced, watchable in place"
          action={
            <Link
              href="/founders/marketing/library"
              className="text-xs font-semibold text-accent hover:underline"
            >
              Open
            </Link>
          }
        >
          <div className="flex items-center gap-3">
            <Library size={18} className="text-accent" aria-hidden />
            <div className="text-sm text-fg-muted">
              {summary.degraded
                ? "Couldn't read the library."
                : summary.total === 0
                  ? "No assets registered yet."
                  : `${summary.total} asset${summary.total === 1 ? "" : "s"} stored.`}
            </div>
          </div>
        </Card>

        <Card title="Training corpus" subtitle="What Maven learns from">
          <div className="flex items-center gap-3">
            <GraduationCap size={18} className="text-accent" aria-hidden />
            <div className="text-sm text-fg-muted">
              {summary.degraded ? (
                "Couldn't read the corpus."
              ) : summary.corpus_indexed === 0 && summary.corpus_pending === 0 ? (
                // Ingestion HAS landed — the route enqueues and
                // scripts/ingest_training_link.py drains it every five minutes.
                // The old copy said Phase 2 long after both halves existed,
                // which reads as "this tab does nothing" to the person whose
                // links are sitting there.
                <>Nothing yet. Drop links in Train and they land here.</>
              ) : (
                <>
                  {summary.corpus_indexed} indexed
                  {summary.corpus_pending > 0 && ` · ${summary.corpus_pending} processing`}
                </>
              )}
            </div>
          </div>
        </Card>

        <Card title="Requests" subtitle="Work you have queued for Maven">
          <div className="flex items-center gap-3">
            <Inbox size={18} className="text-accent" aria-hidden />
            <div className="text-sm text-fg-muted">
              {summary.degraded
                ? "Couldn't read your requests."
                : summary.open_requests === 0
                  ? "Nothing queued."
                  : `${summary.open_requests} open.`}
            </div>
          </div>
        </Card>

        {/* This card said "No metrics connected yet. Phase 5." for hours AFTER
            the Performance tab shipped with 79 posts of real Zernio data behind
            it. A stale placeholder is worse than an empty state: it tells the
            operator a working feature does not exist, so nobody opens it. */}
        <Card
          title="Performance"
          subtitle="Per channel, with provenance"
          action={
            <Link
              href="/founders/marketing/performance"
              className="text-xs font-semibold text-accent hover:underline"
            >
              Open
            </Link>
          }
        >
          <div className="flex items-center gap-3">
            <BarChart3 size={18} className="text-accent" aria-hidden />
            <div className="text-sm text-fg-muted">
              Views, engagement and retention per channel, pulled from Zernio on a
              schedule.
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
}
