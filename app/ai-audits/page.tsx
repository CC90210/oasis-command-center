/**
 * /ai-audits — the Free AI Audit board: the numbers first (what waits on CC,
 * what is in progress, with the client, won, the close rate), then the audits
 * by the stage their lead is in on the Pipeline, then every engagement: its
 * Pipeline stage and queue, the audit's step, any flag (stalled, failed, needs
 * you) and the next thing to do. Founders of OASIS's own workspaces only. An
 * engagement starts from the lead's page ("Start AI audit").
 *
 * ONE PIPELINE (CC, 2026-10-28). The board used to draw the audit's 13 steps
 * as numbered stages of their own, beside the Pipeline's 14: two pipelines for
 * one deal. Its columns are now the Pipeline's own stages, names and colours
 * (lib/ai-audit/pipeline-view.ts), read from each lead's row.
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
import { pipelineColumnKey, pipelineColumnMeta, pipelineColumns } from "@/lib/ai-audit/pipeline-view";
import { setupChecks, type SetupCheck } from "@/lib/ai-audit/setup";
import { SetupChecklist } from "@/components/ai-audit/SetupChecklist";

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
  // Setup reads each check on its own; if even that throws, the board says so instead of hiding the list.
  let setup: SetupCheck[] | null = null;
  try {
    setup = await setupChecks(session.db, session.tenantId, new Date());
  } catch (err) {
    console.error("[ai-audits] the setup checks could not be read", err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
  const tile = (value: number) => ({ value: metrics ? value : null, status: metrics ? ("live" as const) : ("error" as const) });
  const closeRate = metrics && metrics.delivered ? `${Math.round((metrics.won / metrics.delivered) * 100)}%` : null;
  const columns = pipelineColumns(rows);
  const flagged = rows.filter((r) => r.health !== "ok").length;
  // The numbers above count real clients only (boardMetrics), so a test audit on the list says so.
  const tests = rows.filter((r) => r.is_fixture).length;
  const noun = rows.length === 1 ? "engagement" : "engagements";

  return (
    <PageFrame
      title="AI audits"
      subtitle={`${rows.length} ${showClosed ? noun : `open ${noun}`}${flagged ? `, ${flagged} need attention` : ""}${tests ? `, ${tests === 1 ? "1 test" : `${tests} tests`} left out of the numbers` : ""}`}
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

      <div className="mb-5">
        {setup ? (
          <SetupChecklist checks={setup} />
        ) : (
          <div className="rounded-xl border border-hairline bg-bg-panel px-4 py-2.5 text-sm text-status-warm">Setup could not be checked just now. Reload the page; the error was logged.</div>
        )}
      </div>

      <section aria-label="Audits by Pipeline stage" className="mb-5">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg">On the Pipeline</h2>
          <p className="text-[12px] text-fg-dim">The same stages as the Pipeline, with each audit&apos;s step inside.</p>
        </div>
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {columns.map((col) => (
            <li key={col.key} className="min-w-0 rounded-lg border border-hairline bg-bg-panel px-3 py-2" style={{ borderTop: `3px solid ${col.bg}` }}>
              <div className="truncate text-[12px] text-fg-muted" title={col.label}>
                {col.label}
              </div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums text-fg">{col.count}</div>
              {col.steps.length ? (
                <ul className="mt-1 space-y-0.5 text-[11px] text-fg-dim">
                  {col.steps.map((st) => (
                    <li key={st.stage} className="flex justify-between gap-2">
                      <span className="min-w-0 truncate">{st.label}</span>
                      <span className="tabular-nums">{st.count}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-hairline bg-bg-panel p-6 text-sm text-fg-muted">
          <p className="font-medium text-fg">{showClosed ? "No audits yet." : "No open audits."}</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>When the discovery call is booked, open the lead in the pipeline and choose Start AI audit. The pre-call brief builds by itself.</li>
            <li>
              Hold the call in Oasis Meet: its transcript attaches by itself once everyone agreed to the recording. A call held before the audit was started, or anywhere else, is attached or pasted on the
              engagement&apos;s Call and transcripts tab.
            </li>
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
                <th className="px-4 py-2 font-medium">Pipeline</th>
                <th className="px-4 py-2 font-medium">Audit step</th>
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
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/pipeline/${r.lead_id}`}
                      className="inline-block max-w-full truncate rounded px-2 py-0.5 text-[11px] font-semibold hover:opacity-90"
                      style={{ background: pipelineColumnMeta(pipelineColumnKey(r.pipeline_stage)).bg, color: pipelineColumnMeta(pipelineColumnKey(r.pipeline_stage)).fg }}
                      title="Open the lead on the Pipeline"
                    >
                      {r.pipeline_stage_label}
                    </Link>
                    <div className="mt-0.5 text-[12px] text-fg-dim">{r.queue ?? "No queue set"}</div>
                  </td>
                  <td className="px-4 py-2.5 text-fg-muted">{r.stage_label}</td>
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
