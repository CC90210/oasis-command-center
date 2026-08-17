import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Card, Stat, EmptyState, PageHeader, Tag } from "@/components/Card";
import { MRRProgressChart } from "@/components/charts/MRRProgressChart";
import { LiveClock } from "@/components/LiveClock";
import { timeAgo, truncate, } from "@/lib/fmt";
import {
  operatorDateKey,
  operatorIsWeekend,
} from "@/lib/dates";
import {
  todayCounts,
  pipelineBreakdown,
  getActiveProfile,
  getTodayPlan,
  getLeadById,
  mrrSnapshot,
  mrrHistory,
  priorityInbound,
  topClientConcentration,
  outreachReplyRate,
  activePipeline,
  topOpenLead,
  getTenant,
  momentumMetrics,
} from "@/lib/queries";
import { computeStreak } from "@/lib/streak";
import { safe } from "@/lib/api-helpers";
import { GoalCountdownCard } from "@/components/GoalCountdownCard";
import {
  DEMO_CLIENT_PROFILE_COOKIE,
  getClientCommandCenterProfileById,
  resolveClientProfileSlug,
} from "@/lib/client-profiles";
import { SunBizDashboard } from "@/components/sunbiz/SunBizDashboard";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const profile = await getActiveProfile();
  if (!profile) {
    return (
      <div>
        <PageHeader title="Today" subtitle="No operator profile found." />
        <Card title="Set up your profile">
          <EmptyState message="Sign in to load your profile." />
        </Card>
      </div>
    );
  }

  const tenantId = profile.tenant_id || "";
  const rawDemoProfileSlug = (await cookies()).get(DEMO_CLIENT_PROFILE_COOKIE)?.value || null;
  const demoProfileSlug = profile.tenant_id ? null : rawDemoProfileSlug;
  const demoProfile = getClientCommandCenterProfileById(demoProfileSlug);
  const tenantProfileSlug =
    demoProfile.id !== "default"
      ? demoProfile.id
      : tenantId
        ? await safe(
          "today.tenant_profile_slug",
          (async () => {
            const tenant = await getTenant(tenantId);
            return resolveClientProfileSlug(tenant);
          })(),
          null
        )
        : null;
  // SunBiz operators (Matt et al.) land directly on the manifest
  // dashboard at /t/sun. The prior welcome/setup-wizard screen was
  // removed 2026-05-25 per CC — real operators don't need an intro
  // screen on every login; they need the work surface. Demo previews
  // (unauthenticated visitors with the demo cookie) keep the welcome
  // surface so /demo/sun still shows what the onboarding looks like.
  if (tenantProfileSlug === "sun") {
    const isDemo = demoProfile.id === "sun";
    if (!isDemo) {
      redirect("/t/sun");
    }
    return <SunBizDashboard demoMode={isDemo} />;
  }

  // safe(label, p, fallback) imported from @/lib/api-helpers — used across
  // every dynamic page so one bad reader can't 500 the whole render. The
  // label tags failures in Vercel logs ([safe:today.counts] ...) so a
  // silently-empty Stat is debuggable. This is the Hermes-toggle bug class.
  const [counts, pipeline, mrr, history, plan, inbound, concentration, replyRate, activePipe, topLead, streak, momentum] =
    await Promise.all([
      safe("today.counts", todayCounts(tenantId), { outbound: 0, inbound: 0, decisions: 0, hot: 0 }),
      safe("today.pipeline_breakdown", pipelineBreakdown(tenantId), { stages: {} as Record<string, number>, total: 0, sources: {} as Record<string, number> }),
      safe("today.mrr_snapshot", mrrSnapshot(), { current: 0, target: 5000, pct: 0 }),
      safe("today.mrr_history", mrrHistory(30), [] as Array<{ date: string; mrr: number; synthetic: boolean }>),
      safe("today.plan", getTodayPlan(profile.id), null),
      // Critical/hot-intent only — drops transactional + noreply noise.
      // Falls back to the full firehose only when the classifier hasn't
      // tagged anything yet (see priorityInbound in lib/queries.ts).
      safe("today.priority_inbound", priorityInbound(tenantId, 5), []),
      safe("today.top_client_concentration", topClientConcentration(tenantId), { client_name: "—", pct_of_mrr: 0, is_at_risk: false }),
      safe("today.outreach_reply_rate", outreachReplyRate(tenantId, 7), { sends: 0, replies: 0, rate_pct: 0 }),
      safe("today.active_pipeline", activePipeline(tenantId), { total_active: 0, qualified: 0, proposal: 0 }),
      safe("today.top_open_lead", topOpenLead(tenantId), null),
      safe("today.streak", computeStreak(profile.id, 7), { streak: 0, missed: 0, daysWithPlan: 0, byDay: [] }),
      safe("today.momentum", momentumMetrics(tenantId), { outboundVelocity7d: null, contentPublished7d: null }),
    ]);

  const primaryLead = plan?.primary_lead_id
    ? await safe("today.primary_lead", getLeadById(plan.primary_lead_id), null)
    : topLead; // auto-promote highest-score open lead if no plan-level pin

  const targetDate = profile.mrr_target_date ? new Date(profile.mrr_target_date) : null;
  const daysToTarget = targetDate
    ? Math.max(0, Math.round((targetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : null;
  const gap = Math.max(0, mrr.target - mrr.current);

  const todayKey = operatorDateKey();
  const isWeekend = operatorIsWeekend();
  const missionLine =
    plan?.mission ||
    (isWeekend
      ? "Weekend mode"
      : "Set a mission for today in Settings → Plan Templates");

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

      <GoalCountdownCard
        current={mrr.current}
        target={mrr.target}
        daysLeft={daysToTarget}
        targetDate={targetDate ? targetDate.toISOString().slice(0, 10) : null}
      />

      {/* Hero band — 6 metrics that actually matter */}
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
          it. Reps + content + streak together show whether the dial is
          moving even on days the MRR number doesn't budge. */}
      <section className="grid grid-cols-3 gap-4">
        <Stat
          label="Outbound (7d)"
          value={
            momentum.outboundVelocity7d === null
              ? "—"
              : `${momentum.outboundVelocity7d}`
          }
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
          value={
            momentum.contentPublished7d === null
              ? "—"
              : `${momentum.contentPublished7d}`
          }
          hint={
            momentum.contentPublished7d === null
              ? "metric unavailable"
              : momentum.contentPublished7d > 0
                ? "posts shipped"
                : "0 vs 22 target — distribution dark"
          }
        />
        <Stat
          label="Streak"
          value={`${streak.streak}d`}
          hint={
            streak.streak > 0
              ? `${streak.daysWithPlan}/${streak.daysWithPlan + streak.missed} days planned`
              : "kick off today's plan"
          }
        />
      </section>

      <section className="grid lg:grid-cols-3 gap-6">
        <Card
          title="MRR · 30-day trajectory"
          subtitle={`Target ${targetDate?.toISOString().slice(0, 10) || "—"}`}
          action={history[0]?.synthetic ? <Tag tone="warm">projected</Tag> : null}
        >
          <MRRProgressChart data={history} target={mrr.target} />
        </Card>

        <Card
          title="Primary lead"
          subtitle={
            primaryLead
              ? `Top open · ${primaryLead.company || primaryLead.name}`
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
                  <span className="text-xs text-fg-muted">
                    score {primaryLead.score ?? "—"}
                  </span>
                </div>
                <div className="text-fg font-semibold mt-2">{primaryLead.name}</div>
                <div className="text-fg-muted text-sm">{primaryLead.company}</div>
                {primaryLead.phone && (
                  <div className="text-xs text-fg-dim font-mono mt-1">
                    {primaryLead.phone}
                  </div>
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
          about the same day is worse than one, and this was the one nobody was
          editing. The streak and missed-day counters went with it: they measured
          checkboxes on a surface that no longer exists. */}

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
              <EmptyState
                message="No inbound rows yet. If you've received emails recently, the 'Inbound Email Sweep' cron (every 5 min, bravo-scheduler) may be stopped. Check it under Automations, or run: python scripts/integrations/email_engine.py --json check-inbox"
              />
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
