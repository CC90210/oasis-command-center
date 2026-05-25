"use client";

/**
 * ColdListImportClient — cold-list CSV import with Arcadian chevron view.
 *
 * Cold lists are a separate holding pen from the warm pipeline. An operator
 * imports a list of prospects here; individual contacts are promoted to
 * tenant_records leads only when the operator explicitly clicks "Promote".
 *
 * Four-step flow:
 *   1. Pick or create a list  (cold_lead_lists)
 *   2. Paste or upload CSV + map columns
 *   3. Submit → /api/manifest/<slug>/cold-lists/<list_id>/import
 *   4. Arcadian chevron view of the list by stage
 *
 * Stages (from migration 069 cold_leads.stage):
 *   imported → contacted → replied → qualified → promoted → dead
 *
 * Promote action: POST /api/manifest/<slug>/cold-leads/<id>/promote
 *   Creates a tenant_records lead row + marks the cold lead as promoted.
 *   This is the only crossing point between cold and warm. No exceptions.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Upload,
  FileText,
  Megaphone,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Plus,
  X,
  ChevronDown,
  ChevronUp,
  Users,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ColdList = {
  id: string;
  name: string;
  source: string | null;
  row_count: number;
  promoted_count: number;
  created_at: string;
};

type ColdLeadRow = {
  id: string;
  business_name: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  stage: string;
  attempt_count: number;
  created_at: string;
};

type StageGroup = {
  count: number;
  recent: ColdLeadRow[];
};

type ByStageResponse = {
  ok: boolean;
  list: ColdList;
  stages: Record<string, StageGroup>;
};

type ImportResult = {
  ok: boolean;
  inserted?: number;
  skipped?: number;
  duplicates?: number;
  error?: string;
};

type ParsedRow = {
  business_name: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  raw: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Column mapping helpers
// ---------------------------------------------------------------------------

const FIELD_OPTIONS = [
  { value: "business_name", label: "Business Name" },
  { value: "contact_name", label: "Contact Name" },
  { value: "phone", label: "Phone" },
  { value: "email", label: "Email" },
  { value: "_skip", label: "Skip this column" },
] as const;

type MappedField = "business_name" | "contact_name" | "phone" | "email" | "_skip";

/** Auto-detect a header's likely field based on its name. */
function autoDetectField(header: string): MappedField {
  const h = header.toLowerCase().trim();
  if (/business|company|org|dba|merchant/.test(h)) return "business_name";
  if (/contact|name|first|owner|rep/.test(h)) return "contact_name";
  if (/phone|cell|mobile|tel/.test(h)) return "phone";
  if (/email|e-mail|mail/.test(h)) return "email";
  return "_skip";
}

/** Parse raw CSV text into headers + data rows. Tolerates quoted fields. */
function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  function parseLine(line: string): string[] {
    const cells: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuote = !inQuote;
      } else if (ch === "," && !inQuote) {
        cells.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    return cells;
  }

  // Find the header row: the first line that contains "name", "phone", or "email".
  let headerIdx = 0;
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const lower = lines[i].toLowerCase();
    if (/name|phone|email/.test(lower)) {
      headerIdx = i;
      break;
    }
  }

  const headers = parseLine(lines[headerIdx]);
  const dataRows = lines
    .slice(headerIdx + 1)
    .map(parseLine)
    .filter((r) => r.some((c) => c.length > 0));

  return { headers, rows: dataRows };
}

/** Apply a column mapping to raw rows and produce ParsedRow[]. */
function applyMapping(
  headers: string[],
  rows: string[][],
  mapping: MappedField[],
): ParsedRow[] {
  return rows.map((cols) => {
    const parsed: ParsedRow = {
      business_name: null,
      contact_name: null,
      phone: null,
      email: null,
      raw: {},
    };
    headers.forEach((h, i) => {
      const val = cols[i] ?? "";
      const field = mapping[i] ?? "_skip";
      if (field !== "_skip" && val.trim()) {
        parsed[field] = val.trim();
      }
      parsed.raw[h] = val;
    });
    return parsed;
  });
}

// ---------------------------------------------------------------------------
// Cold stage metadata (mirrors migration 069 cold_leads.stage values)
// ---------------------------------------------------------------------------

const COLD_STAGES: { key: string; label: string; bg: string; fg: string }[] = [
  { key: "imported",  label: "Imported",  bg: "#4C6580", fg: "#FFFFFF" },
  { key: "contacted", label: "Contacted", bg: "#C0842F", fg: "#FFFFFF" },
  { key: "replied",   label: "Replied",   bg: "#2E8392", fg: "#FFFFFF" },
  { key: "qualified", label: "Qualified", bg: "#7057A7", fg: "#FFFFFF" },
  { key: "promoted",  label: "Promoted",  bg: "#32876B", fg: "#FFFFFF" },
  { key: "dead",      label: "Dead",      bg: "#6F2D34", fg: "#FFFFFF" },
];

// ---------------------------------------------------------------------------
// Sub-component: ListPicker
// ---------------------------------------------------------------------------

function ListPicker({
  tenantSlug,
  lists,
  selectedId,
  onSelect,
  onCreated,
  loading,
}: {
  tenantSlug: string;
  lists: ColdList[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreated: (list: ColdList) => void;
  loading: boolean;
}) {
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch(`/api/manifest/${tenantSlug}/cold-lists`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, source: "csv_upload" }),
      });
      const data = (await res.json()) as { ok: boolean; list_id?: string; error?: string };
      if (!data.ok || !data.list_id) {
        setCreateError(data.error ?? "create_failed");
        return;
      }
      const newList: ColdList = {
        id: data.list_id,
        name,
        source: "csv_upload",
        row_count: 0,
        promoted_count: 0,
        created_at: new Date().toISOString(),
      };
      onCreated(newList);
      setNewName("");
      onSelect(newList.id);
    } catch {
      setCreateError("network_error");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-3">
      {loading ? (
        <div className="flex items-center gap-2 text-fg-muted text-sm">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading lists…
        </div>
      ) : (
        <>
          {lists.length > 0 && (
            <div className="grid gap-1.5 max-h-48 overflow-y-auto pr-1">
              {lists.map((list) => {
                const active = list.id === selectedId;
                return (
                  <button
                    key={list.id}
                    type="button"
                    onClick={() => onSelect(list.id)}
                    className={`flex items-center justify-between w-full rounded-md border px-3 py-2 text-left text-[12.5px] transition-colors ${
                      active
                        ? "border-accent/50 bg-accent/10 text-accent"
                        : "border-bg-border bg-bg-deep text-fg hover:bg-bg-elev/60"
                    }`}
                  >
                    <span className="font-medium truncate">{list.name}</span>
                    <span className="ml-3 shrink-0 text-fg-muted text-[11px]">
                      {list.row_count.toLocaleString()} rows · {list.promoted_count} promoted
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { void handleCreate(); } }}
              placeholder="New list name…"
              className="flex-1 min-w-0 rounded-md border border-bg-border bg-bg-deep px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent/50 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={!newName.trim() || creating}
              className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/20 disabled:opacity-40"
            >
              {creating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
              Create list
            </button>
          </div>
          {createError && (
            <p className="text-xs text-rose-400">{createError}</p>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: ColumnMapper
// ---------------------------------------------------------------------------

function ColumnMapper({
  headers,
  mapping,
  onChange,
}: {
  headers: string[];
  mapping: MappedField[];
  onChange: (mapping: MappedField[]) => void;
}) {
  return (
    <div className="grid gap-2">
      {headers.map((h, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="w-40 truncate text-xs font-mono text-fg-muted" title={h}>
            {h || `Column ${i + 1}`}
          </span>
          <ArrowRight className="w-3.5 h-3.5 text-fg-dim shrink-0" />
          <select
            value={mapping[i] ?? "_skip"}
            onChange={(e) => {
              const next = [...mapping];
              next[i] = e.target.value as MappedField;
              onChange(next);
            }}
            className="flex-1 rounded-md border border-bg-border bg-bg-deep px-2 py-1 text-xs text-fg focus:border-accent/50 focus:outline-none"
          >
            {FIELD_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: ColdChevronRail — Arcadian stage sidebar
// ---------------------------------------------------------------------------

function ColdChevronRail({
  stages,
  activeStage,
  onSelect,
}: {
  stages: Record<string, StageGroup>;
  activeStage: string | null;
  onSelect: (key: string | null) => void;
}) {
  return (
    <nav aria-label="Cold list stages" className="w-full">
      <ul className="flex flex-col gap-1.5">
        <li>
          <button
            type="button"
            onClick={() => onSelect(null)}
            className={`flex items-center justify-between w-full px-3 h-9 rounded-md border text-[12px] font-semibold uppercase tracking-wider ${
              activeStage === null
                ? "bg-bg-elev text-fg border-bg-border"
                : "bg-bg-deep/40 text-fg-muted border-bg-border hover:text-fg"
            }`}
          >
            <span>All</span>
          </button>
        </li>
        {COLD_STAGES.map((stage) => {
          const group = stages[stage.key];
          const count = group?.count ?? 0;
          const isActive = activeStage === stage.key;
          return (
            <li key={stage.key}>
              <button
                type="button"
                onClick={() => onSelect(stage.key)}
                className="flex items-center justify-between w-full px-3 h-9 rounded-md text-[12.5px] font-semibold whitespace-nowrap transition-transform hover:translate-x-[1px]"
                style={{
                  background: stage.bg,
                  color: stage.fg,
                  opacity: activeStage === null || isActive ? 1 : 0.78,
                }}
              >
                <span className={isActive ? "underline underline-offset-4 decoration-2" : ""}>
                  {stage.label}
                </span>
                {typeof count === "number" && (
                  <span
                    className="inline-flex items-center justify-center min-w-[20px] h-[18px] px-1 rounded-full text-[10.5px] font-mono"
                    style={{ background: "rgba(0,0,0,0.32)", color: stage.fg }}
                  >
                    {count}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: ColdLeadCard — row in the stage section
// ---------------------------------------------------------------------------

function ColdLeadCard({
  lead,
  tenantSlug,
  onPromoted,
}: {
  lead: ColdLeadRow;
  tenantSlug: string;
  onPromoted: (coldLeadId: string, warmLeadId: string) => void;
}) {
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [promotedId, setPromotedId] = useState<string | null>(null);

  async function handlePromote() {
    setPromoting(true);
    setPromoteError(null);
    try {
      const res = await fetch(`/api/manifest/${tenantSlug}/cold-leads/${lead.id}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const data = (await res.json()) as {
        ok: boolean;
        promoted_lead_id?: string;
        error?: string;
      };
      if (!data.ok || !data.promoted_lead_id) {
        setPromoteError(data.error ?? "promote_failed");
        return;
      }
      setPromotedId(data.promoted_lead_id);
      onPromoted(lead.id, data.promoted_lead_id);
    } catch {
      setPromoteError("network_error");
    } finally {
      setPromoting(false);
    }
  }

  const alreadyPromoted = lead.stage === "promoted" || !!promotedId;

  return (
    <div className="flex items-start justify-between gap-3 py-2.5 px-3 border-b border-bg-border/40 last:border-b-0">
      <div className="min-w-0">
        <div className="text-sm font-medium text-fg truncate">
          {lead.business_name || <span className="text-fg-muted italic">No business name</span>}
        </div>
        <div className="text-xs text-fg-muted mt-0.5 flex flex-wrap gap-x-3">
          {lead.contact_name && <span>{lead.contact_name}</span>}
          {lead.phone && <span className="font-mono">{lead.phone}</span>}
          {lead.email && <span className="font-mono">{lead.email}</span>}
        </div>
        {promoteError && (
          <p className="mt-1 text-[11px] text-rose-400">{promoteError}</p>
        )}
      </div>
      {alreadyPromoted ? (
        <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold text-status-engaged">
          <CheckCircle2 className="w-3 h-3" /> Promoted
        </span>
      ) : (
        <button
          type="button"
          onClick={() => void handlePromote()}
          disabled={promoting}
          className="shrink-0 inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] font-semibold text-accent hover:bg-accent/20 disabled:opacity-50"
        >
          {promoting ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowRight className="w-3 h-3" />}
          Promote
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: StageSection — collapsible chevron section
// ---------------------------------------------------------------------------

function StageSection({
  stageKey,
  group,
  tenantSlug,
  onLeadPromoted,
}: {
  stageKey: string;
  group: StageGroup;
  tenantSlug: string;
  onLeadPromoted: (coldLeadId: string, warmLeadId: string) => void;
}) {
  const meta = COLD_STAGES.find((s) => s.key === stageKey);
  const [open, setOpen] = useState(stageKey === "imported");

  if (!meta || group.count === 0) return null;

  return (
    <div className="rounded-xl border border-bg-border overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between w-full px-4 py-3"
        style={{ background: meta.bg + "22" }}
      >
        <div className="flex items-center gap-2">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ background: meta.bg }}
          />
          <span className="text-sm font-semibold text-fg">{meta.label}</span>
          <span className="text-[11px] font-mono text-fg-muted">
            {group.count.toLocaleString()} contact{group.count === 1 ? "" : "s"}
          </span>
        </div>
        {open ? (
          <ChevronUp className="w-4 h-4 text-fg-dim" />
        ) : (
          <ChevronDown className="w-4 h-4 text-fg-dim" />
        )}
      </button>
      {open && (
        <div className="bg-bg-deep/40">
          {group.recent.length === 0 ? (
            <div className="px-4 py-3 text-xs text-fg-muted italic">No recent records.</div>
          ) : (
            <>
              {group.recent.map((lead) => (
                <ColdLeadCard
                  key={lead.id}
                  lead={lead}
                  tenantSlug={tenantSlug}
                  onPromoted={onLeadPromoted}
                />
              ))}
              {group.count > group.recent.length && (
                <div className="px-4 py-2 text-[11px] text-fg-dim italic border-t border-bg-border/40">
                  + {(group.count - group.recent.length).toLocaleString()} more not shown
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ColdListImportClient({ tenantSlug }: { tenantSlug: string }) {
  // --- Step 1: list picker ---
  const [lists, setLists] = useState<ColdList[]>([]);
  const [loadingLists, setLoadingLists] = useState(true);
  const [selectedListId, setSelectedListId] = useState<string | null>(null);

  // --- Step 2: CSV ---
  const [csvText, setCsvText] = useState("");
  const [parsed, setParsed] = useState<{ headers: string[]; rows: string[][] } | null>(null);
  const [mapping, setMapping] = useState<MappedField[]>([]);

  // --- Step 3: import ---
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // --- Step 4: stage view ---
  const [stageData, setStageData] = useState<ByStageResponse | null>(null);
  const [loadingStages, setLoadingStages] = useState(false);
  const [activeStage, setActiveStage] = useState<string | null>(null);
  const [_promotedIds, setPromotedIds] = useState<Set<string>>(new Set());

  // Fetch existing lists on mount.
  useEffect(() => {
    setLoadingLists(true);
    fetch(`/api/manifest/${tenantSlug}/cold-lists`)
      .then((r) => r.json())
      .then((data: { ok: boolean; lists?: ColdList[] }) => {
        if (data.ok && data.lists) setLists(data.lists);
      })
      .catch(() => {/* non-fatal */})
      .finally(() => setLoadingLists(false));
  }, [tenantSlug]);

  // Parse CSV whenever text changes.
  useEffect(() => {
    if (!csvText.trim()) {
      setParsed(null);
      setMapping([]);
      return;
    }
    const result = parseCsv(csvText);
    setParsed(result);
    setMapping(result.headers.map(autoDetectField));
  }, [csvText]);

  // Derived: applied rows after mapping.
  const mappedRows = useMemo(() => {
    if (!parsed || parsed.headers.length === 0) return [];
    return applyMapping(parsed.headers, parsed.rows, mapping);
  }, [parsed, mapping]);

  // Derived: rows that have at least one contact vector.
  const validRows = useMemo(
    () => mappedRows.filter((r) => r.email || r.phone),
    [mappedRows],
  );

  async function handleFileUpload(file: File) {
    const text = await file.text();
    setCsvText(text);
    setImportResult(null);
    setImportError(null);
  }

  async function doImport() {
    if (!selectedListId || validRows.length === 0) return;
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const res = await fetch(
        `/api/manifest/${tenantSlug}/cold-lists/${selectedListId}/import`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rows: validRows }),
        },
      );
      const data = (await res.json()) as ImportResult;
      if (!data.ok) {
        setImportError(data.error ?? `http_${res.status}`);
      } else {
        setImportResult(data);
        // Update local list row_count.
        setLists((prev) =>
          prev.map((l) =>
            l.id === selectedListId
              ? { ...l, row_count: l.row_count + (data.inserted ?? 0) }
              : l,
          ),
        );
        // Load the stage view.
        void loadStageView(selectedListId);
      }
    } catch {
      setImportError("network_error");
    } finally {
      setImporting(false);
    }
  }

  const loadStageView = useCallback(
    async (listId: string) => {
      setLoadingStages(true);
      try {
        const res = await fetch(
          `/api/manifest/${tenantSlug}/cold-lists/${listId}/by-stage`,
        );
        const data = (await res.json()) as ByStageResponse;
        if (data.ok) setStageData(data);
      } catch {
        /* non-fatal */
      } finally {
        setLoadingStages(false);
      }
    },
    [tenantSlug],
  );

  // When operator selects a list that already has rows, load stage view.
  function handleListSelect(id: string) {
    setSelectedListId(id);
    setImportResult(null);
    setImportError(null);
    setStageData(null);
    const list = lists.find((l) => l.id === id);
    if (list && list.row_count > 0) {
      void loadStageView(id);
    }
  }

  function handleLeadPromoted(coldLeadId: string, warmLeadId: string) {
    setPromotedIds((prev) => new Set([...prev, coldLeadId]));
    // Refresh stage data to reflect the promotion.
    if (selectedListId) void loadStageView(selectedListId);
    void warmLeadId; // surfaced to parent on stage refresh
  }

  // Determine which stage rows to render in the main area.
  const filteredStages = useMemo(() => {
    if (!stageData) return null;
    if (!activeStage) return stageData.stages;
    const key = activeStage;
    return Object.fromEntries(
      Object.entries(stageData.stages).filter(([k]) => k === key),
    );
  }, [stageData, activeStage]);

  const selectedList = lists.find((l) => l.id === selectedListId) ?? null;

  return (
    <div className="space-y-6">
      {/* Header banner */}
      <div className="rounded-xl border border-bg-border bg-bg-elev/30 px-5 py-4">
        <div className="flex items-start gap-3">
          <Megaphone className="w-5 h-5 text-accent mt-0.5 shrink-0" />
          <div>
            <div className="font-bold text-fg text-sm">Cold List Import</div>
            <div className="text-xs text-fg-muted mt-1 leading-relaxed">
              Cold lists are stored separately from your warm pipeline. Promote individual
              leads to the warm pipeline only when you&apos;ve made contact.
            </div>
          </div>
        </div>
      </div>

      {/* Step 1 — Pick or create list */}
      <section className="rounded-xl border border-bg-border bg-bg-elev/40 p-5 space-y-3">
        <div className="font-bold text-fg text-sm flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent/20 text-accent text-[10px] font-bold">1</span>
          Pick or create a list
        </div>
        <ListPicker
          tenantSlug={tenantSlug}
          lists={lists}
          selectedId={selectedListId}
          onSelect={handleListSelect}
          onCreated={(list) => setLists((prev) => [list, ...prev])}
          loading={loadingLists}
        />
      </section>

      {/* Step 2 — Paste / upload CSV */}
      {selectedListId && (
        <section className="rounded-xl border border-bg-border bg-bg-elev/40 p-5 space-y-4">
          <div className="font-bold text-fg text-sm flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent/20 text-accent text-[10px] font-bold">2</span>
            Paste or upload CSV
          </div>

          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) void handleFileUpload(f);
            }}
          >
            <textarea
              value={csvText}
              onChange={(e) => {
                setCsvText(e.target.value);
                setImportResult(null);
                setImportError(null);
              }}
              placeholder={"business_name,contact_name,phone,email\nAcme Corp,John Smith,416-555-0100,john@acme.com"}
              spellCheck={false}
              rows={8}
              className="w-full rounded-lg border border-bg-border bg-bg-deep px-3 py-2 text-xs font-mono text-fg placeholder:text-fg-faint focus:border-accent/50 focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <label className="inline-flex items-center gap-2 text-xs text-fg-muted cursor-pointer hover:text-fg">
              <Upload className="w-3.5 h-3.5" />
              <span>Upload .csv</span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFileUpload(f);
                }}
              />
            </label>
            {csvText && (
              <button
                type="button"
                onClick={() => {
                  setCsvText("");
                  setImportResult(null);
                  setImportError(null);
                }}
                className="inline-flex items-center gap-1 text-xs text-fg-dim hover:text-rose-400"
              >
                <X className="w-3 h-3" /> Clear
              </button>
            )}
          </div>

          {/* Live row count preview */}
          {parsed && parsed.headers.length > 0 && (
            <div className="rounded-lg border border-accent/20 bg-accent/5 px-4 py-2.5 text-xs text-fg-muted leading-relaxed">
              <span className="font-semibold text-fg">{mappedRows.length}</span> rows detected
              {mappedRows.length !== validRows.length && (
                <span className="text-status-warm">
                  {" "}· {mappedRows.length - validRows.length} missing both email and phone will be skipped
                </span>
              )}
              {validRows.length > 0 && (
                <span className="text-status-engaged">
                  {" "}· <span className="font-semibold">{validRows.length}</span> will be imported
                </span>
              )}
            </div>
          )}

          {/* Column mapping UI */}
          {parsed && parsed.headers.length > 0 && (
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-wider text-fg-dim font-bold">
                Column mapping
              </div>
              <ColumnMapper headers={parsed.headers} mapping={mapping} onChange={setMapping} />
            </div>
          )}

          {/* Preview table */}
          {parsed && parsed.headers.length > 0 && validRows.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-bg-border">
              <table className="w-full text-xs">
                <thead className="bg-bg-elev/60 text-fg-dim text-[10px] uppercase tracking-wider">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-bold">Business</th>
                    <th className="px-3 py-1.5 text-left font-bold">Contact</th>
                    <th className="px-3 py-1.5 text-left font-bold">Phone</th>
                    <th className="px-3 py-1.5 text-left font-bold">Email</th>
                  </tr>
                </thead>
                <tbody>
                  {validRows.slice(0, 8).map((r, i) => (
                    <tr key={i} className="border-t border-bg-border">
                      <td className="px-3 py-1.5 text-fg font-medium">
                        {r.business_name || <span className="text-fg-dim">—</span>}
                      </td>
                      <td className="px-3 py-1.5 text-fg-muted">{r.contact_name || <span className="text-fg-dim">—</span>}</td>
                      <td className="px-3 py-1.5 text-fg-muted font-mono">{r.phone || <span className="text-fg-dim">—</span>}</td>
                      <td className="px-3 py-1.5 text-fg-muted font-mono">{r.email || <span className="text-fg-dim">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {validRows.length > 8 && (
                <div className="px-3 py-1.5 text-[11px] text-fg-dim italic border-t border-bg-border">
                  + {validRows.length - 8} more rows not shown
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* Step 3 — Submit */}
      {selectedListId && validRows.length > 0 && !importResult?.ok && (
        <section className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void doImport()}
            disabled={importing}
            className="btn-send inline-flex items-center gap-2 !px-5 !py-2 text-sm disabled:opacity-50"
          >
            {importing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <FileText className="w-4 h-4" />
            )}
            Import {validRows.length} contact{validRows.length === 1 ? "" : "s"} into {selectedList?.name}
          </button>
        </section>
      )}

      {/* Error */}
      {importError && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-400 inline-flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-bold">Import failed</div>
            <div className="text-xs mt-0.5">{importError}</div>
          </div>
        </div>
      )}

      {/* Import success summary */}
      {importResult?.ok && (
        <div className="rounded-xl border border-status-engaged/40 bg-status-engaged/10 p-4 space-y-2">
          <div className="flex items-center gap-2 text-status-engaged font-bold text-sm">
            <CheckCircle2 className="w-4 h-4" /> Import complete
          </div>
          <div className="grid sm:grid-cols-3 gap-3 text-sm">
            <ImportStat label="Inserted" value={importResult.inserted ?? 0} tone="text-status-engaged" />
            <ImportStat label="Skipped (no contact)" value={importResult.skipped ?? 0} tone="text-status-warm" />
            <ImportStat label="Duplicates" value={importResult.duplicates ?? 0} tone="text-accent" />
          </div>
        </div>
      )}

      {/* Step 4 — Arcadian chevron stage view */}
      {(stageData || loadingStages) && (
        <section className="space-y-4">
          <div className="font-bold text-fg text-sm flex items-center gap-2">
            <Users className="w-4 h-4 text-accent" />
            {stageData?.list.name ?? "Cold list"} — by stage
          </div>

          {loadingStages && !stageData ? (
            <div className="flex items-center gap-2 text-fg-muted text-sm">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading stage view…
            </div>
          ) : stageData ? (
            <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-4">
              {/* Chevron rail */}
              <ColdChevronRail
                stages={stageData.stages}
                activeStage={activeStage}
                onSelect={setActiveStage}
              />

              {/* Stage sections */}
              <div className="space-y-3">
                {filteredStages && Object.entries(filteredStages).map(([key, group]) => (
                  <StageSection
                    key={key}
                    stageKey={key}
                    group={group}
                    tenantSlug={tenantSlug}
                    onLeadPromoted={handleLeadPromoted}
                  />
                ))}
                {filteredStages &&
                  Object.values(filteredStages).every((g) => g.count === 0) && (
                    <div className="rounded-xl border border-bg-border bg-bg-deep/40 p-6 text-center text-sm text-fg-muted italic">
                      No contacts in this stage yet.
                    </div>
                  )}
              </div>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ImportStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border border-bg-border bg-bg-deep/60 p-3">
      <div className={`text-2xl font-bold ${tone ?? "text-fg"}`}>
        {value.toLocaleString()}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-fg-dim mt-0.5">{label}</div>
    </div>
  );
}
