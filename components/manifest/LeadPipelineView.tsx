"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  BarChart3,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  History,
  Loader2,
  Mail,
  Plus,
  Square,
  UserPlus,
  X,
  Zap,
} from "lucide-react";
import type { StageMeta } from "@/lib/sunbiz-stage-meta";
// Shared with the /web-leads list so one hardening rule covers both surfaces:
// 217 stored websites have no scheme (a bare domain in an href navigates inside
// our own dashboard) and these values come from OpenStreetMap, which anyone can
// edit, so a `javascript:` href would run in our origin.
import { preferredSiteUrl } from "@/lib/web-leads/url-safety";
import { AcceleratedToggle } from "@/components/manifest/AcceleratedToggle";
import {
  SUNBIZ_BULK_SAFE_TEMPLATES,
  SUNBIZ_TEMPLATE_CATEGORIES,
} from "@/lib/sunbiz-templates-library";
import { PageSearchBar } from "@/components/manifest/PageSearchBar";
import { AutofillDropzone } from "@/components/leads/AutofillDropzone";
import { SendToDialerControl } from "@/components/leads/SendToDialerControl";
import { BulkEmailDialog } from "@/components/leads/BulkEmailDialog";
import { BulkSendHistory } from "@/components/leads/BulkSendHistory";
import { pipelineRowHref } from "@/lib/pipeline-display";
import { CopyButton } from "@/components/CopyButton";
import { DealHoverCard } from "@/components/manifest/DealHoverCard";
import { lastTouchIso } from "@/lib/lead-staleness";
import {
  formatMoney,
  initialsOf,
  nonEmptyString,
  relTime,
} from "@/lib/format-helpers";
import {
  ACTIVE_STAGES as SUN_ACTIVE_STAGES,
  READY_TO_ADVANCE_STAGES as SUN_READY_TO_ADVANCE_STAGES,
  STAGE_SLA_DAYS as SUN_STAGE_SLA_DAYS,
  VISIBLE_TARGET_STAGES as SUN_VISIBLE_TARGET_STAGES,
  daysSince,
  isGoingCold as isGoingColdSun,
} from "@/lib/sunbiz-sla";
import {
  OASIS_ACTIVE_STAGES,
  OASIS_READY_TO_ADVANCE_STAGES,
  OASIS_STAGE_SLA_DAYS,
  OASIS_VISIBLE_TARGET_STAGES,
} from "@/lib/oasis-sla";
import { InlineStageControl } from "@/components/manifest/InlineStageControl";
import { QuickAddLeadModal } from "@/components/manifest/QuickAddLeadModal";
import { isAcceleratedEligible } from "@/lib/drips/accelerated-eligibility";
import { isLeadListVisible } from "@/lib/lead-list-visibility";

type Row = { id: string; data: Record<string, unknown>; updated_at?: string; created_at?: string };

/** A lead on the accelerated SMS chase (data.accelerated_followup truthy). */
function isAccelerated(r: Row): boolean {
  const v = r.data.accelerated_followup;
  return v === true || v === "true";
}

/** Stable sort that floats accelerated leads to the top of a stage list without
 *  otherwise reordering (keeps the existing within-group order). */
function sortAcceleratedFirst(rowsIn: Row[]): Row[] {
  const accel: Row[] = [];
  const rest: Row[] = [];
  for (const r of rowsIn) (isAccelerated(r) ? accel : rest).push(r);
  return accel.length ? [...accel, ...rest] : rowsIn;
}

/**
 * Pipeline variant. `sunbiz` keeps the legacy 13-column funding-funnel
 * grid; `oasis` swaps in the AI-agency 6-column grid + OASIS SLA
 * constants so the same component drives both /t/sun/leads and
 * /pipeline. See lib/oasis-sla.ts for the OASIS stage windows.
 */
export type PipelineVariant = "sunbiz" | "oasis";

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
  /** Default `"sunbiz"` so every existing caller works unchanged. */
  variant?: PipelineVariant;
  /**
   * Owner/admin — unlocks the opt-in bulk "Select" mode (Batch 2.2 bulk assign /
   * Batch 6.1 bulk stage). Default false: the board renders exactly as before for
   * agents, so there is zero change to the non-manager view.
   */
  canManage?: boolean;
};

type TenantMember = {
  auth_user_id: string;
  full_name: string | null;
  display_name: string | null;
};

const SUN_GRID_STYLE: CSSProperties = {
  gridTemplateColumns:
    "minmax(150px,1.6fr) minmax(92px,.9fr) minmax(108px,.9fr) 30px 56px 38px minmax(104px,1fr) 68px 112px 34px 42px 76px 58px",
};

// Seven columns as of 2026-08-25. `Email` became `Address` and a `Website`
// column was added -- see PipelineWebsiteCell and the Lead-cell comment for the
// measurements behind both. Website is the widest new slot because it carries
// two controls plus either a number or a full sentence; the sentence is the
// point (a non-scored state must never render as a dash), and wrapping it to
// three lines would make the row heights ragged.
const OASIS_GRID_STYLE: CSSProperties = {
  gridTemplateColumns:
    "minmax(170px,1.5fr) minmax(140px,1.1fr) minmax(110px,.9fr) minmax(150px,1.1fr) 56px 100px 88px",
};

// Tenant-variant config struct picked at the top of the component.
type VariantConfig = {
  active: Set<string>;
  readyToAdvance: Set<string>;
  slaDays: Record<string, number>;
  visibleTargetStages: Set<string>;
  gridStyle: CSSProperties;
};

function variantConfig(v: PipelineVariant): VariantConfig {
  if (v === "oasis") {
    return {
      active: OASIS_ACTIVE_STAGES,
      readyToAdvance: OASIS_READY_TO_ADVANCE_STAGES,
      slaDays: OASIS_STAGE_SLA_DAYS,
      visibleTargetStages: OASIS_VISIBLE_TARGET_STAGES,
      gridStyle: OASIS_GRID_STYLE,
    };
  }
  return {
    active: SUN_ACTIVE_STAGES,
    readyToAdvance: SUN_READY_TO_ADVANCE_STAGES,
    slaDays: SUN_STAGE_SLA_DAYS,
    visibleTargetStages: SUN_VISIBLE_TARGET_STAGES,
    gridStyle: SUN_GRID_STYLE,
  };
}

function slaDaysForVariant(cfg: VariantConfig, stage: string): number {
  return cfg.slaDays[stage] ?? 7;
}

function isGoingColdVariant(
  cfg: VariantConfig,
  stage: string,
  iso: string | null | undefined,
): boolean {
  if (!cfg.active.has(stage)) return false;
  return daysSince(iso) > slaDaysForVariant(cfg, stage);
}

function stageTargetLabelVariant(cfg: VariantConfig, stage: string): string | null {
  if (!cfg.visibleTargetStages.has(stage)) return null;
  const days = slaDaysForVariant(cfg, stage);
  if (!Number.isFinite(days) || days >= 999) return null;
  return `${days}d target`;
}

// Doc-type chips for the Missing Info filter. Keys match lib/lead-doc-display.ts
// and the /api/leads/missing-docs EXPECTED_DOC_TYPES.
const MISSING_DOC_FILTERS: { key: string; label: string }[] = [
  { key: "bank_statements_3mo", label: "Bank statements" },
  { key: "drivers_license", label: "Driver's license" },
  { key: "void_cheque", label: "Void cheque" },
  { key: "proof_of_ownership", label: "Proof of ownership" },
  { key: "business_license", label: "Business license" },
  { key: "tax_returns", label: "Tax returns" },
];

export function LeadPipelineView({
  slug,
  entityName,
  entityLabel,
  stages,
  stageField,
  rows: rawRows,
  stageFilter,
  query,
  basePath,
  variant = "sunbiz",
  canManage = false,
}: Props) {
  const router = useRouter();
  const [collapsedStages, setCollapsedStages] = useState<Record<string, boolean>>({});
  const [selectMode, setSelectMode] = useState(false);
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [sendHistoryOpen, setSendHistoryOpen] = useState(false);
  // Quick-add modal (manual "add lead to Sent Application" — reps logging apps
  // they sent via TextTorrent/email; 2026-07-20).
  const [addLeadOpen, setAddLeadOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [members, setMembers] = useState<TenantMember[] | null>(null);
  const [membersState, setMembersState] = useState<"idle" | "loading" | "error">("idle");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [docFilter, setDocFilter] = useState<Set<string>>(new Set());
  const [missingByLead, setMissingByLead] = useState<Record<string, string[]>>({});
  const [missingLoaded, setMissingLoaded] = useState(false);
  const cfg = useMemo(() => variantConfig(variant), [variant]);
  const stageMap = useMemo(
    () => Object.fromEntries(stages.map((stage) => [stage.key, stage])) as Record<string, StageMeta>,
    [stages],
  );
  const isLeads = entityName === "lead";
  // Transferred leads have moved into the Applications pipeline (Adon transfer
  // reconstruction 2026-06-21). They live there now, so drop them from the Lead
  // board entirely — cards AND stage counts — leaving one card per deal. Only
  // leads carry data.transferred_at; the Applications board is untouched.
  const rows = useMemo(
    () => (entityName === "lead" ? rawRows.filter((r) => isLeadListVisible(r.data)) : rawRows),
    [rawRows, entityName],
  );
  const titleText = isLeads ? "Lead Pipeline" : "Opportunity Pipeline";
  // For OASIS the route is empire-side (/pipeline/new); for SunBiz it
  // lives under the tenant catch-all (/t/sun/leads/new).
  const newHref =
    variant === "oasis"
      ? `${basePath}/new`
      : `/t/${slug}/${basePath.split("/").pop() || ""}/new`;
  // "Hot" semantics differ per tenant. SunBiz has an explicit
  // hot_lead stage and a "hot" label that operators recognise. OASIS
  // doesn't — the closest analog is the `qualified` stage (confirmed
  // fit, ready to send proposal). Both label + key swap with the
  // variant so the counter reads naturally for either tenant.
  const hotStageKey = variant === "oasis" ? "qualified" : "hot_lead";
  const hotStageLabel = variant === "oasis" ? "qualified" : "hot";

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
      if (cfg.active.has(s)) active++;
      if (s === hotStageKey) hot++;
      if (cfg.readyToAdvance.has(s)) ready++;

      const lastTouch = lastTouchIso(r);
      // docs_on_file deals (received complete) are never "going cold" — they're ready to shop, not stranded.
      if (typeof lastTouch === "string" && r.data.docs_on_file !== true && isGoingColdVariant(cfg, s, lastTouch)) cold++;

      const t = r.updated_at ? new Date(r.updated_at).getTime() : 0;
      if (t > mostRecentUpdate) mostRecentUpdate = t;
    }

    return { stageCounts, active, hot, cold, ready, mostRecentUpdate };
  }, [rows, stageField, cfg, hotStageKey]);

  const renderedRows = stageFilter
    ? rows.filter((r) => String(r.data[stageField] || "") === stageFilter)
    : rows;
  const visibleStages = stageFilter
    ? stages.filter((s) => s.key === stageFilter)
    : stages;
  const isMissingInfoView =
    !!stageFilter && stageFilter.toLowerCase().replace(/\s+/g, "_") === "missing_info";
  const rowMissing = (r: Row): string[] =>
    missingByLead[entityName === "application" ? String(r.data.lead_id || "") : r.id] || [];
  const applyDocFilter = (rowsIn: Row[]): Row[] =>
    isMissingInfoView && docFilter.size > 0
      ? rowsIn.filter((r) => rowMissing(r).some((t) => docFilter.has(t)))
      : rowsIn;
  const touchFirst = pickTouchFirst(renderedRows, stageField, stages, cfg);

  useEffect(() => {
    setCollapsedStages({});
    setMissingByLead({});
    setMissingLoaded(false);
    setDocFilter(new Set());
  }, [entityName, basePath]);

  // Missing-Info doc filter: clear the chips whenever we leave that stage view.
  useEffect(() => {
    if (!isMissingInfoView) {
      setDocFilter(new Set());
      setMissingLoaded(false);
    }
  }, [isMissingInfoView]);

  // Lazy-load which required docs each Missing-Info deal lacks (one batched call).
  useEffect(() => {
    if (!isMissingInfoView || missingLoaded) return;
    const ids = [
      ...new Set(
        rows
          .filter(
            (r) => String(r.data[stageField] || "").toLowerCase().replace(/\s+/g, "_") === "missing_info",
          )
          .map((r) => (entityName === "application" ? String(r.data.lead_id || "") : r.id))
          .filter(Boolean),
      ),
    ];
    if (!ids.length) {
      setMissingLoaded(true);
      return;
    }
    let cancelled = false;
    fetch("/api/leads/missing-docs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_ids: ids }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        if (j?.ok) setMissingByLead(j.missing || {});
        setMissingLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setMissingLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isMissingInfoView, missingLoaded, rows, stageField, entityName]);

  // When doc chips are active, auto-select the matching deals for the bulk-send bar.
  useEffect(() => {
    if (!isMissingInfoView || docFilter.size === 0) return;
    const match = rows
      .filter((r) => {
        if (String(r.data[stageField] || "").toLowerCase().replace(/\s+/g, "_") !== "missing_info")
          return false;
        const miss =
          missingByLead[entityName === "application" ? String(r.data.lead_id || "") : r.id] || [];
        return miss.some((t) => docFilter.has(t));
      })
      .map((r) => r.id);
    setSelected(new Set(match));
    setSelectMode(match.length > 0);
  }, [docFilter, missingByLead, isMissingInfoView, rows, stageField, entityName]);

  // Bulk select (Batch 2.2 / 6.1) — opt-in, owner/admin only. Lazy-load the
  // member roster the first time the operator enters Select mode. On failure we
  // surface an explicit retry in the Assign dropdown rather than a silent empty
  // list (Codex 2026-06-19 LOW-6).
  const [membersReloadKey, setMembersReloadKey] = useState(0);
  useEffect(() => {
    if (!selectMode || members !== null) return;
    let cancelled = false;
    setMembersState("loading");
    fetch("/api/team/members", { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as { ok?: boolean; members?: TenantMember[] }) : null))
      .then((body) => {
        if (cancelled) return;
        if (body?.ok && body.members) {
          setMembers(body.members);
          setMembersState("idle");
        } else {
          setMembersState("error");
        }
      })
      .catch(() => {
        if (!cancelled) setMembersState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [selectMode, members, membersReloadKey]);
  const retryMembers = () => {
    setMembers(null);
    setMembersReloadKey((k) => k + 1);
  };

  const allRenderedIds = useMemo(() => renderedRows.map((r) => r.id), [renderedRows]);
  const allSelected = allRenderedIds.length > 0 && allRenderedIds.every((id) => selected.has(id));

  function toggleSelect(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelected((cur) => (allRenderedIds.every((id) => cur.has(id)) ? new Set() : new Set(allRenderedIds)));
  }
  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
    setBulkMsg(null);
  }

  async function runBulk(payload: Record<string, unknown>, verb: string) {
    if (selected.size === 0 || bulkBusy) return;
    setBulkBusy(true);
    setBulkMsg(null);
    try {
      const r = await fetch("/api/leads/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [...selected], ...payload }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        updated?: number;
        skipped?: number;
        failed?: number;
        error?: string;
      };
      if (!r.ok || !body.ok) {
        setBulkMsg(body.error ? `Couldn't ${verb}: ${body.error}` : `Couldn't ${verb}.`);
        return;
      }
      const bits = [`${body.updated ?? 0} ${verb}`];
      if (body.skipped) bits.push(`${body.skipped} skipped`);
      if (body.failed) bits.push(`${body.failed} failed`);
      setBulkMsg(bits.join(" · "));
      setSelected(new Set());
      router.refresh();
    } catch (e) {
      setBulkMsg(`Couldn't ${verb}: ${(e as Error).message || "network error"}`);
    } finally {
      setBulkBusy(false);
    }
  }

  function toggleStage(stageKey: string) {
    setCollapsedStages((current) => ({
      ...current,
      [stageKey]: !(current[stageKey] ?? true),
    }));
  }

  return (
    <div className="space-y-4">
      <QuickAddLeadModal open={addLeadOpen} onClose={() => setAddLeadOpen(false)} />
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
            <span className="font-semibold text-amber-300">{stats.hot}</span> {hotStageLabel}
            <span className="mx-1.5 text-fg-dim">/</span>
            <span className={stats.cold > 0 ? "font-semibold text-red-300" : "text-fg-muted"}>
              {stats.cold}
            </span>{" "}
            going cold
            <span className="mx-1.5 text-fg-dim">/</span>
            <span className="font-semibold text-emerald-300">{stats.ready}</span> ready to advance
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Recent sends lives HERE, not in the selection toolbar: the whole
              point is answering "did that batch go out?" after the fact, and
              by then the selection is cleared. Gating the receipt behind
              having something selected would defeat it. */}
          <button
            type="button"
            onClick={() => setSendHistoryOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-bg-border bg-bg-elev/40 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-muted transition-colors hover:text-fg"
            title="See every bulk email you've sent, and whether each one landed."
          >
            <History className="h-3.5 w-3.5" />
            Recent sends
          </button>
          {/* Multi-select is available to every employee. The bulk API
              (/api/leads/bulk) skips any lead a non-admin doesn't own, so a
              member can only bulk-act on their own book — safe to always show. */}
          {(variant !== "oasis" || canManage) && (
            <button
              type="button"
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
              className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
                selectMode
                  ? "border-accent bg-accent/15 text-accent"
                  : "border-bg-border bg-bg-elev/40 text-fg-muted hover:text-fg"
              }`}
              title="Select multiple to assign or move stage in one action"
            >
              {selectMode ? <X className="h-3.5 w-3.5" /> : <CheckSquare className="h-3.5 w-3.5" />}
              {selectMode ? "Done" : "Select"}
            </button>
          )}
          {(variant !== "oasis" || canManage) && <Link
            href={newHref}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-bg-deep hover:bg-accent/90"
          >
            <Plus className="h-3.5 w-3.5" />
            New {entityLabel.toLowerCase()}
          </Link>}
          {/* Drop-in autofill — drop a merchant's existing application (any
              company's PDF) to create a NEW SunBiz lead + application from it. */}
          {isLeads && (variant !== "oasis" || canManage) && (
            <AutofillDropzone mode="new" tenantSlug={slug} label="New from application" />
          )}
        </div>
      </div>

      {selectMode && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-[11px] text-fg-muted">
          <button
            type="button"
            onClick={toggleSelectAll}
            className="inline-flex items-center gap-1.5 font-semibold text-fg hover:text-accent"
          >
            {allSelected ? <CheckSquare className="h-3.5 w-3.5 text-accent" /> : <Square className="h-3.5 w-3.5" />}
            {allSelected ? "Clear all" : `Select all ${allRenderedIds.length}`}
          </button>
          <span className="text-fg-dim">·</span>
          <span className="font-semibold text-fg">{selected.size}</span> selected
          {bulkMsg && <span className="ml-auto text-accent">{bulkMsg}</span>}
        </div>
      )}

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
          const collapsed = collapsedStages[stage.key] ?? true;
          const selected = stageFilter === stage.key;
          return (
            <button
              key={stage.key}
              type="button"
              onClick={() => toggleStage(stage.key)}
              className={`min-h-[56px] min-w-0 rounded-md border px-3 py-2 text-left transition-colors ${
                selected
                  ? "border-accent bg-accent/10"
                  : "border-bg-border bg-bg-deep/45 hover:border-fg-dim hover:bg-bg-elev/40"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: stage.bg }} />
                <span className="min-w-0 flex-1 text-[11px] font-bold uppercase leading-tight tracking-wide text-fg-muted">
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

      {isMissingInfoView && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-bg-border bg-bg-deep/40 px-3 py-2">
          <span className="text-[10px] font-bold uppercase tracking-wide text-fg-dim">Missing:</span>
          {MISSING_DOC_FILTERS.map((dt) => {
            const on = docFilter.has(dt.key);
            const n = renderedRows.filter((r) => rowMissing(r).includes(dt.key)).length;
            return (
              <button
                key={dt.key}
                type="button"
                onClick={() =>
                  setDocFilter((prev) => {
                    const nx = new Set(prev);
                    if (nx.has(dt.key)) nx.delete(dt.key);
                    else nx.add(dt.key);
                    return nx;
                  })
                }
                className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                  on
                    ? "border-accent bg-accent/15 text-accent"
                    : "border-bg-border bg-bg-elev/40 text-fg-muted hover:border-fg-dim"
                }`}
              >
                {dt.label}
                {missingLoaded ? ` (${n})` : ""}
              </button>
            );
          })}
          {docFilter.size > 0 && (
            <button
              type="button"
              onClick={() => setDocFilter(new Set())}
              className="ml-1 text-[10px] text-fg-dim hover:text-fg"
            >
              clear
            </button>
          )}
          {!missingLoaded && <Loader2 className="h-3 w-3 animate-spin text-fg-dim" />}
        </div>
      )}

      {touchFirst && (
        <Link
          // OASIS lead detail lives at /pipeline/<id> (not a query-param
          // drawer); SunBiz uses ?lead=<id> for its in-page drawer. The
          // prior shape used the SunBiz pattern for both tenants, so
          // clicking "Open" on the OASIS Touch-first callout silently
          // appended ?lead=<id> to the URL and did nothing (no drawer
          // on this page).
          href={
            variant === "oasis"
              ? `${basePath}/${touchFirst.id}`
              : `?${entityName === "application" ? "application" : "lead"}=${touchFirst.id}`
          }
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

      {/* Accelerated leads no longer live in a separate lumped bucket — each
          one shows inside its REAL stage below (pinned to the top of its stage
          with a lightning chip) so it can be worked and moved stage-by-stage in
          place. This is just the at-a-glance count + a reminder of what the chip
          means. (2026-07-21, Adon.) */}
      {!stageFilter && variant === "sunbiz" && entityName === "lead" && (() => {
        const n = rows.filter(isAccelerated).length;
        if (!n) return null;
        return (
          <div className="flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-fg-muted">
            <Zap className="h-3.5 w-3.5 shrink-0 text-amber-300" fill="currentColor" />
            <span>
              <span className="font-bold text-amber-300">{n}</span> lead{n === 1 ? "" : "s"} on the
              accelerated SMS chase. They&apos;re pinned to the top of their stage below with the{" "}
              <span className="font-bold text-amber-300">Accel</span> chip. Click a chip to stop the
              chase; the lead drops off automatically once it reaches the application funnel.
            </span>
          </div>
        );
      })()}

      {visibleStages.map((stage) => {
        const stageRows = sortAcceleratedFirst(
          applyDocFilter(
            renderedRows.filter((r) => String(r.data[stageField] || "") === stage.key),
          ),
        );
        return (
          <StageSection
            key={stage.key}
            slug={slug}
            entityName={entityName}
            stage={stage}
            rows={stageRows}
            collapsed={collapsedStages[stage.key] ?? true}
            onToggle={() => toggleStage(stage.key)}
            variant={variant}
            cfg={cfg}
            basePath={basePath}
            stageMap={stageMap}
            selectMode={selectMode}
            selected={selected}
            onToggleSelect={toggleSelect}
            onAddLead={() => setAddLeadOpen(true)}
          />
        );
      })}

      <BulkEmailDialog
        open={emailDialogOpen}
        onClose={() => {
          setEmailDialogOpen(false);
          setSelected(new Set());
        }}
        selectedIds={Array.from(selected)}
        entityName={entityName}
        onSent={() => router.refresh()}
      />
      <BulkSendHistory open={sendHistoryOpen} onClose={() => setSendHistoryOpen(false)} />

      {selectMode && selected.size > 0 && (
        <BulkActionBar
          count={selected.size}
          selectedIds={Array.from(selected)}
          entityName={entityName}
          stages={stages}
          members={members}
          membersState={membersState}
          onRetryMembers={retryMembers}
          busy={bulkBusy}
          onAssign={(uid) => runBulk({ op: "assign", assigned_to: uid }, "assigned")}
          onStage={(stageKey) => runBulk({ op: "stage", stage: stageKey, entity: entityName }, "moved")}
          onDecline={
            entityName === "lead"
              ? () => {
                  if (
                    window.confirm(
                      `Decline ${selected.size} lead${selected.size === 1 ? "" : "s"}? They move to Applications › Declined.`,
                    )
                  ) {
                    runBulk({ op: "decline", entity: entityName }, "declined");
                  }
                }
              : undefined
          }
          onOpenEmail={() => setEmailDialogOpen(true)}
          onCcBlast={(templateId) => runBulk({ op: "cc_blast", template_id: templateId }, "sent")}
          onClear={() => setSelected(new Set())}
        />
      )}
    </div>
  );
}

/**
 * BulkActionBar — sticky footer shown in Select mode once ≥1 record is checked.
 * Assign-to-agent + move-stage in one action. Posts to /api/leads/bulk which
 * applies the owner-or-admin gate per record (an agent's bulk action only
 * touches records they own; others come back as `denied`).
 */
function BulkActionBar({
  count,
  selectedIds,
  entityName,
  stages,
  members,
  membersState,
  onRetryMembers,
  busy,
  onAssign,
  onStage,
  onDecline,
  onOpenEmail,
  onCcBlast,
  onClear,
}: {
  count: number;
  /** The selected record ids — consumed by the Send-to-dialer control. */
  selectedIds: string[];
  entityName: "lead" | "application";
  stages: StageMeta[];
  members: TenantMember[] | null;
  membersState: "idle" | "loading" | "error";
  onRetryMembers: () => void;
  busy: boolean;
  onAssign: (assignedTo: string | null) => void;
  onStage: (stageKey: string) => void;
  onDecline?: () => void;
  onOpenEmail: () => void;
  onCcBlast: (templateId: string) => void;
  onClear: () => void;
}) {
  // Two-step confirm before a template blast — picking from the dropdown stages
  // the send; the operator must then confirm the exact count.
  const [pendingCc, setPendingCc] = useState<{ id: string; label: string } | null>(null);
  return (
    <div className="sticky bottom-3 z-20 mx-auto flex w-fit max-w-full flex-wrap items-center gap-3 rounded-xl border border-accent/40 bg-bg-elev/95 px-4 py-2.5 shadow-lg backdrop-blur">
      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-fg">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" /> : <CheckSquare className="h-3.5 w-3.5 text-accent" />}
        {count} {entityName === "application" ? "app" : "lead"}
        {count === 1 ? "" : "s"}
      </span>

      <label className="flex items-center gap-1.5 text-[11px] text-fg-muted">
        <UserPlus className="h-3.5 w-3.5 text-fg-dim" />
        {membersState === "error" ? (
          <button
            type="button"
            onClick={onRetryMembers}
            className="rounded-md border border-red-400/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-200 hover:bg-red-500/20"
          >
            Couldn't load agents — retry
          </button>
        ) : (
          <select
            defaultValue=""
            disabled={busy || membersState === "loading"}
            onChange={(e) => {
              const v = e.target.value;
              e.currentTarget.selectedIndex = 0;
              if (v === "__unassign") onAssign(null);
              else if (v) onAssign(v);
            }}
            className="rounded-md border border-bg-border bg-bg-deep px-2 py-1 text-[12px] text-fg focus:border-accent focus:outline-none disabled:opacity-60"
          >
            <option value="">{membersState === "loading" ? "Loading agents…" : "Assign to…"}</option>
            {membersState !== "loading" && <option value="__unassign">— Unassign —</option>}
            {(members || []).map((m) => (
              <option key={m.auth_user_id} value={m.auth_user_id}>
                {m.display_name || m.full_name || m.auth_user_id.slice(0, 8)}
              </option>
            ))}
          </select>
        )}
      </label>

      <label className="flex items-center gap-1.5 text-[11px] text-fg-muted">
        Move to
        <select
          defaultValue=""
          disabled={busy}
          onChange={(e) => {
            const v = e.target.value;
            e.currentTarget.selectedIndex = 0;
            if (v === "__decline") onDecline?.();
            else if (v) onStage(v);
          }}
          className="rounded-md border border-bg-border bg-bg-deep px-2 py-1 text-[12px] text-fg focus:border-accent focus:outline-none disabled:opacity-60"
        >
          <option value="">Stage…</option>
          {stages.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
          {entityName === "lead" && onDecline && (
            <option value="__decline">Decline → Applications</option>
          )}
        </select>
      </label>

      {/* Bulk email. Opens the full composer (preflight + template or
          write-your-own + live send status) rather than firing from a bare
          dropdown. The old dropdown queued correctly but showed the operator
          nothing afterwards, which is what made a working pipeline read as a
          dead button (Adon, 2026-08-20). */}
      <button
        type="button"
        onClick={onOpenEmail}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md border border-bg-border bg-bg-deep px-2.5 py-1 text-[12px] text-fg hover:border-accent/50 disabled:opacity-60"
        title="Write or pick an email for every selected record. You'll see how many can actually be emailed before anything sends."
      >
        <Mail className="h-3.5 w-3.5 text-fg-dim" />
        Email…
      </button>

      {/* Constant Contact bulk blast — leads only, admin-only (enforced server-side). */}
      {entityName === "lead" && (
        <label className="flex items-center gap-1.5 text-[11px] text-fg-muted">
          <Mail className="h-3.5 w-3.5 text-fg-dim" />
          <select
            defaultValue=""
            disabled={busy}
            onChange={(e) => {
              const v = e.target.value;
              e.currentTarget.selectedIndex = 0;
              if (v) {
                const t = SUNBIZ_BULK_SAFE_TEMPLATES.find((x) => x.id === v);
                setPendingCc({ id: v, label: t?.label || v });
              }
            }}
            className="rounded-md border border-bg-border bg-bg-deep px-2 py-1 text-[12px] text-fg focus:border-accent focus:outline-none disabled:opacity-60"
            title="Blast this template to every selected lead via Constant Contact (admin only). Only outreach-safe templates appear here."
          >
            <option value="">CC blast…</option>
            {SUNBIZ_TEMPLATE_CATEGORIES.map((cat) => {
              const items = SUNBIZ_BULK_SAFE_TEMPLATES.filter((t) => t.category === cat.category);
              if (items.length === 0) return null;
              return (
                <optgroup key={cat.category} label={cat.label}>
                  {items.map((t) => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </label>
      )}

      {pendingCc && (
        <div className="flex items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-[11px] text-fg">
          <span>
            Blast <span className="font-semibold">&ldquo;{pendingCc.label}&rdquo;</span> to {count} lead
            {count === 1 ? "" : "s"} via Constant Contact?
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onCcBlast(pendingCc.id);
              setPendingCc(null);
            }}
            className="rounded-md border border-accent/50 bg-accent/20 px-2 py-0.5 text-[11px] font-semibold text-fg hover:bg-accent/30 disabled:opacity-60"
          >
            {busy ? "Sending…" : "Confirm CC blast"}
          </button>
          <button type="button" onClick={() => setPendingCc(null)} className="text-[11px] text-fg-dim hover:text-fg">
            Cancel
          </button>
        </div>
      )}

      {/* Kixie power-dialer push — leads only. Server enforces role gate +
          dry-run; the control fetches the tenant's PowerLists on open. */}
      {entityName === "lead" && (
        <SendToDialerControl selectedIds={selectedIds} disabled={busy} />
      )}

      <button
        type="button"
        onClick={onClear}
        disabled={busy}
        className="text-[11px] text-fg-dim hover:text-fg disabled:opacity-60"
      >
        Clear
      </button>
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
  variant,
  cfg,
  basePath,
  stageMap,
  selectMode = false,
  selected,
  onToggleSelect,
  onAddLead,
}: {
  slug: string;
  entityName: "lead" | "application";
  stage: StageMeta;
  rows: Row[];
  collapsed: boolean;
  onToggle: () => void;
  variant: PipelineVariant;
  cfg: VariantConfig;
  basePath: string;
  stageMap: Record<string, StageMeta>;
  selectMode?: boolean;
  selected?: Set<string>;
  onToggleSelect?: (id: string) => void;
  /** When set (only the sent_application section passes it), renders a "+ Add
   *  lead" button in the section header that opens the manual quick-add modal. */
  onAddLead?: () => void;
}) {
  const targetLabel = stageTargetLabelVariant(cfg, stage.key);
  return (
    <section
      className="overflow-visible rounded-lg border border-bg-border bg-bg-deep/30"
      style={{ borderLeftWidth: 4, borderLeftColor: stage.bg }}
    >
      <div className="flex w-full items-center" style={{ background: `${stage.bg}1A` }}>
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center justify-between gap-3 px-4 py-2.5 text-left"
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
          {targetLabel && (
            <span className="shrink-0 rounded bg-bg-deep/60 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wider text-fg-dim">
              {targetLabel}
            </span>
          )}
        </button>
        {onAddLead && stage.key === "sent_application" && (
          <button
            type="button"
            onClick={onAddLead}
            title="Manually add a lead to this status"
            className="mr-3 inline-flex shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-bg-deep hover:bg-accent/90"
          >
            <Plus className="h-3 w-3" /> Add lead
          </button>
        )}
      </div>

      {!collapsed && rows.length === 0 && (
        <div className="px-4 py-5 text-center text-xs text-fg-dim">No records</div>
      )}

      {!collapsed && rows.length > 0 && (
        <>
          <div className="hidden lg:block">
            <div
              className="grid border-b border-bg-border bg-bg-deep/55 text-left text-[10px] uppercase tracking-wider text-fg-dim"
              style={cfg.gridStyle}
            >
              {variant === "oasis" ? (
                <>
                  <HeaderCell>Lead</HeaderCell>
                  <HeaderCell>Address</HeaderCell>
                  <HeaderCell>Phone</HeaderCell>
                  <HeaderCell>Website</HeaderCell>
                  <HeaderCell>Score</HeaderCell>
                  <HeaderCell>Last Touch</HeaderCell>
                  <HeaderCell>Created</HeaderCell>
                </>
              ) : (
                <>
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
                </>
              )}
            </div>
            {rows.map((r) =>
              selectMode ? (
                <SelectableRow
                  key={r.id}
                  checked={selected?.has(r.id) ?? false}
                  onToggle={() => onToggleSelect?.(r.id)}
                >
                  <DesktopRow
                    slug={slug}
                    entityName={entityName}
                    row={r}
                    stage={stage}
                    variant={variant}
                    cfg={cfg}
                    basePath={basePath}
                    stageMap={stageMap}
                  />
                </SelectableRow>
              ) : (
                <DesktopRow
                  key={r.id}
                  slug={slug}
                  entityName={entityName}
                  row={r}
                  stage={stage}
                  variant={variant}
                  cfg={cfg}
                  basePath={basePath}
                  stageMap={stageMap}
                />
              ),
            )}
          </div>

          <div className="divide-y divide-bg-border/50 lg:hidden">
            {rows.map((r) =>
              selectMode ? (
                <SelectableRow
                  key={r.id}
                  checked={selected?.has(r.id) ?? false}
                  onToggle={() => onToggleSelect?.(r.id)}
                >
                  <MobileRow
                    slug={slug}
                    entityName={entityName}
                    row={r}
                    stage={stage}
                    variant={variant}
                    cfg={cfg}
                    basePath={basePath}
                    stageMap={stageMap}
                  />
                </SelectableRow>
              ) : (
                <MobileRow
                  key={r.id}
                  slug={slug}
                  entityName={entityName}
                  row={r}
                  stage={stage}
                  variant={variant}
                  cfg={cfg}
                  basePath={basePath}
                  stageMap={stageMap}
                />
              ),
            )}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * SelectableRow — wraps a pipeline row with a leading checkbox in bulk Select
 * mode WITHOUT touching the row's internal grid/Link (the checkbox sits outside
 * the Link, so checking a record never navigates). Keeps the default,
 * non-select view byte-for-byte identical.
 */
function SelectableRow({
  checked,
  onToggle,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex items-stretch border-b border-bg-border/40 last:border-b-0 ${
        checked ? "bg-accent/5" : ""
      }`}
    >
      <label className="flex shrink-0 cursor-pointer items-center pl-3 pr-1">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="h-4 w-4 accent-accent"
          aria-label="Select record"
        />
      </label>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function DesktopRow({
  slug,
  entityName,
  row,
  stage,
  variant,
  cfg,
  basePath,
  stageMap,
}: {
  slug: string;
  entityName: "lead" | "application";
  row: Row;
  stage: StageMeta;
  variant: PipelineVariant;
  cfg: VariantConfig;
  basePath: string;
  stageMap: Record<string, StageMeta>;
}) {
  const router = useRouter();
  const [hover, setHover] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openHover = (e: ReactMouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      setAnchor({ left: rect.left, top: rect.bottom });
      setHover(true);
    }, 250);
  };
  const closeHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHover(false);
  };
  if (variant === "oasis") {
    return <OasisDesktopRow row={row} stage={stage} cfg={cfg} basePath={basePath} />;
  }
  const model = rowModel(row, stage);
  const href = pipelineRowHref(slug, entityName, row.id);
  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={`Open ${model.businessName}`}
      onClick={() => router.push(href)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          router.push(href);
        }
      }}
      onMouseEnter={openHover}
      onMouseLeave={closeHover}
      className="grid cursor-pointer border-b border-bg-border/40 text-[11px] transition-colors last:border-b-0 hover:bg-bg-elev/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
      style={cfg.gridStyle}
    >
      <Cell>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-bg-border bg-bg-elev text-[10px] font-bold uppercase text-fg-muted">
            {initialsOf(model.businessName)}
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-semibold text-fg" title={model.businessName}>
                {model.businessName}
              </span>
              {entityName === "lead" && isAcceleratedEligible(row.data) && (
                <AcceleratedToggle recordId={row.id} on={isAccelerated(row)} />
              )}
            </span>
            <span className="block truncate text-[10px] text-fg-dim" title={model.subtitle}>
              {model.subtitle}
            </span>
            {model.email ? (
              <span className="flex min-w-0 items-center gap-1">
                <span className="truncate text-[10px] text-accent/80" title={model.email}>
                  {model.email}
                </span>
                <CopyButton value={model.email} size={11} />
              </span>
            ) : null}
          </span>
        </div>
      </Cell>
      <Cell title={model.ownerName}>{model.ownerName}</Cell>
      <Cell clip={false} mono>
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate" title={model.phone}>
            {model.phone}
          </span>
          <CopyButton value={model.phone} />
        </span>
      </Cell>
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
      <Cell clip={false}>
        <InlineStageControl
          recordId={row.id}
          stage={stage.key}
          stageMap={stageMap}
          entity={entityName}
        />
      </Cell>
      <Cell mono>{model.paper}</Cell>
      <Cell mono>{model.leverage}</Cell>
      <Cell align="right" className="font-semibold text-fg">
        {model.monthlyRev}
      </Cell>
      <Cell mono>{model.years}</Cell>
      {hover && anchor ? (
        <DealHoverCard leadId={row.id} entity={entityName} stage={stage} anchor={anchor} />
      ) : null}
    </div>
  );
}

function MobileRow({
  slug,
  entityName,
  row,
  stage,
  variant,
  cfg,
  basePath,
  stageMap,
}: {
  slug: string;
  entityName: "lead" | "application";
  row: Row;
  stage: StageMeta;
  variant: PipelineVariant;
  cfg: VariantConfig;
  basePath: string;
  stageMap: Record<string, StageMeta>;
}) {
  const router = useRouter();
  if (variant === "oasis") {
    return <OasisMobileRow row={row} stage={stage} cfg={cfg} basePath={basePath} />;
  }
  const model = rowModel(row, stage);
  const href = pipelineRowHref(slug, entityName, row.id);
  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={`Open ${model.businessName}`}
      onClick={() => router.push(href)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          router.push(href);
        }
      }}
      className="block cursor-pointer px-4 py-3 transition-colors hover:bg-bg-elev/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
    >
      <div className="flex items-start gap-3">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-bg-border bg-bg-elev text-[10px] font-bold uppercase text-fg-muted">
          {initialsOf(model.businessName)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-1.5">
                <div className="truncate text-sm font-semibold text-fg">{model.businessName}</div>
                {entityName === "lead" && isAcceleratedEligible(row.data) && (
                  <AcceleratedToggle recordId={row.id} on={isAccelerated(row)} />
                )}
              </div>
              <div className="truncate text-[11px] text-fg-dim">{model.ownerName}</div>
            </div>
            <InlineStageControl
              recordId={row.id}
              stage={stage.key}
              stageMap={stageMap}
              entity={entityName}
              menuAlign="right"
            />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-fg-muted">
            <div className="min-w-0">
              <div className="text-[9px] font-bold uppercase tracking-wider text-fg-dim">Phone</div>
              <div className="flex items-center gap-1">
                <span className="truncate font-mono">{model.phone}</span>
                <CopyButton value={model.phone} />
              </div>
            </div>
            {model.email ? (
              <div className="min-w-0">
                <div className="text-[9px] font-bold uppercase tracking-wider text-fg-dim">Email</div>
                <div className="flex items-center gap-1">
                  <span className="truncate">{model.email}</span>
                  <CopyButton value={model.email} size={11} />
                </div>
              </div>
            ) : null}
            <MiniMetric label="Submit" value={model.submitDate} />
            <MiniMetric label="Agent" value={model.agentLabel} />
            <MiniMetric label="Last" value={model.lastTouchLabel} />
            <MiniMetric label="M Rev" value={model.monthlyRev} />
            <MiniMetric label="Years" value={model.years} mono />
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// OASIS variant: 6-column desktop grid, AI-agency row model
// ============================================================================

function oasisRowModel(row: Row, cfg: VariantConfig, stage: StageMeta) {
  const d = row.data;
  // OASIS lead shape (lib/manifest/seeds.ts → OASIS_SEED.data_model.lead):
  //   name, company, email, phone, source, stage, score, value_estimate,
  //   last_contacted_at, notes, ai_score, ai_reasoning, ai_scored_at, ...
  const company = str(d.company) || str(d.business_name) || "";
  // Fallback ladder: real name → contact_name → company → email localpart →
  // "Lead <id-prefix>". Avoids the bare "Untitled" — anything we can show
  // beats a blank label.
  const emailLocal = (str(d.email) || "").split("@")[0] || "";
  const name =
    str(d.name) ||
    str(d.contact_name) ||
    company ||
    emailLocal ||
    `Lead ${row.id.slice(0, 6)}`;
  const email = str(d.email) || "";
  const phone = formatPhone(str(d.phone) || "");
  const assignedRep = str(d.assigned_to_name) || (str(d.assigned_to) ? "Assigned agent" : "Unassigned");
  const aiScoreRaw = typeof d.ai_score === "number" ? d.ai_score : null;
  const scoreRaw = typeof d.score === "number" ? d.score : null;
  const scoreNum = aiScoreRaw ?? scoreRaw;
  const touchIso = lastTouchIso(row);
  const cold = d.docs_on_file !== true && isGoingColdVariant(cfg, stage.key, touchIso);
  const lastTouchLabel = touchIso ? relTime(touchIso) : "-";
  const createdIso = row.created_at || null;
  const createdLabel = createdIso ? formatShortDate(createdIso) : "-";
  // ═══ THE WEB-LEAD HALF (2026-08-25) ═════════════════════════════════════
  //
  // Adon: "you can see [it] on the leads tab but you should also be able to
  // click and view the website as well as see all of the leads information...
  // on the pipeline tab, which is our CRM."
  //
  // These fields were already on every row and simply never read here. The CRM
  // board and the /web-leads list are the same `tenant_records` rows in the
  // same tenant, so this reads the lead's own stored values rather than
  // deriving anything new. `industry` falls back across the two spellings the
  // ingest writes; `webdev_industry` is the rep-facing collapse of 212 raw OSM
  // categories into 18, so it is preferred when present.
  const websiteUrl = str(d.website);
  const city = str(d.business_city);
  const province = str(d.state);
  const industry = str(d.webdev_industry) || str(d.industry);
  const address = str(d.business_address);
  // VERBATIM, both of them, in every state. These once rendered only in the
  // non-scored branch, which meant a scored lead showed neither -- exactly when
  // a rep has a confident number and most needs the hedge. Never shortened,
  // re-worded, or turned into a badge.
  const websiteCondition = str(d.website_condition);
  const auditFindings = str(d.audit_findings);
  // Resolved server-side by lib/web-leads/attach-scores.ts against the same
  // memoised index the leads tab uses, so the two screens cannot disagree.
  // Absent (undefined) means nobody attached it -- a caller that did not opt in
  // -- which is NOT the same as "not scored" and must not render as a number.
  // Is this row actually a web-lead? Caught by review 2026-08-25: the battle
  // card lives at /web-leads/<id>, whose fetchLead is pinned to WEBDEV_TENANT_ID,
  // so linking there from any other tenant's row -- or from an ordinary CRM lead
  // typed in by hand -- hands a rep a button that always 404s. `oasis-webdev`
  // holds 53 real leads, so this was live. Keyed on the business id the score
  // join already needs, which is the same thing that makes a row a web-lead.
  const webLeadBusinessId = str(d.webdev_source_business_id);
  const webScoreRaw = d.derived_website_score;
  const webScore = typeof webScoreRaw === "number" ? webScoreRaw : null;
  const webScoreState =
    typeof d.derived_website_score_state === "string"
      ? (d.derived_website_score_state as WebScoreState)
      : null;
  // "City, PROV · Industry" -- whichever parts exist, never a lone separator.
  const place = [city, province].filter(Boolean).join(", ");
  const businessLine = [place, industry].filter(Boolean).join(" · ");
  return {
    name,
    company,
    email,
    phone,
    assignedRep,
    score: scoreNum,
    cold,
    lastTouchLabel,
    createdLabel,
    websiteUrl,
    city,
    province,
    industry,
    address,
    websiteCondition,
    auditFindings,
    webScore,
    webScoreState,
    businessLine,
    isWebLead: Boolean(webLeadBusinessId),
  };
}

/** Mirrors ScoreState in lib/web-leads/scores.ts. Declared locally rather than
 *  imported so this client component does not pull in the server-only score
 *  module (it reaches getServiceSupabase) just to name a union. */
type WebScoreState = "scored" | "unreachable" | "not_scored" | "no_website" | "parked";

/**
 * The website block on a CRM row: open the site, open the battle card, and the
 * honest state of what we know about it.
 *
 * ═══ NO COLOUR IS KEYED TO THE SCORE, ANYWHERE IN HERE ═══════════════════
 * Not on the number, not on a bar, not on a marker. A red 22 renders a
 * judgement the measurement does not support, and a rep who sees red says
 * something on a live call they cannot back up. The number is `text-fg` and the
 * track is one neutral fill whether the score is 4 or 94. This is pinned by
 * tests/web-leads-guards.test.ts, which bans the colour utilities on every
 * audit-rendering component by name -- this one included.
 */
function PipelineWebsiteCell({
  m,
  leadId,
}: {
  m: ReturnType<typeof oasisRowModel>;
  leadId: string;
}) {
  const href = preferredSiteUrl(m.websiteUrl);
  // THE THREE NON-SCORED STATES RENDER AS SENTENCES, never a zero, a dash, a
  // blank or an empty chart. `no_website` uses the lead's OWN stored wording,
  // which is OpenStreetMap's hedge -- absence of a website tag means nobody
  // mapped one, not that no site exists.
  const sentence =
    m.webScoreState === "parked"
      ? "Domain listed for sale, no live site"
      : m.webScoreState === "unreachable"
        ? "We could not check this site"
        : m.webScoreState === "not_scored"
          ? "Not scored yet"
          : m.webScoreState === "no_website"
            ? m.websiteCondition || "No website found yet, needs checking"
            : null;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {/* Both are real links so they middle-click and cmd-click into a new
            tab. A rep queueing three sites before a call block is the normal
            case. z-10 lifts them above the row's stretched overlay link. */}
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open ${m.name}'s website in a new tab`}
            className="relative z-10 inline-flex shrink-0 items-center gap-1 rounded-md border border-bg-border/70 px-2 py-1 text-[10px] font-semibold text-fg-dim opacity-80 transition-all duration-150 group-hover:border-bg-border group-hover:text-fg-muted group-hover:opacity-100 hover:!border-accent/50 hover:!bg-accent/10 hover:!text-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
          >
            <ExternalLink className="h-3 w-3" />View site
          </a>
        )}
        {/* Only for rows that ARE web-leads -- see isWebLead in the row model.
            A button that reliably 404s is worse than no button. */}
        {m.isWebLead && (
        <Link
          href={`/web-leads/${encodeURIComponent(leadId)}`}
          title={`Open the full battle card for ${m.name}`}
          className="relative z-10 inline-flex shrink-0 items-center gap-1 rounded-md border border-bg-border/70 px-2 py-1 text-[10px] font-semibold text-fg-dim opacity-80 transition-all duration-150 group-hover:border-bg-border group-hover:text-fg-muted group-hover:opacity-100 hover:!border-accent/50 hover:!bg-accent/10 hover:!text-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
        >
          <BarChart3 className="h-3 w-3" />Battle card
        </Link>
        )}
      </div>
      {m.webScoreState === "scored" && m.webScore != null ? (
        <div className="flex w-full items-center gap-2">
          <span className="text-sm font-bold leading-none tabular-nums text-fg">{m.webScore}</span>
          <span className="block h-1.5 w-full max-w-[4rem] overflow-hidden rounded-full bg-bg-border/80" aria-hidden>
            <span
              className="block h-full rounded-full bg-fg-muted"
              style={{ width: `${Math.min(100, Math.max(0, m.webScore))}%` }}
            />
          </span>
        </div>
      ) : sentence ? (
        <span className="block text-[10px] italic leading-snug text-fg-dim">{sentence}</span>
      ) : null}
    </div>
  );
}

function OasisDesktopRow({
  row,
  stage,
  cfg,
  basePath,
}: {
  row: Row;
  stage: StageMeta;
  cfg: VariantConfig;
  basePath: string;
}) {
  const m = oasisRowModel(row, cfg, stage);
  return (
    // ═══ WHY THIS IS NO LONGER A <Link> WRAPPING THE WHOLE ROW ═════════════
    //
    // It used to be, and that made the row a single anchor. The moment this row
    // gained its own "View site" and "Battle card" links, that shape became an
    // anchor inside an anchor -- which is invalid HTML, and browsers do not
    // render it as written: the parser closes the outer <a> early and the row
    // silently comes apart. React will happily emit it and nothing throws.
    //
    // The fix is the stretched-link pattern: the row is a plain grid, and ONE
    // absolutely-positioned link covers it. The row still behaves exactly as
    // before, including middle-click and cmd-click into a new tab, which a
    // router.push on a div would have thrown away -- and reps queue leads that
    // way before a call block. The inner links sit at z-10, above the overlay.
    <div
      className="group relative grid border-b border-bg-border/40 text-[11px] transition-colors last:border-b-0 hover:bg-bg-elev/40"
      style={cfg.gridStyle}
    >
      <Link
        href={`${basePath}/${row.id}`}
        aria-label={`Open ${m.name}`}
        // The overlay paints above the static cells, so THEIR `title` tooltips
        // no longer fire -- the topmost element under the cursor owns the
        // tooltip and this is it. The cell titles are left in place (they work
        // again if this ever stops being an overlay), and the facts a rep would
        // have hovered for are gathered here instead, so the row now yields
        // MORE on hover than it did as a plain link, not less.
        title={[m.name, m.businessLine, m.address].filter(Boolean).join(" · ")}
        className="absolute inset-0 z-0 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
      />
      <Cell>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-bg-border bg-bg-elev text-[10px] font-bold uppercase text-fg-muted">
            {initialsOf(m.name)}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-semibold text-fg" title={m.name}>
              {m.name}
            </span>
            {m.company && m.company !== m.name && (
              <span className="block truncate text-[10px] text-fg-dim" title={m.company}>
                {m.company}
              </span>
            )}
            {/* The business itself: where it is and what it does. A rep opening
                a CRM row should not have to leave for the one fact that decides
                how the call opens. */}
            {m.businessLine && (
              <span className="block truncate text-[10px] text-fg-muted" title={m.address ? `${m.businessLine} — ${m.address}` : m.businessLine}>
                {m.businessLine}
              </span>
            )}
            {/* The Email COLUMN was replaced by Address on this board, measured
                2026-08-25: 4 of 31,034 leads carry an email, 26,800 carry an
                address. A column empty for 99.99% of rows was holding the
                second-widest slot on the grid. The four are not lost -- an
                email renders here whenever one exists, and the detail page
                shows it unconditionally. */}
            {m.email && (
              <span className="block truncate text-[10px] text-fg-dim" title={m.email}>
                {m.email}
              </span>
            )}
            <span className="block truncate text-[10px] text-accent/80" title={m.assignedRep}>Assigned: {m.assignedRep}</span>
          </span>
        </div>
      </Cell>
      <Cell title={m.address || ""}>{m.address || "-"}</Cell>
      <Cell title={m.phone} mono>{m.phone || "-"}</Cell>
      <Cell>
        <PipelineWebsiteCell m={m} leadId={row.id} />
      </Cell>
      <Cell>
        {m.score != null ? (
          <span
            className="inline-flex h-6 min-w-[28px] items-center justify-center rounded-full bg-accent/15 px-1.5 font-mono text-[10px] font-bold text-accent"
            title="AI score (0-100)"
          >
            {m.score}
          </span>
        ) : (
          "-"
        )}
      </Cell>
      <Cell className={m.cold ? "font-semibold text-red-300" : ""}>{m.lastTouchLabel}</Cell>
      <Cell>{m.createdLabel}</Cell>
    </div>
  );
}

function OasisMobileRow({
  row,
  stage,
  cfg,
  basePath,
}: {
  row: Row;
  stage: StageMeta;
  cfg: VariantConfig;
  basePath: string;
}) {
  const m = oasisRowModel(row, cfg, stage);
  // Same stretched-link restructure as the desktop row, and for the same
  // reason: the website and battle-card links are real anchors, so the card can
  // no longer BE one. See OasisDesktopRow's comment.
  return (
    <div className="group relative px-4 py-3 transition-colors hover:bg-bg-elev/40">
      <Link
        href={`${basePath}/${row.id}`}
        aria-label={`Open ${m.name}`}
        title={[m.name, m.businessLine, m.address].filter(Boolean).join(" · ")}
        className="absolute inset-0 z-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
      />
      <div className="flex items-start gap-3">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-bg-border bg-bg-elev text-[10px] font-bold uppercase text-fg-muted">
          {initialsOf(m.name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-fg">{m.name}</div>
              {/* Where it is and what it does, ahead of the contact details --
                  on a phone this is the line that tells a rep whether to call
                  now, and it used to be absent entirely. */}
              <div className="truncate text-[11px] text-fg-muted">{m.businessLine || m.company || m.email || "-"}</div>
              <div className="truncate text-[10px] text-accent/80">Assigned: {m.assignedRep}</div>
            </div>
            <StageChip stage={stage} />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-fg-muted">
            <MiniMetric label="Phone" value={m.phone || "-"} mono />
            <MiniMetric label="Address" value={m.address || "-"} />
            <MiniMetric label="Score" value={m.score != null ? String(m.score) : "-"} mono />
            <MiniMetric label="Last touch" value={m.lastTouchLabel} />
            <MiniMetric label="Created" value={m.createdLabel} />
            {m.email && <MiniMetric label="Email" value={m.email} />}
          </div>
          {/* The whole website block, controls and all. Sits below the metrics
              rather than inside the two-column grid because the non-scored
              sentence is a full clause and would be crushed into a 50% column. */}
          <div className="mt-2.5">
            <PipelineWebsiteCell m={m} leadId={row.id} />
          </div>
        </div>
      </div>
    </div>
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
  clip = true,
}: {
  children: ReactNode;
  align?: "left" | "right";
  mono?: boolean;
  title?: string;
  className?: string;
  clip?: boolean;
}) {
  return (
    <div
      className={`min-w-0 px-2 py-2.5 text-fg-muted ${clip ? "overflow-hidden truncate" : "overflow-visible"} ${
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
  const email = str(d.email) || str(d.contact_email) || "";
  const state = str(d.state) || str(d.business_state) || "-";
  const submitIso = str(d.submitted_at) || str(d.date_submitted) || row.created_at || null;
  const submitDate = submitIso ? formatShortDate(submitIso) : "-";
  const dayPill = submitIso ? `${Math.max(0, Math.round(daysSince(submitIso)))}d` : "-";
  const agentFull = str(d.assigned_to_name) || str(d.assigned_to) || "-";
  const agentLabel = compactAgent(agentFull);
  const touchIso = lastTouchIso(row);
  const cold = d.docs_on_file !== true && isGoingColdSun(stage.key, touchIso);
  const lastTouchLabel = touchIso ? relTime(touchIso) : "-";
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
    email,
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

/** Best-available dollar value for the lead — SunBiz uses funding-side
 *  fields, OASIS uses value_estimate. Returns null when none are set. */
function leadPotentialUsd(row: Row): number | null {
  const d = row.data;
  if (typeof d.requested_amount === "number") return d.requested_amount;
  if (typeof d.best_offer === "number") return d.best_offer;
  if (typeof d.value_estimate === "number") return d.value_estimate;
  if (typeof d.monthly_revenue === "number") return d.monthly_revenue;
  return null;
}

/** OASIS qualification proxy — used when value_estimate isn't populated
 *  yet (most cold-outreach leads). Prefers ai_score over the manual
 *  score; both are 0-100 so they're directly comparable. */
function leadQualificationScore(row: Row): number {
  const d = row.data;
  if (typeof d.ai_score === "number") return d.ai_score;
  if (typeof d.score === "number") return d.score;
  return 0;
}

function pickTouchFirst(
  rows: Row[],
  stageField: string,
  stages: StageMeta[],
  cfg: VariantConfig,
): TouchFirst | null {
  let best: TouchFirst | null = null;
  let bestRank: [number, number, number] | null = null;
  for (const r of rows) {
    const stageKey = String(r.data[stageField] || "");
    if (!cfg.active.has(stageKey)) continue;
    const lastTouch = lastTouchIso(r);
    if (r.data.docs_on_file === true || !isGoingColdVariant(cfg, stageKey, lastTouch)) continue;
    const days = daysSince(lastTouch) - (cfg.slaDays[stageKey] ?? 7);
    const potential = leadPotentialUsd(r);
    // Ranking tuple — highest wins, evaluated left to right:
    //   1. dollar potential (when known)
    //   2. qualification score (the meaningful signal for OASIS pre-revenue)
    //   3. days overdue (longer overdue = more urgent tie-break)
    const rank: [number, number, number] = [
      potential ?? 0,
      leadQualificationScore(r),
      days,
    ];
    if (!best || !bestRank || rankGreater(rank, bestRank)) {
      best = {
        id: r.id,
        name:
          str(r.data.business_name) ||
          str(r.data.name) ||
          str(r.data.contact_name) ||
          str(r.data.company) ||
          (str(r.data.email) || "").split("@")[0] ||
          `Lead ${r.id.slice(0, 6)}`,
        stageLabel: stages.find((s) => s.key === stageKey)?.label || stageKey.replace(/_/g, " "),
        daysOverdue: days,
        potentialUsd: potential,
      };
      bestRank = rank;
    }
  }
  return best;
}

function rankGreater(a: [number, number, number], b: [number, number, number]): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] > b[2];
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
