/**
 * SunBizPipelineView — grouped-by-stage list view for /t/sun/leads and
 * /t/sun/applications. Replaces the prior <StageRail> + flat table
 * combo with the layout from CC's mockups: counter strip, toolbar,
 * touch-first banner, color-striped stage sections, wide horizontally-
 * scrollable table.
 *
 * Server component. Row click sets `?lead=<id>` (or `?application=<id>`)
 * which the catch-all page already handles by mounting
 * `<LeadDetailDrawer>`.
 *
 * SunBiz-only. Other tenants keep the existing rail + table path.
 */

import Link from "next/link";
import { Plus } from "lucide-react";
import type { StageMeta } from "@/lib/sunbiz-stage-meta";
import { PageSearchBar } from "@/components/manifest/PageSearchBar";
import { pipelineRowHref } from "@/lib/pipeline-display";
import { formatMoney, relTime, nonEmptyString, initialsOf } from "@/lib/format-helpers";
import {
  STAGE_SLA_DAYS,
  ACTIVE_STAGES,
  READY_TO_ADVANCE_STAGES,
  daysSince,
  isGoingCold,
  slaDaysFor,
} from "@/lib/sunbiz-sla";

type Row = { id: string; data: Record<string, unknown>; updated_at?: string; created_at?: string };

type Props = {
  slug: string;
  entityName: "lead" | "application";
  entityLabel: string;
  stages: StageMeta[];
  stageField: string;
  rows: Row[];
  /** Stage key when URL ?stage= filtering is active; null = show all. */
  stageFilter: string | null;
  /** Free-text search query from ?q=. */
  query: string | null;
  /** Base path for record-detail href construction. */
  basePath: string;
};

export function SunBizPipelineView({
  slug,
  entityName,
  entityLabel,
  stages,
  stageField,
  rows,
  stageFilter,
  query,
  basePath,
}: Props) {
  // Counter strip computation — all derived from the rendered set so
  // the operator can trust the math.
  const stageCounts: Record<string, number> = {};
  let active = 0;
  let hot = 0;
  let cold = 0;
  let ready = 0;
  let mostRecentUpdate = 0;
  for (const r of rows) {
    const s = String((r.data as Record<string, unknown>)[stageField] || "");
    stageCounts[s] = (stageCounts[s] || 0) + 1;
    if (ACTIVE_STAGES.has(s)) active++;
    if (s === "hot_lead") hot++;
    if (READY_TO_ADVANCE_STAGES.has(s)) ready++;
    const lastTouch =
      (r.data as Record<string, unknown>).last_touch_at ||
      r.updated_at ||
      r.created_at;
    if (typeof lastTouch === "string" && isGoingCold(s, lastTouch)) cold++;
    const t = r.updated_at ? new Date(r.updated_at).getTime() : 0;
    if (t > mostRecentUpdate) mostRecentUpdate = t;
  }

  // Stage sections: respect the URL filter; show every stage that has
  // rows otherwise. Stages with zero rows collapse out.
  const visibleStages = stageFilter
    ? stages.filter((s) => s.key === stageFilter)
    : stages.filter((s) => (stageCounts[s.key] || 0) > 0);

  // Touch-first banner candidate: highest-revenue going-cold row.
  const touchFirst = pickTouchFirst(rows, stageField);

  const isLeads = entityName === "lead";
  const titleText = isLeads ? "Lead Pipeline" : "Opportunity Pipeline";
  const newHref = `/t/${slug}/${basePath.split("/").pop() || ""}/new`;

  return (
    <div className="space-y-4">
      {/* ── A. Header strip ───────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-fg inline-flex items-center gap-2.5">
            {titleText}
            <span className="inline-flex items-center gap-1 text-[10.5px] uppercase tracking-wider text-emerald-300 font-semibold">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Live
            </span>
          </h1>
          <div className="text-[12px] text-fg-muted mt-1.5">
            <span className="text-fg font-semibold">{active}</span> active
            <span className="mx-1.5 text-fg-dim">·</span>
            <span className="text-amber-300 font-semibold">{hot}</span> hot
            <span className="mx-1.5 text-fg-dim">·</span>
            <span className={cold > 0 ? "text-red-300 font-semibold" : "text-fg-muted"}>
              {cold}
            </span>{" "}
            going cold
            <span className="mx-1.5 text-fg-dim">·</span>
            <span className="text-emerald-300 font-semibold">{ready}</span> ready to advance
          </div>
        </div>
        <Link
          href={newHref}
          className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider px-3 py-1.5 rounded-md bg-accent text-bg-deep font-semibold hover:bg-accent-bright"
        >
          <Plus className="w-3.5 h-3.5" />
          New {isLeads ? "merchant" : "application"}
        </Link>
      </div>

      {/* ── B. Toolbar row — search + grouping indicator ─────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-[280px]">
          <PageSearchBar entityLabel={entityLabel} />
        </div>
        <div className="text-[10.5px] text-fg-dim whitespace-nowrap">
          Grouped by stage · {visibleStages.length} active
        </div>
        <div className="text-[10.5px] text-fg-dim font-mono whitespace-nowrap">
          updated{" "}
          {mostRecentUpdate > 0
            ? relTime(new Date(mostRecentUpdate).toISOString())
            : "—"}
        </div>
      </div>

      {/* ── C. Touch-first banner ─────────────────────────────────── */}
      {touchFirst && (
        <Link
          href={`?lead=${touchFirst.id}`}
          className="block rounded-lg border border-amber-300/30 bg-amber-300/10 px-4 py-2.5 hover:bg-amber-300/15 transition-colors"
        >
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[10px] uppercase tracking-wider font-bold text-amber-300 bg-amber-300/15 px-1.5 py-0.5 rounded">
              Touch first
            </span>
            <span className="text-[13px] text-fg font-medium">
              {String(touchFirst.data.business_name || touchFirst.data.contact_name || "Untitled")},
            </span>
            <span className="text-[12px] text-amber-200/90">
              overdue {Math.round(touchFirst.daysOverdue)}d in {touchFirst.stageLabel}
            </span>
            {touchFirst.potentialUsd != null && (
              <span className="text-[12px] text-amber-200/90">
                · {formatMoney(touchFirst.potentialUsd)} potential
              </span>
            )}
            <span className="ml-auto text-[11px] text-accent">Open drawer →</span>
          </div>
        </Link>
      )}

      {/* ── D. Empty state ────────────────────────────────────────── */}
      {rows.length === 0 && (
        <div className="rounded-2xl border border-bg-border bg-bg-deep/30 p-8 text-center text-sm text-fg-dim italic">
          {query
            ? `No ${entityLabel.toLowerCase()}s match "${query}".`
            : `No ${entityLabel.toLowerCase()}s yet. Import a CSV or create a new one.`}
        </div>
      )}

      {/* ── E. Grouped sections ───────────────────────────────────── */}
      {visibleStages.map((stage) => {
        const stageRows = rows.filter(
          (r) => String((r.data as Record<string, unknown>)[stageField] || "") === stage.key,
        );
        if (stageRows.length === 0) return null;
        return (
          <StageSection
            key={stage.key}
            slug={slug}
            entityName={entityName}
            stage={stage}
            rows={stageRows}
            isLeads={isLeads}
          />
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Stage section — header + wide table                                         */
/* -------------------------------------------------------------------------- */

function StageSection({
  slug,
  entityName,
  stage,
  rows,
  isLeads,
}: {
  slug: string;
  entityName: "lead" | "application";
  stage: StageMeta;
  rows: Row[];
  isLeads: boolean;
}) {
  const sla = slaDaysFor(stage.key);
  return (
    <section
      className="rounded-lg overflow-hidden border border-bg-border bg-bg-deep/30"
      style={{ borderLeftWidth: 4, borderLeftColor: stage.bg }}
    >
      {/* Section header */}
      <div
        className="flex items-center justify-between gap-3 px-4 py-2.5"
        style={{ background: `${stage.bg}1A` /* 10% alpha */ }}
      >
        <div className="flex items-center gap-2.5">
          <span
            className="text-[11px] uppercase tracking-wider font-bold"
            style={{ color: stage.bg }}
          >
            {stage.label}
          </span>
          <span className="text-[11px] text-fg-dim font-mono">{rows.length}</span>
        </div>
        {sla < 999 && (
          <span className="text-[9.5px] uppercase tracking-wider font-bold text-fg-dim bg-bg-deep/60 px-1.5 py-0.5 rounded">
            SLA {sla}D
          </span>
        )}
      </div>

      {/* Wide table */}
      <div className="overflow-x-auto">
        <table className="w-full text-[12px] min-w-[1100px]">
          <thead>
            <tr className="text-left text-fg-dim border-b border-bg-border bg-bg-deep/40">
              <Th sticky="left-0">{isLeads ? "Merchant" : "Application"}</Th>
              <Th>Owner</Th>
              <Th>Phone</Th>
              <Th>S</Th>
              <Th>Submit</Th>
              <Th>Day</Th>
              <Th>Agent</Th>
              <Th>Last touch</Th>
              <Th>Stage</Th>
              <Th>Pa</Th>
              <Th>Leve</Th>
              <Th className="text-right">Rev/Mo</Th>
              <Th>M</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row
                key={r.id}
                slug={slug}
                entityName={entityName}
                row={r}
                stage={stage}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Th({
  children,
  sticky,
  className = "",
}: {
  children: React.ReactNode;
  sticky?: string;
  className?: string;
}) {
  return (
    <th
      className={`px-3 py-2 font-medium text-[10.5px] uppercase tracking-wider whitespace-nowrap ${
        sticky ? `sticky ${sticky} bg-bg-deep/95 z-10` : ""
      } ${className}`}
    >
      {children}
    </th>
  );
}

function Row({
  slug,
  entityName,
  row,
  stage,
}: {
  slug: string;
  entityName: "lead" | "application";
  row: Row;
  stage: StageMeta;
}) {
  const d = row.data as Record<string, unknown>;
  const businessName = str(d.business_name) || str(d.name) || `Untitled ${row.id.slice(0, 6)}`;
  const legalName = str(d.legal_name) || businessName;
  const subtitle = `Legal: ${legalName}`;
  const ownerName = str(d.contact_name) || str(d.owner_name) || "—";
  const phone = str(d.phone) || str(d.contact_phone) || "—";
  const state = str(d.state) || str(d.business_state) || "—";
  const submitIso = str(d.submitted_at) || row.created_at || null;
  const submitDate = submitIso
    ? new Date(submitIso).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "—";
  const dayPill = submitIso ? `${Math.max(0, Math.round(daysSince(submitIso)))}d` : "—";
  const agent = str(d.assigned_to_name) || str(d.assigned_to) || "—";
  const lastTouchIso = str(d.last_touch_at) || row.updated_at || row.created_at || null;
  const cold = isGoingCold(stage.key, lastTouchIso);
  const lastTouchLabel = lastTouchIso ? relTime(lastTouchIso) : "—";
  const paper = str(d.paper_grade) || str(d.leverage_grade) || "—";
  const leverage = d.leverage != null ? String(d.leverage) : str(d.leverage_ratio) || "—";
  const monthlyRev = d.monthly_revenue ?? d.avg_monthly_revenue ?? null;
  const months = str(d.time_in_business) || str(d.months_in_business) || "—";

  const href = pipelineRowHref(slug, entityName, row.id);
  const rowHover = "hover:bg-bg-elev/40 transition-colors";

  return (
    <tr className={`border-b border-bg-border/40 last:border-b-0 ${rowHover}`}>
      <td className="px-3 py-2.5 sticky left-0 bg-bg-deep/40 min-w-[220px]">
        <Link href={href} className="flex items-center gap-2.5 group">
          <span className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md bg-bg-elev border border-bg-border text-[10px] font-bold text-fg-muted uppercase">
            {initials(businessName)}
          </span>
          <span className="min-w-0">
            <span className="block text-fg font-medium truncate group-hover:underline">
              {businessName}
            </span>
            <span className="block text-[10.5px] text-fg-dim truncate">{subtitle}</span>
          </span>
        </Link>
      </td>
      <td className="px-3 py-2.5 text-fg-muted whitespace-nowrap">{ownerName}</td>
      <td className="px-3 py-2.5 text-fg-muted whitespace-nowrap font-mono text-[11px]">{phone}</td>
      <td className="px-3 py-2.5 text-fg-muted">{state}</td>
      <td className="px-3 py-2.5 text-fg-muted whitespace-nowrap">{submitDate}</td>
      <td className="px-3 py-2.5">
        <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-mono bg-bg-elev text-fg-muted">
          {dayPill}
        </span>
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        {agent !== "—" ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent/20 text-accent text-[9.5px] font-bold uppercase">
              {initials(agent).slice(0, 2)}
            </span>
            <span className="text-fg-muted">{agent}</span>
          </span>
        ) : (
          <span className="text-fg-dim">—</span>
        )}
      </td>
      <td
        className={`px-3 py-2.5 whitespace-nowrap ${
          cold ? "text-red-300 font-semibold" : "text-fg-muted"
        }`}
      >
        {lastTouchLabel}
      </td>
      <td className="px-3 py-2.5">
        <span
          className="inline-block px-2 py-0.5 rounded text-[10.5px] font-semibold whitespace-nowrap"
          style={{ background: stage.bg, color: stage.fg }}
        >
          {stage.label}
        </span>
      </td>
      <td className="px-3 py-2.5 text-fg-muted font-mono text-[11px]">{paper}</td>
      <td className="px-3 py-2.5 text-fg-muted font-mono text-[11px]">{leverage}</td>
      <td className="px-3 py-2.5 text-right text-fg whitespace-nowrap font-medium">
        {monthlyRev != null ? formatMoney(monthlyRev) : "—"}
      </td>
      <td className="px-3 py-2.5 text-fg-muted font-mono text-[11px]">{months}</td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers — small re-exports of shared format helpers under the names this    */
/* file already uses, so the substitution stays a one-line swap.               */
/* -------------------------------------------------------------------------- */

const str = nonEmptyString;
const initials = initialsOf;

type TouchFirst = {
  id: string;
  data: Record<string, unknown>;
  stageLabel: string;
  daysOverdue: number;
  potentialUsd: number | null;
};

function pickTouchFirst(rows: Row[], stageField: string): TouchFirst | null {
  let best: TouchFirst | null = null;
  for (const r of rows) {
    const data = r.data as Record<string, unknown>;
    const stage = String(data[stageField] || "");
    if (!ACTIVE_STAGES.has(stage)) continue;
    const lastTouch =
      (data.last_touch_at as string) || r.updated_at || r.created_at || null;
    if (!isGoingCold(stage, lastTouch)) continue;
    const days = daysSince(lastTouch) - (STAGE_SLA_DAYS[stage] ?? 7);
    const potential =
      typeof data.requested_amount === "number"
        ? data.requested_amount
        : typeof data.best_offer === "number"
          ? data.best_offer
          : null;
    if (!best || (potential ?? 0) > (best.potentialUsd ?? 0)) {
      best = {
        id: r.id,
        data,
        stageLabel: stage.replace(/_/g, " "),
        daysOverdue: days,
        potentialUsd: potential,
      };
    }
  }
  return best;
}
