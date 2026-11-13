/**
 * /ai-audits/scans — how the public free scan (oasisai.work/scan) is being used: totals, scans per
 * day, the kinds of business scanned, and every recent scan with a link to its live report and to
 * the lead or audit it became. Founders only (the AI audits rule, lib/ai-audit/access.ts).
 * Numbers come straight from site_scans (lib/site-scan/metrics.ts); nothing is estimated.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageFrame } from "@/components/os/PageFrame";
import { KpiTile } from "@/components/os/KpiTile";
import { ScanTrend } from "@/components/ai-audit/ScanTrend";
import { aiAuditPageSession } from "@/lib/ai-audit/access";
import { AI_AUDIT_TENANT_ID } from "@/lib/forms/oasis-ai-audit-seed";
import { scanMetrics, type ScanMetrics } from "@/lib/site-scan/metrics";
import { siteScanTablesInstalled } from "@/lib/site-scan/store";

export const dynamic = "force-dynamic";

const STATUS_WORDS: Record<string, string> = {
  queued: "Starting",
  reading: "Reading the site",
  enriching: "Matching",
  done: "Finished",
  failed: "Failed",
};

const ERROR_WORDS: Record<string, string> = {
  enrich_no_runner: "matching engine was offline",
  enrich_overdue: "matching took too long",
  read_timeout: "read timed out",
  read_failed: "site could not be read",
  not_a_website: "not a website",
  tier0_crashed: "stopped partway",
};

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" });
}

function pct(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : "0%";
}

export default async function FreeScansPage() {
  const session = await aiAuditPageSession();
  if (!session) notFound();
  let metrics: ScanMetrics | null = null;
  let installed = true;
  try {
    installed = await siteScanTablesInstalled(session.db);
    if (installed) metrics = await scanMetrics(session.db, AI_AUDIT_TENANT_ID, new Date());
  } catch (err) {
    console.error("[ai-audits.scans] metrics unreadable", err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
  const t = metrics?.totals;
  const status = !metrics ? "error" : t && t.scans ? "live" : "no_data";
  const maxCat = Math.max(1, ...(metrics?.categories.map((c) => c.scans) ?? [1]));

  return (
    <PageFrame
      title="Free scans"
      subtitle="Who ran the free AI scan at oasisai.work/scan, what it found, and who sent their report to the team."
      actions={
        <>
          <a href="/scan" target="_blank" rel="noopener noreferrer" className="btn-secondary">
            Open the scan page
          </a>
          <Link href="/ai-audits" className="btn-secondary">
            Back to AI audits
          </Link>
        </>
      }
    >
      {!installed ? (
        <div className="rounded-xl border border-hairline bg-bg-panel px-4 py-3 text-sm text-status-warm">The free scan&apos;s table is not installed on this deployment yet.</div>
      ) : null}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile label="Scans" value={t ? t.scans.toLocaleString("en-CA") : null} status={status} emptyText="No scans yet" hint={t ? `${t.last24h} today, ${t.last7d} this week` : "The numbers could not be read"} />
        <KpiTile label="People" value={t ? t.visitors.toLocaleString("en-CA") : null} status={status} emptyText="No visitors yet" hint="Distinct visitor addresses (hashed)" />
        <KpiTile label="Websites" value={t ? t.sites.toLocaleString("en-CA") : null} status={status} emptyText="None yet" hint="Distinct sites scanned" />
        <KpiTile
          label="Sent to the team"
          value={t ? t.claimed.toLocaleString("en-CA") : null}
          status={status}
          emptyText="None yet"
          hint={t ? `${pct(t.claimed, t.scans)} of scans became a lead` : "The numbers could not be read"}
        />
        <KpiTile label="Fully matched" value={t ? pct(t.matched, t.scans) : null} status={status} emptyText="None yet" hint={t ? `${t.matched} with competitors and buyers` : "The numbers could not be read"} />
        <KpiTile label="Average score" value={t && t.avgScore !== null ? `${t.avgScore}/100` : null} status={t && t.avgScore !== null ? "live" : status === "error" ? "error" : "no_data"} emptyText="No scores yet" hint={t ? `${t.failed} scan${t.failed === 1 ? "" : "s"} failed` : "The numbers could not be read"} />
      </div>

      {metrics ? (
        <div className="mb-5 grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <ScanTrend days={metrics.days} />
          <section className="rounded-xl border border-hairline bg-bg-panel p-4" aria-label="Kinds of business scanned">
            <h2 className="text-sm font-semibold text-fg">Kinds of business scanned</h2>
            {metrics.categories.length ? (
              <ol className="mt-3 space-y-2">
                {metrics.categories.map((c) => (
                  <li key={c.label} className="text-[12.5px]">
                    <div className="flex justify-between gap-3">
                      <span className="min-w-0 truncate text-fg">{c.label}</span>
                      <span className="tabular-nums text-fg-muted">{c.scans}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-hairline">
                      <div className="h-1.5 rounded-full bg-accent/70" style={{ width: `${(c.scans / maxCat) * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-3 text-[12.5px] text-fg-muted">Appears once the matching engine has classified a scan.</p>
            )}
          </section>
        </div>
      ) : null}

      <section aria-label="Recent scans" className="rounded-xl border border-hairline bg-bg-panel">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3">
          <h2 className="text-sm font-semibold text-fg">Recent scans</h2>
          <p className="text-[12px] text-fg-dim">Open a scan to replay what the agent did. Unclaimed scans are kept 30 days.</p>
        </div>
        {metrics && metrics.recent.length ? (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-hairline text-left text-[12px] text-fg-muted">
                  <th className="px-4 py-2 font-medium">Website</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">Score</th>
                  <th className="px-4 py-2 font-medium">Business type</th>
                  <th className="px-4 py-2 text-right font-medium">Competitors</th>
                  <th className="px-4 py-2 text-right font-medium">Prospects</th>
                  <th className="px-4 py-2 text-right font-medium">Live steps</th>
                  <th className="px-4 py-2 font-medium">Outcome</th>
                  <th className="px-4 py-2 text-right font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {metrics.recent.map((r) => (
                  <tr key={r.id} className="border-b border-hairline last:border-b-0 hover:bg-bg-hover">
                    <td className="px-4 py-2.5">
                      <a href={`/scan/${r.id}`} target="_blank" rel="noopener noreferrer" className="font-medium text-fg hover:underline">
                        {r.domain}
                      </a>
                      {r.engine ? <div className="text-[11px] text-fg-dim">engine {r.engine}</div> : null}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={r.status === "failed" ? "text-status-warm" : r.status === "done" ? "text-fg" : "text-accent"}>{STATUS_WORDS[r.status] ?? r.status}</span>
                      {r.errorCode ? <div className="text-[11px] text-fg-dim">{ERROR_WORDS[r.errorCode] ?? r.errorCode.replace(/_/g, " ")}</div> : null}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-fg">{r.score ?? "—"}</td>
                    <td className="px-4 py-2.5 text-fg-muted">{r.category ?? "—"}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-fg-muted">{r.enrichedAt ? r.competitors : "—"}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-fg-muted">{r.enrichedAt ? r.prospects : "—"}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-fg-muted">{r.steps ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      {r.engagementId ? (
                        <Link href={`/ai-audits/${r.engagementId}`} className="text-accent hover:underline">
                          Audit opened
                        </Link>
                      ) : r.leadRecordId ? (
                        <Link href={`/pipeline/${r.leadRecordId}`} className="text-accent hover:underline">
                          Sent to the team
                        </Link>
                      ) : (
                        <span className="text-fg-dim">Not sent</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-fg-muted">{when(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-4 pb-4 pt-2 text-sm text-fg-muted">{metrics ? "No scans yet. Run one from the scan page to see it here." : "The scans could not be read just now. Reload the page; the error was logged."}</p>
        )}
      </section>
    </PageFrame>
  );
}
