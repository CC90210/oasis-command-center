/**
 * /health — System health, the one operator page for "is everything OK?"
 * (2026-09-30: /system-health folds into it and redirects here).
 *
 * OPERATOR ONLY. requireOperator() is the first statement: the page reads the
 * OASIS platform's own schedules, workers and guard reports, which belong to
 * no client workspace. It used requireSystemSurface, which let any client
 * workspace owner open it by URL and read OASIS's cron failures.
 *
 * Top to bottom, one plain sentence per card on what it means for CC:
 *   1. The verdict: is everything protected, and when did the computer last
 *      check in.
 *   2. Your computer: the paired machines (lib/devices/presence.ts) and
 *      whether the Command Center itself can reach the bridge.
 *   3. Safety guards: the five guards on the operator's machine, as that
 *      machine reports them. "Not reported yet" / "Not verified since T",
 *      never "off" for a report that is missing or old.
 *   4. Background work: the OASIS workers, and every schedule that failed in
 *      the last 24 hours with a one-line what-to-do.
 *   5. Platform vitals (lib/admin/platform-vitals.ts): the database round trip,
 *      AI calls, browser errors, health-check runs and the Cloudflare Worker,
 *      each live, "no data yet", "not connected" or failed, never a guessed 0.
 *   6. Automation signals: the buckets that might need you (errors, warnings,
 *      failed automations, workers down), the founder-booking check and the
 *      event list. Leads are not infrastructure: the cold-lead list and tile
 *      left this page on 2026-10-28 (the Pipeline and /operations keep them).
 *
 * Every number comes from lib/admin/system-health.ts, which reads in-process
 * (no HTTP self-fetch; that fetch carried no session and got the middleware's
 * 401) and from lib/admin/attention.ts, the same definition of "needs you" the
 * /operations tiles use. A read that failed says "Couldn't check", never 0.
 */

import { Card, Tag } from "@/components/Card";
import { PageFrame } from "@/components/os/PageFrame";
import { loadPlatformVitals } from "@/lib/admin/platform-vitals";
import { VitalsStrip } from "@/components/health/VitalsStrip";
import { OutcomeChecksPanel } from "@/components/health/OutcomeChecksPanel";
import { resolveTenantId } from "@/lib/api-auth";
import { safe } from "@/lib/api-helpers";
import { requireOperator } from "@/lib/role-surfaces-session";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { getActiveProfile, getTenant } from "@/lib/queries";
import { isAgentsOwner } from "@/lib/agents-owner";
import type { AttentionViewer } from "@/lib/admin/attention";
import { formatEventType, formatPublisher } from "@/lib/event-bus-display";
import { WEBDEV_TENANT_ID } from "@/lib/oasis-tenant";
import { loadWorkspaceOutcome, needsYouCount, type WorkerHealth } from "@/lib/admin/attention";
import { loadSystemHealth, type GuardStatus, type SystemHealth } from "@/lib/admin/system-health";
import { timeAgo } from "@/lib/devices/presence";
import { redirect } from "next/navigation";
import { setupHref } from "@/lib/setup-links";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function HealthPage() {
  await requireOperator();
  const tenantId = await resolveTenantId();
  if (!tenantId) redirect("/login");
  const now = Date.now();

  // O3b: who is looking, so the machine card/verdict describe THEIR OWN
  // computer (never whichever pairing is newest workspace-wide), and the
  // fleet reporter + background workers stay the agents owner's alone.
  // Fail closed (CodeRabbit, PR #588): a viewer we cannot identify sees what a
  // non-owner with no computers sees, never the unscoped view of everyone's
  // computers and the owner's workers; and an owner read that throws is "not
  // the owner", never a crashed page.
  const profile = await safe("health.profile", getActiveProfile(), null);
  const viewerAuthId = profile?.auth_user_id ?? "";
  const viewer: AttentionViewer = {
    authUserId: viewerAuthId,
    isAgentsOwner: viewerAuthId ? await safe("health.agents_owner", isAgentsOwner(tenantId, viewerAuthId), false) : false,
  };

  const [system, tenant, vitals] = await Promise.all([
    loadSystemHealth(tenantId, { now, viewer }),
    safe("health.tenant", getTenant(tenantId), null),
    loadPlatformVitals(tenantId, now),
  ]);
  const profileSlug = tenant ? resolveClientProfileSlug(tenant) : null;
  const isOasisTenant = tenantId === WEBDEV_TENANT_ID;

  // The outcome checks (OASIS: the founder-booking check), loaded once for the
  // card below and the header count, so the two cannot disagree.
  const outcome = await loadWorkspaceOutcome(tenantId, profileSlug, now);

  const a = system.attention;
  // The one count (lib/admin/attention.ts), the same one /operations' "All
  // clear" reads. null = an alarm count could not be read.
  const total = needsYouCount(a, outcome);

  return (
    <PageFrame
      title="System health"
      subtitle="Whether your computer, its guards, your automations and the Command Center itself are working, in plain words. Every line says when it can't tell."
      actions={
        total === null ? (
          <Tag tone="neutral">Couldn&apos;t check everything</Tag>
        ) : total === 0 ? (
          <Tag tone="engaged">Nothing needs you</Tag>
        ) : (
          <Tag tone="warm">{total} need{total === 1 ? "s" : ""} you</Tag>
        )
      }
    >
    <div className="space-y-6">
      <VerdictLine verdict={system.verdict} />
      <VitalsStrip vitals={vitals} />

      <ComputerCard system={system} now={now} />
      <GuardsCard system={system} now={now} />
      <BackgroundCard system={system} now={now} />

      <section aria-label="Automation signals" className="space-y-3">
        <h2 className="text-sm font-semibold text-fg">Automation signals</h2>
        <p className="text-[13px] leading-5 text-fg-muted">
          The buckets that might need you today. A tile that says Couldn&apos;t check could not be read; it is not a zero.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <HealthTile label="Errors today" count={a.errors} alarm hint="Things that broke in the last 24 hours: crashes, failed calls, anything an agent flagged as an error or critical." />
          <HealthTile label="Warnings today" count={a.warnings} hint="Things that went wrong but kept running in the last 24 hours. Worth a look, not an emergency." />
          <HealthTile label="Failed automations" count={a.cronFailures} alarm hint="Schedules whose run in the last 24 hours errored. Each one is listed under Background work with what to do." />
          <HealthTile label="Workers down" count={a.workersDown} alarm hint="Background processes on your computer that stopped reporting or report themselves down." />
        </div>
      </section>

      {outcome && (
        <Card title={isOasisTenant ? "OASIS founder-booking health" : "Are merchants actually being reached?"}>
          <OutcomeChecksPanel
            rows={outcome.rows}
            openAlerts={outcome.openAlerts}
            readFailed={outcome.readFailed}
            readError={outcome.readError}
            now={now}
          />
        </Card>
      )}

      <Card
        title="Errors and warnings today"
        subtitle="What broke or warned in the last 24 hours, newest first. The raw code is kept for looking it up in the logs."
      >
        {system.events === null ? (
          <div className="text-sm text-fg-muted">Couldn&apos;t check the event log just now. This does not mean nothing went wrong. Reload to try again.</div>
        ) : system.events.rows.length === 0 ? (
          <div className="text-sm text-fg-muted">No errors or warnings in the last 24 hours.</div>
        ) : (
          <ul className="space-y-2 text-sm">
            {system.events.rows.map((ev) => (
              <li key={ev.id} className="rounded-lg border border-hairline bg-bg-panel p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Tag tone={ev.severity === "warn" ? "accent" : "warm"}>
                      {ev.severity === "critical" ? "Critical" : ev.severity === "error" ? "Error" : "Warning"}
                    </Tag>
                    <span className="font-mono text-[11px] text-fg-dim" title={ev.eventType}>
                      {formatEventType(ev.eventType)}
                    </span>
                    {ev.publisherAgent && (
                      <span className="text-[11px] text-fg-dim" title={ev.publisherAgent}>
                        {formatPublisher(ev.publisherAgent)}
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-fg-dim">{timeAgo(ev.publishedAt, { now })}</span>
                </div>
                {ev.payload && (
                  <div className="mt-1 max-h-24 overflow-y-auto break-words font-mono text-[11px] text-fg-muted">
                    {JSON.stringify(ev.payload).slice(0, 400)}
                  </div>
                )}
              </li>
            ))}
            {system.events.errors + system.events.warnings > system.events.rows.length && (
              <li className="text-xs text-fg-dim">
                Showing the newest {system.events.rows.length} of {system.events.errors + system.events.warnings}.
              </li>
            )}
          </ul>
        )}
      </Card>

    </div>
    </PageFrame>
  );
}

function VerdictLine({ verdict }: { verdict: SystemHealth["verdict"] }) {
  const tone =
    verdict.tone === "ok"
      ? "border-status-engaged/40 text-status-engaged"
      : verdict.tone === "warn"
        ? "border-status-warm/40 text-status-warm"
        : "border-hairline text-fg-muted";
  return (
    <p role="status" className={`rounded-xl border bg-bg-panel px-4 py-3 text-sm font-medium ${tone}`}>
      {verdict.text}
    </p>
  );
}

function ComputerCard({ system, now }: { system: SystemHealth; now: number }) {
  return (
    <Card
      title="Your computer"
      subtitle="Your agents' tools and your local automations run on this computer through the bridge. While it is offline, they stop."
    >
      {system.machines === null ? (
        <p className="text-sm text-fg-muted">Couldn&apos;t check your paired computers just now. This does not mean none is paired. Reload to try again.</p>
      ) : system.machines.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No computer is paired with this workspace. Pair one in{" "}
          <Link href={setupHref("bridge_devices")} className="text-accent hover:underline">Settings › Devices</Link>.
        </p>
      ) : (
        <ul className="divide-y divide-hairline">
          {system.machines.map((m, i) => (
            <li key={`${m.label}-${i}`} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="text-fg">{m.label}</span>
              <span className="flex items-center gap-2 text-xs text-fg-muted">
                <Tag tone={m.state === "online" ? "engaged" : m.state === "idle" ? "accent" : "neutral"}>
                  {m.state === "online" ? "Online" : m.state === "idle" ? "Idle" : "Offline"}
                </Tag>
                {m.lastSeenAt ? `checked in ${timeAgo(m.lastSeenAt, { now })}` : "never checked in"}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-sm text-fg-muted">
        {system.cloud === null
          ? "Couldn't check whether the Command Center can reach your computer."
          : system.cloud.sentence}
      </p>
    </Card>
  );
}

function guardTone(g: GuardStatus): "engaged" | "warm" | "accent" | "neutral" {
  if (g.state === "on") return "engaged";
  if (g.state === "off" || g.state === "failing") return "warm";
  if (g.state === "watching") return "accent";
  return "neutral";
}

function GuardsCard({ system, now }: { system: SystemHealth; now: number }) {
  const report = system.guards;
  return (
    <Card
      title="Safety guards"
      subtitle="These run on your computer and stop the AI from doing damage there. This page shows only what your computer reports, and says so when it hasn't reported."
    >
      {report === null ? (
        <p className="text-sm text-fg-muted">Couldn&apos;t check the guard report just now. This does not mean the guards are off. Reload to try again.</p>
      ) : (
        <div className="space-y-3">
          {report.freshness === "missing" && (
            <p className="text-sm text-fg-muted">
              Not reported yet: the guards run on CC&apos;s PC, and its bridge doesn&apos;t send their status here yet.
            </p>
          )}
          {report.freshness === "stale" && (
            <p className="text-sm text-status-warm">
              Not verified since {report.reportedAt ? timeAgo(report.reportedAt, { now }) : "an unknown time"}: the last guard report is too old to trust.
            </p>
          )}
          {report.freshness === "failing" && (
            <p className="text-sm text-status-warm">Your computer reported that it couldn&apos;t read its guard logs, so none of them can be verified.</p>
          )}
          <ul className="divide-y divide-hairline">
            {report.guards.map((g) => (
              <li key={g.key} className="py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-fg">{g.name}</span>
                  <Tag tone={guardTone(g)}>{g.state === "not_verified" ? "Not verified" : g.label}</Tag>
                </div>
                <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">{g.plain}</p>
                {report.freshness === "fresh" && g.blocked24h !== null && (
                  <p className="mt-0.5 text-xs text-fg-dim">
                    Blocked {g.blocked24h} in the last 24 hours
                    {g.wouldBlock24h ? `, and would have blocked ${g.wouldBlock24h} more` : ""}
                    {g.lastBlockAt ? `. Last block ${timeAgo(g.lastBlockAt, { now })}.` : "."}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function workerTone(w: WorkerHealth): "engaged" | "warm" | "accent" | "neutral" {
  if (w.state === "running") return "engaged";
  if (w.state === "down" || w.state === "stale") return "warm";
  if (w.state === "trouble") return "accent";
  return "neutral";
}

const WORKER_TAG: Record<WorkerHealth["state"], string> = {
  running: "Running",
  pending: "Running — awaiting result",
  stopped_by_you: "Stopped by you",
  trouble: "Having trouble",
  down: "Down",
  stale: "Stopped reporting",
  no_report: "No report",
};

function BackgroundCard({ system, now }: { system: SystemHealth; now: number }) {
  const reporter = system.reporter;
  return (
    <Card
      title="Background work"
      subtitle="The processes on your computer, the daemon VPS, and the schedules that keep OASIS running while you're away."
    >
      <div className="space-y-4">
        {reporter && (reporter.state === "failing" || reporter.state === "silent") && (
          <p className="text-sm text-status-warm">
            {reporter.state === "failing"
              ? "Your computer is checking in but says it can't read its own process list, so its local worker states may be out of date."
              : "Your computer is checking in but stopped sending its process list, so its local worker states may be out of date."}
          </p>
        )}
        {system.workers === null ? (
          <p className="text-sm text-fg-muted">Couldn&apos;t check the background processes just now. This does not mean they stopped. Reload to try again.</p>
        ) : (
          <ul className="divide-y divide-hairline">
            {system.workers.map((w) => (
              <li key={w.service} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="text-fg">{w.label}</span>
                <span className="flex items-center gap-2 text-xs text-fg-muted">
                  <Tag tone={workerTone(w)}>{WORKER_TAG[w.state]}</Tag>
                  {w.state === "stale" && w.lastPingAt ? `last report ${timeAgo(w.lastPingAt, { now })}` : null}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div>
          <h3 className="text-xs font-semibold text-fg-muted">Schedules that failed in the last 24 hours</h3>
          {system.cron === null ? (
            <p className="mt-1 text-sm text-fg-muted">Couldn&apos;t check the schedules just now. This does not mean none failed. Reload to try again.</p>
          ) : system.cron.rows.length === 0 ? (
            <p className="mt-1 text-sm text-fg-muted">No schedule failed in the last 24 hours.</p>
          ) : (
            <ul className="mt-2 space-y-2 text-sm">
              {system.cron.rows.map((c) => (
                <li key={`${c.source}-${c.id}`} className="rounded-lg border border-status-warm/30 bg-bg-panel p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-fg">{c.name}</span>
                    <span className="text-[11px] text-fg-dim">
                      {c.source === "platform" ? "OASIS platform" : "This workspace"} · {c.lastRunAt ? timeAgo(c.lastRunAt, { now }) : "never ran"}
                    </span>
                  </div>
                  <p className="mt-1 text-[13px] text-fg">What to do: {c.whatToDo}</p>
                  {c.lastResult && (
                    <p className="mt-1 break-words font-mono text-[11px] text-fg-dim">{c.lastResult.slice(0, 300)}</p>
                  )}
                </li>
              ))}
              <li>
                <Link href="/automations" className="text-xs text-accent hover:underline">
                  Open Automations to fix or pause a schedule
                </Link>
              </li>
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

function HealthTile({
  label,
  count,
  hint,
  alarm = false,
}: {
  label: string;
  /** null = the count could not be read: "Couldn't check", never a 0. */
  count: number | null;
  hint: string;
  /** An alarm tile turns warm when above zero; a signal tile stays blue. */
  alarm?: boolean;
}) {
  const toneClasses =
    count === null
      ? "border-hairline bg-bg-panel text-fg-muted"
      : count === 0
        ? "border-status-engaged/40 bg-bg-panel text-status-engaged"
        : alarm
          ? "border-status-warm/40 bg-bg-panel text-status-warm"
          : "border-accent/40 bg-bg-panel text-accent";
  return (
    <div className={`rounded-xl border p-4 ${toneClasses}`} title={count === null ? "This count could not be read; the error has been logged." : hint}>
      <div className="text-xs font-semibold opacity-80">{label}</div>
      {count === null ? (
        <div className="mt-2 text-sm font-semibold">Couldn&apos;t check</div>
      ) : (
        <div className="mt-2 text-3xl font-bold tabular-nums">{count}</div>
      )}
      <div className="mt-2 text-[11px] font-normal leading-snug text-fg-muted">{hint}</div>
    </div>
  );
}
