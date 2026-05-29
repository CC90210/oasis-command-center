/**
 * MyActiveDealsCard — top-of-dashboard widget surfacing the records
 * assigned to the signed-in employee.
 *
 * Phase 3 of the SunBiz multi-employee personalization plan
 * (2026-05-29). Renders the leads and applications where
 * tenant_records.data.assigned_to = the operator's auth_user_id. The
 * field is soft-ownership — anyone in the tenant can still act on
 * these records; this widget just promotes them in the operator's
 * personal hierarchy.
 *
 * Data source: getMyAssignedRecords() — direct read of tenant_records
 * filtered by (tenant_id, data->>'assigned_to'). The partial index
 * from migration 077 (SunBiz-Agent) makes this O(log n).
 *
 * Empty state: shows a soft prompt explaining the assignment model so
 * a fresh employee doesn't think the dashboard is broken when they
 * have nothing yet.
 *
 * Sizing: deliberately compact (5 cards max). The full pipeline view
 * with all tenant deals still renders below.
 */

import Link from "next/link";
import { ArrowUpRight, Briefcase, Inbox } from "lucide-react";
import type { MyAssignedRecord } from "@/lib/queries/merchant-summary";

const STAGE_TONE: Record<string, string> = {
  "Application In":
    "bg-amber-500/15 text-amber-300 border-amber-500/30",
  "Missing Info":
    "bg-rose-500/15 text-rose-300 border-rose-500/30",
  Shopping: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  Approved: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  Declined: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
  Funded: "bg-emerald-500/20 text-emerald-200 border-emerald-500/40",
  Dead: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
};

function formatMoney(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toLocaleString("en-US")}`;
}

function ageDays(updatedAt: string | null): string {
  if (!updatedAt) return "—";
  const ms = Date.now() - new Date(updatedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const d = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (d === 0) return "today";
  if (d === 1) return "1d";
  if (d < 30) return `${d}d`;
  return `${Math.floor(d / 30)}mo`;
}

export function MyActiveDealsCard({
  records,
  displayName,
}: {
  records: MyAssignedRecord[];
  displayName: string | null;
}) {
  const visible = records.slice(0, 5);
  const overflow = Math.max(0, records.length - visible.length);

  return (
    <section className="rounded-2xl border border-amber-300/25 bg-[linear-gradient(135deg,rgba(251,191,36,0.08),rgba(15,23,42,0.6))] p-5 shadow-[0_18px_60px_-32px_rgba(251,191,36,0.45)]">
      <header className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="rounded-full border border-amber-300/30 bg-amber-300/10 p-1.5 text-amber-200">
            <Briefcase className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-amber-100">
              {displayName ? `${displayName}'s active deals` : "My active deals"}
            </h2>
            <p className="text-[12px] text-fg-muted">
              Deals assigned to you. Anyone on the team can still act on these — this is just where they show up first for you.
            </p>
          </div>
        </div>
        {records.length > 0 && (
          <Link
            href="/pipeline"
            className="hidden items-center gap-1 text-[11.5px] font-medium text-amber-200 hover:text-amber-100 sm:inline-flex"
          >
            Full pipeline <ArrowUpRight className="h-3 w-3" />
          </Link>
        )}
      </header>

      {records.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {visible.map((r) => {
            const stage = r.deal_stage || r.stage || "—";
            const tone = STAGE_TONE[stage] || "bg-zinc-500/15 text-zinc-300 border-zinc-500/30";
            const href = r.entity_type === "application"
              ? `/applications/${r.id}`
              : `/leads/${r.id}`;
            return (
              <li
                key={r.id}
                className="rounded-xl border border-bg-border bg-bg-elev/40 p-3 transition-colors hover:border-amber-300/35"
              >
                <Link href={href} className="block space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <span className="line-clamp-2 text-[13px] font-semibold text-fg">
                      {r.business_name || "(unnamed)"}
                    </span>
                    <span
                      className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${tone}`}
                    >
                      {stage}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11.5px] text-fg-muted">
                    <span className="font-mono">
                      {formatMoney(r.amount_requested ?? r.monthly_revenue)}
                    </span>
                    <span>{ageDays(r.updated_at)}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {overflow > 0 && (
        <div className="mt-3 text-right text-[11.5px] text-amber-200/80">
          + {overflow} more assigned to you —{" "}
          <Link href="/pipeline?assigned=me" className="underline hover:text-amber-100">
            see all
          </Link>
        </div>
      )}
    </section>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-bg-border bg-bg-deep/40 p-5 text-center">
      <Inbox className="mx-auto mb-2 h-6 w-6 text-fg-dim" />
      <p className="text-[12.5px] font-semibold text-fg">No deals assigned to you yet.</p>
      <p className="mx-auto mt-1 max-w-md text-[11.5px] text-fg-muted leading-relaxed">
        Ezra (or any admin) can assign deals to you from the lead drawer. You can also self-assign a deal you're actively working on — the &ldquo;Assign to&rdquo; dropdown is at the bottom of every lead.
      </p>
    </div>
  );
}
