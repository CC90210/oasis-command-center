/**
 * /ai-audits — the Free AI Audit board: the numbers first (what waits on CC,
 * what is in progress, with the client, won, the close rate), then every
 * engagement, its CRM stage (the brief's 13), any flag (stalled, failed,
 * needs you) and the next thing to do. Founders of OASIS's own workspaces
 * only. An engagement starts from the lead's page ("Start AI audit").
 *
 * Not /ai-audit: that address is the public campaign link to the Free AI Audit
 * offer page (a permanent redirect in next.config.js), so the board placed
 * there opened the landing page instead (CC, 2026-10-26).
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageFrame } from "@/components/os/PageFrame";
import { KpiTile } from "@/components/os/KpiTile";
import { aiAuditPageSession } from "@/lib/ai-audit/access";
import { boardMetrics, boardRows, type BoardMetrics } from "@/lib/ai-audit/view";
import { AI_AUDIT_STAGES, AI_AUDIT_STAGE_LABELS, stageNumber } from "@/lib/ai-audit/rules";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const FLAG_WORDS: Record<string, string> = { stalled: "Stalled", failed: "Failed", attention: "Needs you" };

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

export default async function AiAuditBoardPage({ searchParams }: Props) {
  const session = await aiAuditPageSession();
  if (!session) notFound();
  const sp = await searchParams;
  const showClosed = sp.closed === "1";
  const rows = await boardRows(session.db, session.tenantId, showClosed);
  // The numbers fail on their own: a failed read says so in each tile, and the list still loads.
  let metrics: BoardMetrics | null = null;
  try {
    metrics = await boardMetrics(session.db, session.tenantId);
  } catch (err) {
    console.error("[ai-audits] the board's numbers could not be read", err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
  const tile = (value: number) => ({ value: metrics ? value : null, status: metrics ? ("live" as const) : ("error" as const) });
  const closeRate = metrics && metrics.delivered ? `${Math.round((metrics.won / metrics.delivered) * 100)}%` : null;
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.stage, (counts.get(r.stage) ?? 0) + 1);
  const flagged = rows.filter((r) => r.health !== "ok").length;

  return (
    <PageFrame
      title="AI audits"
      subtitle={`${rows.length} ${showClosed ? "engagements" : "open engagements"}${flagged ? `, ${flagged} need attention` : ""}`}
      actions={
        <>
          <Link href="/ai-audits/catalogue" className="btn-secondary">
            Price catalogue
          </Link>
          <Link href="/ai-audits/settings" className="btn-secondary">
            Settings
          </Link>
          <Link href={showClosed ? "/ai-audits" : "/ai-audits?closed=1"} className="btn-secondary">
            {showClosed ? "Open only" : "Include closed"}
          </Link>
        </>
      }
    >
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiTile
          label="Waiting on you"
          {...tile(metrics?.cardsWaiting ?? 0)}
          hint={metrics ? (metrics.problems ? `${metrics.problems} flagged for a look` : "Approvals for transcripts, audits and follow-ups") : "The numbers could not be read"}
          action={metrics && metrics.cardsWaiting ? { label: "Open Needs you", href: "/feed" } : undefined}
        />
        <KpiTile label="In progress" {...tile(metrics?.inProgress ?? 0)} hint={metrics ? "Discovery, research and drafting" : "The numbers could not be read"} />
        <KpiTile
          label="With the client"
          {...tile(metrics?.withClient ?? 0)}
          hint={metrics ? (metrics.stalled ? `${metrics.stalled} stalled` : "Delivered, waiting on them") : "The numbers could not be read"}
        />
        <KpiTile label="Won" {...tile(metrics?.won ?? 0)} hint={metrics ? "Paid, onboarding or active" : "The numbers could not be read"} />
        <KpiTile
          label="Close rate"
          value={closeRate}
          status={!metrics ? "error" : metrics.delivered ? "live" : "no_data"}
          emptyText="Nothing delivered yet"
          hint={metrics ? (metrics.delivered ? `${metrics.won} of ${metrics.delivered} delivered audits paid` : "Paid out of delivered") : "The numbers could not be read"}
        />
      </div>

      <div className="mb-5 overflow-x-auto rounded-xl border border-hairline bg-bg-panel">
        <ol className="flex min-w-max divide-x divide-hairline text-[12px]">
          {AI_AUDIT_STAGES.slice(0, 13).map((s) => (
            <li key={s} className="px-3 py-2">
              <div className="text-fg-dim tabular-nums">{stageNumber(s)}</div>
              <div className="whitespace-nowrap text-fg-muted">{AI_AUDIT_STAGE_LABELS[s]}</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums text-fg">{counts.get(s) ?? 0}</div>
            </li>
          ))}
        </ol>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-hairline bg-bg-panel p-6 text-sm text-fg-muted">
          <p className="font-medium text-fg">{showClosed ? "No audits yet." : "No open audits."}</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>After a discovery call, open the lead in the pipeline and choose Start AI audit.</li>
            <li>The Oasis Meet transcript attaches by itself once everyone agreed to the recording. For another call, paste or upload it.</li>
            <li>Check the profile drafted from the call and approve it. Research and the audit draft follow.</li>
            <li>Review the audit and proposal, then approve the email that sends the client their private link.</li>
          </ol>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-hairline bg-bg-panel">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline text-left text-[12px] text-fg-muted">
                <th className="px-4 py-2 font-medium">Business</th>
                <th className="px-4 py-2 font-medium">Stage</th>
                <th className="px-4 py-2 font-medium">Next</th>
                <th className="px-4 py-2 font-medium">Flag</th>
                <th className="px-4 py-2 text-right font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-hairline last:border-b-0 hover:bg-bg-hover">
                  <td className="px-4 py-2.5">
                    <Link href={`/ai-audits/${r.id}`} className="font-medium text-fg hover:underline">
                      {r.business_name || "Unnamed business"}
                    </Link>
                    {r.is_fixture ? <span className="ml-2 text-[11px] text-fg-dim">test</span> : null}
                    <div className="text-[12px] text-fg-dim">{r.contact_email || "no email"}</div>
                  </td>
                  <td className="px-4 py-2.5 text-fg-muted">
                    {r.stage_number ? <span className="mr-1.5 tabular-nums text-fg-dim">{r.stage_number}.</span> : null}
                    {r.stage_label}
                  </td>
                  <td className="px-4 py-2.5 text-fg">{r.next_action}</td>
                  <td className="px-4 py-2.5">
                    {r.health !== "ok" ? (
                      <span className="text-status-warm" title={r.health_reason ?? undefined}>
                        {FLAG_WORDS[r.health] ?? r.health}
                      </span>
                    ) : r.payment_status === "failed" ? (
                      <span className="text-status-warm">Payment failed</span>
                    ) : (
                      <span className="text-fg-dim">None</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-fg-muted">{when(r.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageFrame>
  );
}
