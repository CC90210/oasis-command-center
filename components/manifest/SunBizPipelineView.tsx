"use client";

import Link from "next/link";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import type { StageMeta } from "@/lib/sunbiz-stage-meta";
import { PageSearchBar } from "@/components/manifest/PageSearchBar";
import { pipelineRowHref } from "@/lib/pipeline-display";
import {
  formatMoney,
  initialsOf,
  nonEmptyString,
  relTime,
} from "@/lib/format-helpers";
import {
  ACTIVE_STAGES,
  READY_TO_ADVANCE_STAGES,
  STAGE_SLA_DAYS,
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
  stageFilter: string | null;
  query: string | null;
  basePath: string;
};

const GRID_STYLE: CSSProperties = {
  gridTemplateColumns:
    "minmax(150px,1.6fr) minmax(92px,.9fr) minmax(78px,.7fr) 30px 56px 38px minmax(104px,1fr) 68px 112px 34px 42px 76px 58px",
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
  const [collapsedStages, setCollapsedStages] = useState<Record<string, boolean>>({});
  const isLeads = entityName === "lead";
  const titleText = isLeads ? "Lead Pipeline" : "Opportunity Pipeline";
  const newHref = `/t/${slug}/${basePath.split("/").pop() || ""}/new`;

  const stats = useMemo(() => {
    const stageCounts: Record<string, number> = {};
    let active = 0;
    let hot = 0;
    let cold = 0;
    let ready = 0;
    let mostRecentUpdate = 0;

    for (const r of rows) {
      const s = String(r.data[stageField] || "");
      stageCounts[s] = (stageCounts[s] || 0) + 1;
      if (ACTIVE_STAGES.has(s)) active++;
      if (s === "hot_lead") hot++;
      if (READY_TO_ADVANCE_STAGES.has(s)) ready++;

      const lastTouch = r.data.last_touch_at || r.updated_at || r.created_at;
      if (typeof lastTouch === "string" && isGoingCold(s, lastTouch)) cold++;

      const t = r.updated_at ? new Date(r.updated_at).getTime() : 0;
      if (t > mostRecentUpdate) mostRecentUpdate = t;
    }

    return { stageCounts, active, hot, cold, ready, mostRecentUpdate };
  }, [rows, stageField]);

  const renderedRows = stageFilter
    ? rows.filter((r) => String(r.data[stageField] || "") === stageFilter)
    : rows;
  const visibleStages = stageFilter
    ? stages.filter((s) => s.key === stageFilter)
    : stages;
  const touchFirst = pickTouchFirst(renderedRows, stageField, stages);

  function toggleStage(stageKey: string, defaultCollapsed = false) {
    setCollapsedStages((current) => ({
      ...current,
      [stageKey]: !(current[stageKey] ?? defaultCollapsed),
    }));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="inline-flex items-center gap-2.5 text-2xl font-bold text-fg">
            {titleText}
            <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wider text-emerald-300">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              Live
            </span>
          </h1>
          <div className="mt-1.5 text-[12px] text-fg-muted">
            <span className="font-semibold text-fg">{stats.active}</span> active
            <span className="mx-1.5 text-fg-dim">/</span>
            <span className="font-semibold text-amber-300">{stats.hot}</span> hot
            <span className="mx-1.5 text-fg-dim">/</span>
            <span className={stats.cold > 0 ? "font-semibold text-red-300" : "text-fg-muted"}>
              {stats.cold}
            </span>{" "}
            going cold
            <span className="mx-1.5 text-fg-dim">/</span>
            <span className="font-semibold text-emerald-300">{stats.ready}</span> ready to advance
          </div>
        </div>
        <Link
          href={newHref}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-bg-deep hover:bg-accent/90"
        >
          <Plus className="h-3.5 w-3.5" />
          New {entityLabel.toLowerCase()}
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[260px] flex-1">
          <PageSearchBar entityLabel={entityLabel} />
        </div>
        <div className="whitespace-nowrap text-[10.5px] text-fg-dim">
          {stages.length} stages / {renderedRows.length} visible
        </div>
        <div className="whitespace-nowrap font-mono text-[10.5px] text-fg-dim">
          updated{" "}
          {stats.mostRecentUpdate > 0
            ? relTime(new Date(stats.mostRecentUpdate).toISOString())
            : "-"}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {stages.map((stage) => {
          const count = stats.stageCounts[stage.key] || 0;
          const collapsed = collapsedStages[stage.key] ?? (count === 0);
          const selected = stageFilter === stage.key;
          return (
            <button
              key={stage.key}
              type="button"
              onClick={() => toggleStage(stage.key, count === 0)}
              className={`min-w-0 rounded-md border px-3 py-2 text-left transition-colors ${
                selected
                  ? "border-accent bg-accent/10"
                  : "border-bg-border bg-bg-deep/45 hover:border-fg-dim hover:bg-bg-elev/40"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: stage.bg }} />
                <span className="min-w-0 flex-1 truncate text-[11px] font-bold uppercase tracking-wide text-fg-muted">
                  {stage.label}
                </span>
                {collapsed ? (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-dim" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-dim" />
                )}
              </div>
              <div className="mt-1 font-mono text-[12px] text-fg">{count}</div>
            </button>
          );
        })}
      </div>

      {touchFirst && (
        <Link
          href={`?${entityName === "application" ? "application" : "lead"}=${touchFirst.id}`}
          className="block rounded-lg border border-amber-300/30 bg-amber-300/10 px-4 py-2.5 transition-colors hover:bg-amber-300/15"
        >
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded bg-amber-300/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">
              Touch first
            </span>
            <span className="text-[13px] font-medium text-fg">{touchFirst.name}</span>
            <span className="text-[12px] text-amber-200/90">
              overdue {Math.max(0, Math.round(touchFirst.daysOverdue))}d in {touchFirst.stageLabel}
            </span>
            {touchFirst.potentialUsd != null && (
              <span className="text-[12px] text-amber-200/90">
                / {formatMoney(touchFirst.potentialUsd)} potential
              </span>
            )}
            <span className="ml-auto text-[11px] text-accent">Open</span>
          </div>
        </Link>
      )}

      {renderedRows.length === 0 && (
        <div className="rounded-lg border border-bg-border bg-bg-deep/30 p-6 text-center text-sm italic text-fg-dim">
          {query
            ? `No ${entityLabel.toLowerCase()}s match "${query}".`
            : `No ${entityLabel.toLowerCase()}s yet.`}
        </div>
      )}

      {visibleStages.map((stage) => {
        const stageRows = renderedRows.filter((r) => String(r.data[stageField] || "") === stage.key);
        return (
          <StageSection
            key={stage.key}
            slug={slug}
            entityName={entityName}
            stage={stage}
            rows={stageRows}
            collapsed={collapsedStages[stage.key] ?? (stageRows.length === 0)}
            onToggle={() => toggleStage(stage.key, stageRows.length === 0)}
          />
        );
      })}
    </div>
  );
}

function StageSection({
  slug,
  entityName,
  stage,
  rows,
  collapsed,
  onToggle,
}: {
  slug: string;
  entityName: "lead" | "application";
  stage: StageMeta;
  rows: Row[];
  collapsed: boolean;
  onToggle: () => void;
}) {
  const sla = slaDaysFor(stage.key);
  return (
    <section
      className="overflow-hidden rounded-lg border border-bg-border bg-bg-deep/30"
      style={{ borderLeftWidth: 4, borderLeftColor: stage.bg }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left"
        style={{ background: `${stage.bg}1A` }}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-dim" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-dim" />
          )}
          <span className="truncate text-[11px] font-bold uppercase tracking-wider" style={{ color: stage.bg }}>
            {stage.label}
          </span>
          <span className="font-mono text-[11px] text-fg-dim">{rows.length}</span>
        </div>
        {sla < 999 && (
          <span className="shrink-0 rounded bg-bg-deep/60 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wider text-fg-dim">
            SLA {sla}D
          </span>
        )}
      </button>

      {!collapsed && rows.length === 0 && (
        <div className="px-4 py-5 text-center text-xs text-fg-dim">No records</div>
      )}

      {!collapsed && rows.length > 0 && (
        <>
          <div className="hidden lg:block">
            <div
              className="grid border-b border-bg-border bg-bg-deep/55 text-left text-[10px] uppercase tracking-wider text-fg-dim"
              style={GRID_STYLE}
            >
              <HeaderCell>Merchant</HeaderCell>
              <HeaderCell>Owner</HeaderCell>
              <HeaderCell>Phone</HeaderCell>
              <HeaderCell>S</HeaderCell>
              <HeaderCell>Submit</HeaderCell>
              <HeaderCell>Day</HeaderCell>
              <HeaderCell>Agent</HeaderCell>
              <HeaderCell>Last Touch</HeaderCell>
              <HeaderCell>Stage</HeaderCell>
              <HeaderCell>PA</HeaderCell>
              <HeaderCell>Level</HeaderCell>
              <HeaderCell align="right">M Rev/Month</HeaderCell>
              <HeaderCell>Years</HeaderCell>
            </div>
            {rows.map((r) => (
              <DesktopRow key={r.id} slug={slug} entityName={entityName} row={r} stage={stage} />
            ))}
          </div>

          <div className="divide-y divide-bg-border/50 lg:hidden">
            {rows.map((r) => (
              <MobileRow key={r.id} slug={slug} entityName={entityName} row={r} stage={stage} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function DesktopRow({
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
  const model = rowModel(row, stage);
  const href = pipelineRowHref(slug, entityName, row.id);
  return (
    <Link
      href={href}
      className="grid border-b border-bg-border/40 text-[11px] transition-colors last:border-b-0 hover:bg-bg-elev/40"
      style={GRID_STYLE}
    >
      <Cell>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-bg-border bg-bg-elev text-[10px] font-bold uppercase text-fg-muted">
            {initialsOf(model.businessName)}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-semibold text-fg" title={model.businessName}>
              {model.businessName}
            </span>
            <span className="block truncate text-[10px] text-fg-dim" title={model.subtitle}>
              {model.subtitle}
            </span>
          </span>
        </div>
      </Cell>
      <Cell title={model.ownerName}>{model.ownerName}</Cell>
      <Cell title={model.phone} mono>{model.phone}</Cell>
      <Cell>{model.state}</Cell>
      <Cell>{model.submitDate}</Cell>
      <Cell>
        <span className="rounded bg-bg-elev px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">
          {model.dayPill}
        </span>
      </Cell>
      <Cell title={model.agentFull}>
        {model.agentLabel !== "-" ? (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/20 text-[9px] font-bold uppercase text-accent">
              {initialsOf(model.agentLabel).slice(0, 2)}
            </span>
            <span className="min-w-0 truncate">{model.agentLabel}</span>
          </span>
        ) : (
          "-"
        )}
      </Cell>
      <Cell className={model.cold ? "font-semibold text-red-300" : ""}>{model.lastTouchLabel}</Cell>
      <Cell>
        <StageChip stage={stage} />
      </Cell>
      <Cell mono>{model.paper}</Cell>
      <Cell mono>{model.leverage}</Cell>
      <Cell align="right" className="font-semibold text-fg">
        {model.monthlyRev}
      </Cell>
      <Cell mono>{model.years}</Cell>
    </Link>
  );
}

function MobileRow({
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
  const model = rowModel(row, stage);
  const href = pipelineRowHref(slug, entityName, row.id);
  return (
    <Link href={href} className="block px-4 py-3 transition-colors hover:bg-bg-elev/40">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-bg-border bg-bg-elev text-[10px] font-bold uppercase text-fg-muted">
          {initialsOf(model.businessName)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-fg">{model.businessName}</div>
              <div className="truncate text-[11px] text-fg-dim">{model.ownerName}</div>
            </div>
            <StageChip stage={stage} />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-fg-muted">
            <MiniMetric label="Phone" value={model.phone} mono />
            <MiniMetric label="Submit" value={model.submitDate} />
            <MiniMetric label="Agent" value={model.agentLabel} />
            <MiniMetric label="Last" value={model.lastTouchLabel} />
            <MiniMetric label="M Rev" value={model.monthlyRev} />
            <MiniMetric label="Years" value={model.years} mono />
          </div>
        </div>
      </div>
    </Link>
  );
}

function HeaderCell({
  children,
  align = "left",
}: {
  children: ReactNode;
  align?: "left" | "right";
}) {
  return (
    <div className={`min-w-0 px-2 py-2 font-bold ${align === "right" ? "text-right" : ""}`}>
      {children}
    </div>
  );
}

function Cell({
  children,
  align = "left",
  mono = false,
  title,
  className = "",
}: {
  children: ReactNode;
  align?: "left" | "right";
  mono?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <div
      className={`min-w-0 overflow-hidden truncate px-2 py-2.5 text-fg-muted ${
        align === "right" ? "text-right" : ""
      } ${mono ? "font-mono" : ""} ${className}`}
      title={title}
    >
      {children}
    </div>
  );
}

function StageChip({ stage }: { stage: StageMeta }) {
  return (
    <span
      className="inline-block max-w-full truncate rounded px-2 py-0.5 text-[10px] font-semibold"
      style={{ background: stage.bg, color: stage.fg }}
      title={stage.label}
    >
      {stage.label}
    </span>
  );
}

function MiniMetric({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] font-bold uppercase tracking-wider text-fg-dim">{label}</div>
      <div className={`truncate ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

function rowModel(row: Row, stage: StageMeta) {
  const d = row.data;
  const businessName = str(d.business_name) || str(d.name) || `Untitled ${row.id.slice(0, 6)}`;
  const legalName = str(d.legal_name) || str(d.dba) || businessName;
  const subtitle = legalName === businessName ? `Legal: ${businessName}` : `Legal: ${legalName}`;
  const ownerName = str(d.contact_name) || str(d.owner_name) || "-";
  const phone = formatPhone(str(d.phone) || str(d.contact_phone) || "");
  const state = str(d.state) || str(d.business_state) || "-";
  const submitIso = str(d.submitted_at) || str(d.date_submitted) || row.created_at || null;
  const submitDate = submitIso ? formatShortDate(submitIso) : "-";
  const dayPill = submitIso ? `${Math.max(0, Math.round(daysSince(submitIso)))}d` : "-";
  const agentFull = str(d.assigned_to_name) || str(d.assigned_to) || "-";
  const agentLabel = compactAgent(agentFull);
  const lastTouchIso = str(d.last_touch_at) || row.updated_at || row.created_at || null;
  const cold = isGoingCold(stage.key, lastTouchIso);
  const lastTouchLabel = lastTouchIso ? relTime(lastTouchIso) : "-";
  const paper = str(d.paper_grade) || str(d.leverage_grade) || "-";
  const leverage = d.leverage != null ? String(d.leverage) : str(d.leverage_ratio) || "-";
  const monthlyRevRaw = d.monthly_revenue ?? d.avg_monthly_revenue ?? null;
  const monthlyRev = monthlyRevRaw != null ? formatMoney(monthlyRevRaw) : "-";
  const years = formatYears(str(d.time_in_business) || str(d.months_in_business) || "");

  return {
    businessName,
    subtitle,
    ownerName,
    phone,
    state,
    submitDate,
    dayPill,
    agentFull,
    agentLabel,
    cold,
    lastTouchLabel,
    paper,
    leverage,
    monthlyRev,
    years,
  };
}

const str = nonEmptyString;

type TouchFirst = {
  id: string;
  name: string;
  stageLabel: string;
  daysOverdue: number;
  potentialUsd: number | null;
};

function pickTouchFirst(rows: Row[], stageField: string, stages: StageMeta[]): TouchFirst | null {
  let best: TouchFirst | null = null;
  for (const r of rows) {
    const stageKey = String(r.data[stageField] || "");
    if (!ACTIVE_STAGES.has(stageKey)) continue;
    const lastTouch = (r.data.last_touch_at as string) || r.updated_at || r.created_at || null;
    if (!isGoingCold(stageKey, lastTouch)) continue;
    const days = daysSince(lastTouch) - (STAGE_SLA_DAYS[stageKey] ?? 7);
    const potential =
      typeof r.data.requested_amount === "number"
        ? r.data.requested_amount
        : typeof r.data.best_offer === "number"
          ? r.data.best_offer
          : typeof r.data.monthly_revenue === "number"
            ? r.data.monthly_revenue
            : null;
    if (!best || (potential ?? 0) > (best.potentialUsd ?? 0)) {
      best = {
        id: r.id,
        name: str(r.data.business_name) || str(r.data.contact_name) || "Untitled",
        stageLabel: stages.find((s) => s.key === stageKey)?.label || stageKey.replace(/_/g, " "),
        daysOverdue: days,
        potentialUsd: potential,
      };
    }
  }
  return best;
}

function formatShortDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatPhone(value: string): string {
  const digits = value.replace(/\D+/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length === 10) {
    return `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`;
  }
  return value || "-";
}

function compactAgent(value: string): string {
  if (!value || value === "-") return "-";
  const names = value.split(",").map((v) => v.trim()).filter(Boolean);
  if (names.length <= 1) return names[0] || value;
  return `${names[0]} +${names.length - 1}`;
}

function formatYears(value: string): string {
  if (!value) return "-";
  const n = Number(value);
  if (Number.isFinite(n)) return `${n} yrs`;
  return value.replace(/\byears\b/i, "yrs");
}
