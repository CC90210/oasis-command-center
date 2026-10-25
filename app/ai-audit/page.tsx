/**
 * /ai-audit — the Free AI Audit board: every engagement, its CRM stage (the
 * brief's 13), any flag (stalled, failed, needs you) and the next thing to do.
 * Founders of OASIS's own workspaces only. An engagement starts from the
 * lead's page ("Start AI audit").
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageFrame } from "@/components/os/PageFrame";
import { aiAuditPageSession } from "@/lib/ai-audit/access";
import { boardRows } from "@/lib/ai-audit/view";
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
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.stage, (counts.get(r.stage) ?? 0) + 1);
  const flagged = rows.filter((r) => r.health !== "ok").length;

  return (
    <PageFrame
      title="AI audits"
      subtitle={`${rows.length} ${showClosed ? "engagements" : "open engagements"}${flagged ? `, ${flagged} need attention` : ""}`}
      actions={
        <>
          <Link href="/ai-audit/catalogue" className="btn-secondary">
            Price catalogue
          </Link>
          <Link href="/ai-audit/settings" className="btn-secondary">
            Settings
          </Link>
          <Link href={showClosed ? "/ai-audit" : "/ai-audit?closed=1"} className="btn-secondary">
            {showClosed ? "Open only" : "Include closed"}
          </Link>
        </>
      }
    >
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
          No engagements yet. Open a lead in the pipeline and choose Start AI audit.
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
                    <Link href={`/ai-audit/${r.id}`} className="font-medium text-fg hover:underline">
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
