/**
 * FounderToday — CC and Adon's dashboard. The screen that was `/today` before
 * personas existed, moved here unchanged in substance so the founder view is
 * not collateral damage of scoping everyone else.
 *
 * ONE THING IS NEW: `showFinancials`.
 *
 * Company money — Net MRR, gap to goal, the trajectory chart, top-client
 * concentration — is gated on the viewer standing in an OASIS-owned workspace
 * (lib/role-surfaces.ts `capabilitiesFor`), because "admin" is a per-tenant
 * word and an owner of somebody else's workspace is not an owner of ours.
 * When that cannot be established the queries DO NOT RUN, and the page says so
 * in a sentence instead of rendering a confident $0.
 *
 * That last part is the whole reason the flag reaches this deep rather than the
 * caller rendering a different component: a dashboard silently missing its
 * revenue reads as "the business made nothing", which is a worse lie than an
 * error message.
 */

import Link from "next/link";
import { Card, Stat, EmptyState, PageHeader, Tag } from "@/components/Card";
import { MRRProgressChart } from "@/components/charts/MRRProgressChart";
import { LiveClock } from "@/components/LiveClock";
import { GoalCountdownCard } from "@/components/GoalCountdownCard";
import { timeAgo, truncate } from "@/lib/fmt";
import { operatorDateKey, operatorIsWeekend } from "@/lib/dates";
import {
  todayCounts,
  pipelineBreakdown,
  getTodayPlan,
  getLeadById,
  mrrSnapshot,
  mrrHistory,
  priorityInbound,
  topClientConcentration,
  outreachReplyRate,
  activePipeline,
  topOpenLead,
  momentumMetrics,
} from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import type { UserProfile } from "@/lib/supabase";

type MrrSnapshot = { current: number; target: number; pct: number };
type MrrPoint = { date: string; mrr: number; synthetic: boolean };
type Concentration = { client_name: string; pct_of_mrr: number; is_at_risk: boolean };

export async function FounderToday({
  profile,
  showFinancials,
  financialsNote,
}: {
  profile: UserProfile;
  /** False → the money queries are never issued. Not "issued and hidden". */
  showFinancials: boolean;
  /** Why the money is absent, in plain English. Rendered when showFinancials is false. */
  financialsNote?: string | null;
}) {
  const tenantId = profile.tenant_id || "";

  // safe(label, p, fallback) — used across every dynamic page so one bad reader
  // can't 500 the whole render. The label tags failures in Vercel logs
  // ([safe:today.counts] ...) so a silently-empty Stat is debuggable.
  const [counts, pipeline, plan, inbound, replyRate, activePipe, topLead, momentum] =
    await Promise.all([
      safe("today.counts", todayCounts(tenantId), { outbound: 0, inbound: 0, decisions: 0, hot: 0 }),
      safe("today.pipeline_breakdown", pipelineBreakdown(tenantId), { stages: {} as Record<string, number>, total: 0, sources: {} as Record<string, number> }),
      safe("today.plan", getTodayPlan(profile.id), null),
      // Critical/hot-intent only — drops transactional + noreply noise.
      safe("today.priority_inbound", priorityInbound(tenantId, 5), []),
      safe("today.outreach_reply_rate", outreachReplyRate(tenantId, 7), { sends: 0, replies: 0, rate_pct: 0 }),
      safe("today.active_pipeline", activePipeline(tenantId), { total_active: 0, qualified: 0, proposal: 0 }),
      safe("today.top_open_lead", topOpenLead(tenantId), null),
      safe("today.momentum", momentumMetrics(tenantId), { outboundVelocity7d: null, contentPublished7d: null, contentSends7d: null }),
    ]);

  // The money block. A SEPARATE await, entered only when the capability says so
  // — the point of the branch is that these three reads never happen otherwise,
  // not that their results get dropped afterwards.
  let mrr: MrrSnapshot | null = null;
  let history: MrrPoint[] = [];
  let concentration: Concentration | null = null;
  if (showFinancials) {
    const [m, h, c] = await Promise.all([
      safe("today.mrr_snapshot", mrrSnapshot(), { current: 0, target: 5000, pct: 0 }),
      safe("today.mrr_history", mrrHistory(30), [] as MrrPoint[]),
      safe("today.top_client_concentration", topClientConcentration(tenantId), { client_name: "—", pct_of_mrr: 0, is_at_risk: false }),
    ]);
    mrr = m;
    history = h;
    concentration = c;
  }

  const primaryLead = plan?.primary_lead_id
    ? await safe("today.primary_lead", getLeadById(plan.primary_lead_id), null)
    : topLead; // auto-promote highest-score open lead if no plan-level pin

  const targetDate = profile.mrr_target_date ? new Date(profile.mrr_target_date) : null;
  const daysToTarget = targetDate
    ? Math.max(0, Math.round((targetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : null;
  const gap = mrr ? Math.max(0, mrr.target - mrr.current) : 0;

  const todayKey = operatorDateKey();
  const isWeekend = operatorIsWeekend();
  // DERIVED FROM THE GOAL, not from the retired plan pipeline.
  //
  // This read `plan?.mission`, and on 2026-08-17 it was rendering "The structure
  // survives the cheat days. $5K MRR by May 30." beside tiles reading $10,000 and
  // 09-30. The mission text came from a daily_plan row written by the
  // materialisation cron that fed "The day" — a surface now retired — so it had
  // been frozen since whenever that last ran, contradicting the live numbers
  // directly under it.
  //
  // A header line that restates the goal cannot go stale, because it is computed
  // from the same figures as the countdown beside it.
  const missionLine = isWeekend
    ? "Weekend mode"
    : mrr
      ? `$${mrr.target.toLocaleString()} by ${targetDate?.toISOString().slice(0, 10) ?? "the target date"}`
      : "Operating view";

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Today"
        subtitle={
          <>
            <LiveClock initialDateKey={todayKey} /> · {profile.brand} · {missionLine}
          </>
        }
        action={<Tag tone={isWeekend ? "info" : "accent"}>{isWeekend ? "weekend" : "weekday"}</Tag>}
      />

      {!showFinancials && (
        <Card title="Financials not shown">
          <EmptyState
            message={
              financialsNote ||
              "Company revenue is scoped to an OASIS workspace and this session is not in one. Nothing is wrong with the numbers — they were not requested."
            }
          />
        </Card>
      )}

      {mrr && (
        <GoalCountdownCard
          current={mrr.current}
          target={mrr.target}
          daysLeft={daysToTarget}
          targetDate={targetDate ? targetDate.toISOString().slice(0, 10) : null}
        />
      )}

      {/* Hero band — 6 metrics that actually matter */}
      {mrr && concentration && (
        <section className="grid grid-cols-2 lg:grid-cols-6 gap-4">
          <Stat
            label="Net MRR"
            value={`$${Math.round(mrr.current).toLocaleString()}`}
            accent
            hint={`${mrr.pct.toFixed(1)}% of $${Math.round(mrr.target).toLocaleString()}`}
          />
          <Stat
            label="Gap to goal"
            value={`$${Math.round(gap).toLocaleString()}`}
            hint={daysToTarget !== null ? `${daysToTarget}d to deadline` : ""}
          />
          <Stat
            label="Days left"
            value={daysToTarget !== null ? `${daysToTarget}` : "—"}
            hint={targetDate ? `until ${targetDate.toISOString().slice(5, 10)}` : ""}
          />
          <Stat
            label="Replies (7d)"
            value={`${replyRate.replies}`}
            hint={replyRate.replies > 0 ? "Inbound waiting on you" : "No replies this week"}
          />
          <Stat
            label="MRR added (7d)"
            value={(() => {
              const last = history[history.length - 1]?.mrr ?? mrr.current;
              const wkAgo = history[history.length - 8]?.mrr ?? last;
              const delta = Math.round(last - wkAgo);
              return delta >= 0 ? `+$${delta.toLocaleString()}` : `-$${Math.abs(delta).toLocaleString()}`;
            })()}
            hint={history[0]?.synthetic ? "projected (no real history yet)" : "real delta"}
          />
          <Stat
            label="Top client share"
            value={concentration.pct_of_mrr > 0 ? `${concentration.pct_of_mrr.toFixed(0)}%` : "—"}
            hint={
              concentration.is_at_risk
                ? `⚠ ${truncate(concentration.client_name, 18)}`
                : truncate(concentration.client_name, 22)
            }
          />
        </section>
      )}

      {/* Secondary band — pipeline health */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat
          label="Active pipeline"
          value={activePipe.total_active}
          hint={`${activePipe.qualified} qualified · ${activePipe.proposal} proposal`}
        />
        <Stat
          label="Reply rate (7d)"
          value={replyRate.sends > 0 ? `${replyRate.rate_pct.toFixed(1)}%` : "—"}
          hint={`${replyRate.replies} replies / ${replyRate.sends} sent`}
        />
        <Stat
          label="Decisions today"
          value={counts.decisions}
          hint={counts.decisions > 0 ? "agent ticks" : "quiet"}
        />
        <Stat
          label="Pipeline (all)"
          value={pipeline.total}
          hint={`${pipeline.stages.qualified || 0} qualified · ${pipeline.stages.won || 0} won`}
        />
      </section>

      {/* Momentum band — non-money signals that still measure direction.
          Money is the north star; momentum is whether you're aimed at
          it. Reps + content together show whether the dial is moving
          even on days the MRR number doesn't budge. */}
      <section className="grid grid-cols-3 gap-4">
        <Stat
          label="Outbound (7d)"
          value={momentum.outboundVelocity7d === null ? "—" : `${momentum.outboundVelocity7d}`}
          hint={
            momentum.outboundVelocity7d === null
              ? "metric unavailable"
              : momentum.outboundVelocity7d > 0
                ? "emails + DMs + calls"
                : "no reps this week"
          }
        />
        <Stat
          label="Content (7d)"
          value={momentum.contentPublished7d === null ? "—" : `${momentum.contentPublished7d}`}
          hint={
            momentum.contentPublished7d === null
              ? "metric unavailable"
              : momentum.contentPublished7d > 0
                ? `${momentum.contentSends7d ?? 0} sends across the networks`
                : "nothing published this week"
          }
        />
        {/* The Streak tile went with "The day" on 2026-08-17. It counted
            checkboxes on a planner that no longer exists, so it could only ever
            read 0d. A metric whose input is gone does not degrade to a low
            number, it degrades to a lie. /schedule is the planner now. */}
      </section>

      <section className="grid lg:grid-cols-3 gap-6">
        {mrr && (
          <Card
            title="MRR · 30-day trajectory"
            subtitle={`Target ${targetDate?.toISOString().slice(0, 10) || "—"}`}
            action={history[0]?.synthetic ? <Tag tone="warm">projected</Tag> : null}
          >
            <MRRProgressChart data={history} target={mrr.target} />
          </Card>
        )}

        <Card
          title="Primary lead"
          subtitle={
            // "Top open · null" — what this rendered on screen. `company || name`
            // falls through to `null` when BOTH are absent, and a template
            // literal stringifies that rather than dropping it. A lead with
            // neither field is normal (an inbound with only an email).
            primaryLead
              ? `Top open · ${primaryLead.company || primaryLead.name || primaryLead.email || "unnamed lead"}`
              : "No active lead"
          }
        >
          {primaryLead ? (
            <div className="space-y-3">
              <div>
                <div className="flex items-center gap-2">
                  <Tag tone={primaryLead.status === "qualified" ? "engaged" : "accent"}>
                    {primaryLead.status || "new"}
                  </Tag>
                  <span className="text-xs text-fg-muted">score {primaryLead.score ?? "—"}</span>
                </div>
                <div className="text-fg font-semibold mt-2">{primaryLead.name}</div>
                <div className="text-fg-muted text-sm">{primaryLead.company}</div>
                {primaryLead.phone && (
                  <div className="text-xs text-fg-dim font-mono mt-1">{primaryLead.phone}</div>
                )}
              </div>
              {plan?.primary_lead_play && (
                <div className="bg-accent-soft border-l-2 border-accent rounded-r-md px-3 py-2.5 text-sm text-fg">
                  {plan.primary_lead_play}
                </div>
              )}
            </div>
          ) : (
            <EmptyState message="No active lead in the pipeline." />
          )}
        </Card>
      </section>

      {/* "The day" planner removed 2026-08-17. /schedule is the live calendar
          now — a drag-and-drop week with real durations — and this card was the
          older list-shaped version of the same idea. Two planners disagreeing
          about the same day is worse than one. */}

      <section className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Card
            title="Critical inbound"
            subtitle={
              inbound.length > 0
                ? `${inbound.length} high-signal · most recent ${timeAgo(inbound[0].created_at)} · transactional + noreply filtered`
                : "n8n inbound bridge — see diagnostic if stale"
            }
            action={
              <Link
                href="/integrations"
                className="text-xs text-fg-muted hover:text-accent transition-colors"
              >
                {inbound.length === 0 || (inbound[0] && Date.now() - new Date(inbound[0].created_at).getTime() > 7 * 24 * 60 * 60 * 1000)
                  ? "Check sweep →"
                  : null}
              </Link>
            }
          >
            {inbound.length === 0 ? (
              <EmptyState message="No inbound rows yet. If you've received emails recently, the 'Inbound Email Sweep' cron (every 5 min, bravo-scheduler) may be stopped. Check it under Automations, or run: python scripts/integrations/email_engine.py --json check-inbox" />
            ) : (
              <ul className="divide-y divide-bg-border">
                {inbound.map((i) => {
                  const meta = (i.metadata || {}) as Record<string, unknown>;
                  const cls = (meta.classification || {}) as Record<string, unknown>;
                  const intent = (cls.intent as string) || "unclassified";
                  const summary = (cls.summary as string) || "";
                  const action = (cls.agent_action as string) || "";
                  const tone =
                    intent === "hot_lead" || intent === "frustrated"
                      ? "hot"
                      : intent === "sales" || intent === "business_opportunity" || intent === "partnership" || intent === "booking"
                        ? "engaged"
                        : intent === "strategic" || intent === "pricing_question"
                          ? "accent"
                          : intent === "ambiguous" || intent === "security"
                            ? "warm"
                            : "neutral";
                  return (
                    <li key={i.id} className="py-3">
                      <Link
                        href={`/interactions/${i.id}`}
                        className="block -mx-2 px-2 py-1 rounded-md hover:bg-bg-elev transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <Tag tone={tone}>{intent}</Tag>
                          {action && action !== "silent_skip" && (
                            <span className="text-[10px] uppercase tracking-wider font-bold text-fg-dim">
                              {action.replace("_", " ")}
                            </span>
                          )}
                          <span className="text-xs text-fg-dim ml-auto">{timeAgo(i.created_at)}</span>
                        </div>
                        <div className="text-fg mt-1.5 text-sm">{truncate(i.subject, 80)}</div>
                        {summary ? (
                          <div className="text-xs text-fg-muted mt-1 leading-relaxed">{truncate(summary, 140)}</div>
                        ) : (
                          <div className="text-xs text-fg-dim mt-0.5 font-mono">
                            {(meta.from_identity as string) || "—"}
                          </div>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        {profile.manifesto && (
          <Card title="Direction" subtitle="Read this when you don't feel like making the next call">
            <div className="prose-manifesto text-sm">
              {profile.manifesto.split("\n\n").slice(0, 6).map((para, i) => (
                <p key={i}>{para}</p>
              ))}
              <p className="closing">— {profile.full_name}</p>
            </div>
          </Card>
        )}
      </section>
    </div>
  );
}
