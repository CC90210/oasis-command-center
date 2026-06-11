"use client";

/**
 * LendersDirectoryClient — Phase 7 of the SunBiz Jordan/Oasis 2026-05-23 restructure.
 *
 * Lender knowledge-base directory: buy rates, match gates, restricted states,
 * required documents, and all the metadata the shop-out engine uses to rank
 * and filter lenders per application.
 *
 * Data routes:
 *   GET    /api/manifest/sun/records/lender?limit=500
 *   POST   /api/manifest/sun/records/lender           body: { data: {...} }
 *   PATCH  /api/manifest/sun/records/lender?id=<id>   body: { patch: {...} }
 *   DELETE /api/manifest/sun/records/lender?id=<id>
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatMoney, relTime } from "@/lib/format-helpers";
import { Landmark, Loader2, Plus, Save, Trash2, X } from "lucide-react";

/* -------------------------------------------------------------------------- */
/* Types                                                                        */
/* -------------------------------------------------------------------------- */

type LenderRecord = {
  id: string;
  data: Record<string, unknown>;
  updated_at: string;
};

/** Typed view of the lender JSONB data block. */
type LenderData = {
  name: string;
  contact: string;
  product_type: string;
  min_monthly_revenue: number | null;
  max_funded_amount: number | null;
  min_time_in_business_months: number | null;
  fico_floor: number | null;
  sla_response_days: number | null;
  notes: string;
  portal_url: string;
  buy_rate_avg: number | null;
  funding_range_min: number | null;
  funding_range_max: number | null;
  term_range_min_months: number | null;
  term_range_max_months: number | null;
  industry_preferences: string[];
  restricted_industries: string[];
  restricted_states: string[];
  required_documents: string[];
  common_decline_reasons: string[];
  active: boolean;
  last_updated: string;
  // SOP §1 hard requirements (2026-05-31). Operator-fillable from this
  // drawer; the shop_list filter + match-fitness scorer key off these.
  tier: string;
  paper_grades: string[];
  position_min: number | null;
  position_max: number | null;
  defaults_policy: string;
  max_negative_days: number | null;
  submission_cc_emails: string[];
  reverses_only: boolean;
};

const TIER_OPTIONS = [
  { value: "", label: "—" },
  { value: "A", label: "A — Premium box" },
  { value: "B", label: "B — Workhorse" },
  { value: "C", label: "C — Stacking-tolerant" },
  { value: "D", label: "D — Sub-prime" },
  { value: "Micro", label: "Micro" },
] as const;

const PAPER_GRADE_OPTIONS = [
  { value: "A", label: "A" },
  { value: "B", label: "B" },
  { value: "C", label: "C" },
  { value: "D", label: "D" },
  { value: "JUNK", label: "JUNK" },
] as const;

const DEFAULTS_POLICY_OPTIONS = [
  { value: "", label: "—" },
  { value: "none", label: "None — no defaults accepted" },
  { value: "satisfied_only", label: "Satisfied only" },
  { value: "accepts", label: "Accepts (any)" },
] as const;

const PRODUCT_TYPES = [
  { value: "same_day_funding", label: "Same-day funding" },
  { value: "mca", label: "MCA" },
  { value: "term_loan", label: "Term loan" },
  { value: "long_term_loan", label: "Long-term loan" },
  { value: "line_of_credit", label: "Line of credit" },
  { value: "equipment", label: "Equipment" },
  { value: "invoice_factoring", label: "Invoice factoring" },
  { value: "sba", label: "SBA" },
] as const;

const REQUIRED_DOCUMENT_OPTIONS = [
  { value: "bank_statements_3mo", label: "Bank statements (3 mo)" },
  { value: "drivers_license", label: "Driver's licence" },
  { value: "void_cheque", label: "Void cheque" },
  { value: "signed_application", label: "Signed application" },
  { value: "second_application_form", label: "2nd application form" },
  { value: "underwriting_docs", label: "Underwriting docs" },
  { value: "portal_docs", label: "Portal docs" },
  { value: "proof_of_ownership", label: "Proof of ownership" },
  { value: "business_license", label: "Business licence" },
  { value: "tax_returns", label: "Tax returns" },
] as const;

/* -------------------------------------------------------------------------- */
/* Data coercion helpers                                                        */
/* -------------------------------------------------------------------------- */

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function arr(v: unknown): string[] {
  return Array.isArray(v) ? (v as unknown[]).map((x) => String(x)) : [];
}

function bool(v: unknown): boolean {
  return v !== false && v !== 0 && v !== "false";
}

function toLenderData(raw: Record<string, unknown>): LenderData {
  return {
    name: str(raw.name),
    contact: str(raw.contact),
    product_type: str(raw.product_type),
    min_monthly_revenue: num(raw.min_monthly_revenue),
    max_funded_amount: num(raw.max_funded_amount),
    min_time_in_business_months: num(raw.min_time_in_business_months),
    fico_floor: num(raw.fico_floor),
    sla_response_days: num(raw.sla_response_days),
    notes: str(raw.notes),
    portal_url: str(raw.portal_url),
    buy_rate_avg: num(raw.buy_rate_avg),
    funding_range_min: num(raw.funding_range_min),
    funding_range_max: num(raw.funding_range_max),
    term_range_min_months: num(raw.term_range_min_months),
    term_range_max_months: num(raw.term_range_max_months),
    industry_preferences: arr(raw.industry_preferences),
    restricted_industries: arr(raw.restricted_industries),
    restricted_states: arr(raw.restricted_states),
    required_documents: arr(raw.required_documents),
    common_decline_reasons: arr(raw.common_decline_reasons),
    active: bool(raw.active),
    last_updated: str(raw.last_updated),
    tier: str(raw.tier),
    paper_grades: arr(raw.paper_grades),
    position_min: num(raw.position_min),
    position_max: num(raw.position_max),
    defaults_policy: str(raw.defaults_policy),
    max_negative_days: num(raw.max_negative_days),
    submission_cc_emails: arr(raw.submission_cc_emails),
    reverses_only: raw.reverses_only === true,
  };
}

const BLANK_DATA: LenderData = {
  name: "",
  contact: "",
  product_type: "",
  min_monthly_revenue: null,
  max_funded_amount: null,
  min_time_in_business_months: null,
  fico_floor: null,
  sla_response_days: null,
  notes: "",
  portal_url: "",
  buy_rate_avg: null,
  funding_range_min: null,
  funding_range_max: null,
  term_range_min_months: null,
  term_range_max_months: null,
  industry_preferences: [],
  restricted_industries: [],
  restricted_states: [],
  required_documents: [],
  common_decline_reasons: [],
  active: true,
  last_updated: "",
  tier: "",
  paper_grades: [],
  position_min: null,
  position_max: null,
  defaults_policy: "",
  max_negative_days: null,
  submission_cc_emails: [],
  reverses_only: false,
};

/* -------------------------------------------------------------------------- */
/* Main export                                                                  */
/* -------------------------------------------------------------------------- */

export function LendersDirectoryClient({
  tenantSlug,
  tenantId,
}: {
  tenantSlug: string;
  tenantId: string | null;
}) {
  const [records, setRecords] = useState<LenderRecord[] | null>(null);
  const [search, setSearch] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [productFilter, setProductFilter] = useState<string[]>([]);

  // Drawer state: null = closed, "new" = create, record id = edit.
  const [drawerTarget, setDrawerTarget] = useState<string | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/manifest/${tenantSlug}/records/lender?limit=500`, {
        credentials: "include",
      });
      const json = await res.json();
      setRecords((json.records || json.rows || []) as LenderRecord[]);
    } catch {
      setRecords([]);
    }
  }, [tenantSlug]);

  useEffect(() => {
    if (!tenantId) {
      // Preview mode — render the empty directory scaffold instead of a
      // stub Card so operators see the table chrome + columns + filters
      // they'll see once they own the tenant.
      setRecords([]);
      return;
    }
    load();
  }, [tenantId, load]);

  /** Inline active toggle — PATCHes a single field without opening the drawer. */
  const patchActive = useCallback(
    async (id: string, active: boolean) => {
      // Optimistic update
      setRecords((prev) =>
        prev
          ? prev.map((r) =>
              r.id === id ? { ...r, data: { ...r.data, active } } : r,
            )
          : prev,
      );
      try {
        await fetch(`/api/manifest/${tenantSlug}/records/lender?id=${id}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patch: { active } }),
        });
      } catch {
        // Revert on failure
        await load();
      }
    },
    [tenantSlug, load],
  );

  const visible = useMemo(() => {
    if (!records) return [];
    const needle = search.trim().toLowerCase();
    return records.filter((r) => {
      if (activeOnly && !bool(r.data.active)) return false;
      if (productFilter.length > 0 && !productFilter.includes(str(r.data.product_type))) {
        return false;
      }
      if (!needle) return true;
      const haystack = [
        r.data.name,
        r.data.product_type,
        ...(Array.isArray(r.data.restricted_states) ? (r.data.restricted_states as unknown[]) : []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [records, search, activeOnly, productFilter]);

  const openRecord = records?.find((r) => r.id === drawerTarget) ?? null;

  /* Preview-mode bail removed 2026-05-25 — operator viewing a tenant
     they don't own now sees the same empty directory scaffold a real
     owner would see on day one. Records is set to [] in the effect
     above; the empty-state path handles the no-data render. */

  return (
    <div className="space-y-5">
      {/* Catch-all dispatcher renders the page title + subtitle. No
          inner PageHeader here — was duplicating 2026-05-24. */}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, product type, state…"
          className="flex-1 min-w-[180px] text-[12.5px] px-3 py-2 rounded-md bg-bg-deep border border-bg-border text-fg placeholder:text-fg-dim"
        />
        <FilterChips
          activeOnly={activeOnly}
          onActiveToggle={() => setActiveOnly((v) => !v)}
          productFilter={productFilter}
          onProductToggle={(pt) =>
            setProductFilter((prev) =>
              prev.includes(pt) ? prev.filter((x) => x !== pt) : [...prev, pt],
            )
          }
        />
        <button
          type="button"
          onClick={() => setDrawerTarget("new")}
          className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold px-3 py-2 rounded-md bg-accent text-bg-deep"
        >
          <Plus className="w-3.5 h-3.5" />
          New lender
        </button>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-bg-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-bg-border bg-bg-elev/60">
                {["Name", "Buy rate", "Funding range", "Term range", "Restricted", "Active", "Updated"].map(
                  (h) => (
                    <th
                      key={h}
                      className="px-3 py-2.5 text-left text-[10px] uppercase tracking-wider text-fg-dim font-semibold whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-bg-border">
              {records === null ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-xs text-fg-dim italic">
                    <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                    Loading lenders…
                  </td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-xs text-fg-dim italic">
                    {records.length === 0
                      ? "No lenders yet. Add your first one to start matching deals."
                      : "No lenders match the current filters."}
                  </td>
                </tr>
              ) : (
                visible.map((r) => (
                  <LenderRow
                    key={r.id}
                    record={r}
                    onOpen={() => setDrawerTarget(r.id)}
                    onActiveToggle={(active) => patchActive(r.id, active)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail drawer */}
      {drawerTarget !== null && (
        <LenderDrawer
          tenantSlug={tenantSlug}
          mode={drawerTarget === "new" ? "create" : "edit"}
          record={openRecord}
          onClose={() => setDrawerTarget(null)}
          onSaved={() => {
            setDrawerTarget(null);
            load();
          }}
          onDeleted={() => {
            setDrawerTarget(null);
            load();
          }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Filter chips                                                                 */
/* -------------------------------------------------------------------------- */

function FilterChips({
  activeOnly,
  onActiveToggle,
  productFilter,
  onProductToggle,
}: {
  activeOnly: boolean;
  onActiveToggle: () => void;
  productFilter: string[];
  onProductToggle: (pt: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onActiveToggle}
        className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors ${
          activeOnly
            ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
            : "bg-bg-deep text-fg-muted border-bg-border"
        }`}
      >
        Active only
      </button>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors ${
          productFilter.length > 0
            ? "bg-accent/10 text-accent border-accent/30"
            : "bg-bg-deep text-fg-muted border-bg-border"
        }`}
      >
        Product type{productFilter.length > 0 ? ` (${productFilter.length})` : ""}
      </button>
      {expanded && (
        <div className="flex flex-wrap gap-1.5 w-full mt-1">
          {PRODUCT_TYPES.map((pt) => {
            const on = productFilter.includes(pt.value);
            return (
              <button
                key={pt.value}
                type="button"
                onClick={() => onProductToggle(pt.value)}
                className={`text-[10.5px] px-2 py-0.5 rounded-full border transition-colors ${
                  on
                    ? "bg-accent/10 text-accent border-accent/30"
                    : "bg-bg-deep text-fg-dim border-bg-border"
                }`}
              >
                {pt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Table row                                                                    */
/* -------------------------------------------------------------------------- */

function LenderRow({
  record,
  onOpen,
  onActiveToggle,
}: {
  record: LenderRecord;
  onOpen: () => void;
  onActiveToggle: (active: boolean) => void;
}) {
  const d = record.data;
  const active = bool(d.active);
  const name = str(d.name) || "(unnamed)";
  const buyRate = num(d.buy_rate_avg);
  const fundingMin = num(d.funding_range_min);
  const fundingMax = num(d.funding_range_max);
  const termMin = num(d.term_range_min_months);
  const termMax = num(d.term_range_max_months);
  const restrictedStates = arr(d.restricted_states);

  const fundingRange =
    fundingMin != null || fundingMax != null
      ? `${fundingMin != null ? formatMoney(fundingMin) : "?"} – ${fundingMax != null ? formatMoney(fundingMax) : "?"}`
      : "—";

  const termRange =
    termMin != null || termMax != null
      ? `${termMin ?? "?"}–${termMax ?? "?"} mo`
      : "—";

  return (
    <tr
      className="hover:bg-bg-elev/40 cursor-pointer transition-colors"
      onClick={onOpen}
    >
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Landmark className="w-3.5 h-3.5 text-fg-dim shrink-0" />
          <div>
            <div className="font-semibold text-fg truncate max-w-[180px]">{name}</div>
            {str(d.product_type) && (
              <div className="text-[11px] text-fg-dim capitalize">
                {str(d.product_type).replace(/_/g, " ")}
              </div>
            )}
          </div>
        </div>
      </td>
      <td className="px-3 py-2.5 text-fg font-mono whitespace-nowrap">
        {buyRate != null ? `${buyRate.toFixed(2)}%` : "—"}
      </td>
      <td className="px-3 py-2.5 text-fg-muted whitespace-nowrap">{fundingRange}</td>
      <td className="px-3 py-2.5 text-fg-muted whitespace-nowrap">{termRange}</td>
      <td className="px-3 py-2.5">
        {restrictedStates.length > 0 ? (
          <span className="inline-block text-[10.5px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-300 border border-red-500/25 font-medium whitespace-nowrap">
            {restrictedStates.length} state{restrictedStates.length === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="text-fg-dim text-[11px]">none</span>
        )}
      </td>
      <td
        className="px-3 py-2.5"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          role="switch"
          aria-checked={active}
          onClick={() => onActiveToggle(!active)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors border ${
            active
              ? "bg-emerald-500/20 border-emerald-500/40"
              : "bg-slate-700/40 border-slate-600/40"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full shadow transition-transform ${
              active
                ? "translate-x-4 bg-emerald-400"
                : "translate-x-0.5 bg-slate-400"
            }`}
          />
        </button>
      </td>
      <td className="px-3 py-2.5 text-[11px] text-fg-dim whitespace-nowrap">
        {relTime(record.updated_at)}
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- */
/* Detail drawer                                                                */
/* -------------------------------------------------------------------------- */

type DrawerMode = "create" | "edit";

function LenderDrawer({
  tenantSlug,
  mode,
  record,
  onClose,
  onSaved,
  onDeleted,
}: {
  tenantSlug: string;
  mode: DrawerMode;
  record: LenderRecord | null;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [form, setForm] = useState<LenderData>(() =>
    record ? toLenderData(record.data) : { ...BLANK_DATA },
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Esc to close + body scroll lock
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeBtnRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const set = <K extends keyof LenderData>(key: K, value: LenderData[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    if (!form.name.trim()) {
      setError("Lender name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const data: Record<string, unknown> = { ...form, last_updated: new Date().toISOString() };
      let res: Response;
      if (mode === "create") {
        res = await fetch(`/api/manifest/${tenantSlug}/records/lender`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data }),
        });
      } else {
        res = await fetch(`/api/manifest/${tenantSlug}/records/lender?id=${record!.id}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patch: data }),
        });
      }
      const json = await res.json();
      if (!res.ok || json.error) {
        setError(json.error || `save_failed_${res.status}`);
        return;
      }
      onSaved();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setSaving(false);
    }
  };

  const destroy = async () => {
    if (!record) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/manifest/${tenantSlug}/records/lender?id=${record.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok && json.error) {
        setError(json.error || `delete_failed_${res.status}`);
        setConfirmDelete(false);
        return;
      }
      onDeleted();
    } catch (e) {
      setError(String((e as Error).message || e));
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-label={mode === "create" ? "New lender" : `Edit ${form.name || "lender"}`}
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close drawer"
        onClick={onClose}
        className="flex-1 bg-black/60 backdrop-blur-sm cursor-default"
      />

      <aside className="relative w-full sm:w-[560px] h-full bg-bg-elev border-l border-bg-border shadow-[-12px_0_32px_-8px_rgba(0,0,0,0.6)] flex flex-col">
        {/* Header */}
        <header className="px-5 py-4 border-b border-bg-border flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Landmark className="w-4 h-4 text-fg-dim shrink-0" />
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-fg-dim font-semibold">
                {mode === "create" ? "New lender" : "Edit lender"}
              </div>
              <h2 className="text-base font-bold text-fg truncate leading-tight">
                {form.name || (mode === "create" ? "Untitled" : "(unnamed)")}
              </h2>
            </div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md text-fg-muted hover:text-fg hover:bg-bg-deep shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6 text-[12.5px]">
          {error && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2.5 text-[12px] text-red-200">
              {error}
            </div>
          )}

          {/* Section 1: Identity */}
          <Section label="Identity">
            <Field label="Lender name *">
              <TextInput
                value={form.name}
                onChange={(v) => set("name", v)}
                placeholder="e.g. Credibly"
              />
            </Field>
            <Field label="Contact email">
              <TextInput
                value={form.contact}
                onChange={(v) => set("contact", v)}
                placeholder="underwriting@lender.com"
                type="email"
              />
            </Field>
            <Field label="Portal URL">
              <TextInput
                value={form.portal_url}
                onChange={(v) => set("portal_url", v)}
                placeholder="https://portal.lender.com"
                type="url"
              />
            </Field>
            <Field label="Product type">
              <select
                value={form.product_type}
                onChange={(e) => set("product_type", e.target.value)}
                className="w-full px-2 py-1.5 rounded-md bg-bg-deep border border-bg-border text-fg text-[12.5px]"
              >
                <option value="">— Select —</option>
                {PRODUCT_TYPES.map((pt) => (
                  <option key={pt.value} value={pt.value}>
                    {pt.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Active">
              <ToggleSwitch
                value={form.active}
                onChange={(v) => set("active", v)}
                labelOn="Active"
                labelOff="Inactive"
              />
            </Field>
          </Section>

          {/* Section 2: Match gates */}
          <Section label="Match gates">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Min monthly revenue ($)">
                <NumberInput
                  value={form.min_monthly_revenue}
                  onChange={(v) => set("min_monthly_revenue", v)}
                  placeholder="10000"
                />
              </Field>
              <Field label="Max funded amount ($)">
                <NumberInput
                  value={form.max_funded_amount}
                  onChange={(v) => set("max_funded_amount", v)}
                  placeholder="500000"
                />
              </Field>
              <Field label="Min time in business (mo)">
                <NumberInput
                  value={form.min_time_in_business_months}
                  onChange={(v) => set("min_time_in_business_months", v)}
                  placeholder="6"
                />
              </Field>
              <Field label="FICO floor">
                <NumberInput
                  value={form.fico_floor}
                  onChange={(v) => set("fico_floor", v)}
                  placeholder="550"
                />
              </Field>
              <Field label="SLA response (days)">
                <NumberInput
                  value={form.sla_response_days}
                  onChange={(v) => set("sla_response_days", v)}
                  placeholder="2"
                />
              </Field>
            </div>
          </Section>

          {/* Section 2b: SOP §1 hard requirements — the structured fields
              the shop_list filter + match-fitness scorer key off. Tier
              is informational; paper_grades + position range + defaults
              policy + max_negative_days are the actual filter gates;
              reverses_only flags reverse-consolidation specialists. */}
          <Section label="SOP §1 hard requirements">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Tier">
                <select
                  value={form.tier}
                  onChange={(e) => set("tier", e.target.value)}
                  className="w-full px-2 py-1.5 rounded-md bg-bg-deep border border-bg-border text-fg text-[12.5px]"
                >
                  {TIER_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Defaults policy">
                <select
                  value={form.defaults_policy}
                  onChange={(e) => set("defaults_policy", e.target.value)}
                  className="w-full px-2 py-1.5 rounded-md bg-bg-deep border border-bg-border text-fg text-[12.5px]"
                >
                  {DEFAULTS_POLICY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Position min (1 = 1st)">
                <NumberInput
                  value={form.position_min}
                  onChange={(v) => set("position_min", v)}
                  placeholder="1"
                />
              </Field>
              <Field label="Position max (0 = no cap)">
                <NumberInput
                  value={form.position_max}
                  onChange={(v) => set("position_max", v)}
                  placeholder="5"
                />
              </Field>
              <Field label="Max negative days">
                <NumberInput
                  value={form.max_negative_days}
                  onChange={(v) => set("max_negative_days", v)}
                  placeholder="5"
                />
              </Field>
              <Field label="Reverses only">
                <ToggleSwitch
                  value={form.reverses_only}
                  onChange={(v) => set("reverses_only", v)}
                  labelOn="Reverses only"
                  labelOff="Fresh capital OK"
                />
              </Field>
            </div>
            <Field label="Paper grades accepted">
              <MultiSelect
                options={PAPER_GRADE_OPTIONS}
                value={form.paper_grades}
                onChange={(v) => set("paper_grades", v)}
              />
            </Field>
            <Field label="Submission CC emails">
              <TagInput
                tags={form.submission_cc_emails}
                onChange={(v) => set("submission_cc_emails", v)}
                placeholder="e.g. submissions@lender.com, paul@…"
              />
            </Field>
          </Section>

          {/* Section 3: Buy rate & range */}
          <Section label="Buy rate & range">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Buy rate avg (%)">
                <NumberInput
                  value={form.buy_rate_avg}
                  onChange={(v) => set("buy_rate_avg", v)}
                  placeholder="1.35"
                  step="0.01"
                />
              </Field>
              <div /> {/* spacer */}
              <Field label="Funding min ($)">
                <NumberInput
                  value={form.funding_range_min}
                  onChange={(v) => set("funding_range_min", v)}
                  placeholder="5000"
                />
              </Field>
              <Field label="Funding max ($)">
                <NumberInput
                  value={form.funding_range_max}
                  onChange={(v) => set("funding_range_max", v)}
                  placeholder="500000"
                />
              </Field>
              <Field label="Term min (months)">
                <NumberInput
                  value={form.term_range_min_months}
                  onChange={(v) => set("term_range_min_months", v)}
                  placeholder="3"
                />
              </Field>
              <Field label="Term max (months)">
                <NumberInput
                  value={form.term_range_max_months}
                  onChange={(v) => set("term_range_max_months", v)}
                  placeholder="24"
                />
              </Field>
            </div>
          </Section>

          {/* Section 4: Restrictions & preferences */}
          <Section label="Restrictions & preferences">
            <Field label="Industry preferences">
              <TagInput
                tags={form.industry_preferences}
                onChange={(v) => set("industry_preferences", v)}
                placeholder="e.g. restaurants, retail…"
              />
            </Field>
            <Field label="Industry restrictions">
              <TagInput
                tags={form.restricted_industries}
                onChange={(v) => set("restricted_industries", v)}
                placeholder="e.g. cannabis, adult…"
              />
            </Field>
            <Field label="Restricted states (codes)">
              <TagInput
                tags={form.restricted_states}
                onChange={(v) => set("restricted_states", v)}
                placeholder="e.g. CA, NY, IL…"
                transform={(s) => s.toUpperCase()}
                chipClass="bg-red-500/15 text-red-300 border-red-500/25"
              />
            </Field>
            <Field label="Required documents">
              <MultiSelect
                options={REQUIRED_DOCUMENT_OPTIONS}
                value={form.required_documents}
                onChange={(v) => set("required_documents", v)}
              />
            </Field>
            <Field label="Common decline reasons">
              <TagInput
                tags={form.common_decline_reasons}
                onChange={(v) => set("common_decline_reasons", v)}
                placeholder="e.g. too many NSFs, short TIB…"
              />
            </Field>
          </Section>

          {/* Section 5: Notes */}
          <Section label="Notes">
            <textarea
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="Internal notes about this lender — underwriting quirks, contact preferences, etc."
              rows={5}
              maxLength={2000}
              className="w-full text-[12.5px] px-3 py-2 rounded-md bg-bg-deep border border-bg-border text-fg resize-none"
            />
            <div className="text-[11px] text-fg-dim text-right mt-1">
              {form.notes.length}/2000
            </div>
          </Section>
        </div>

        {/* Footer */}
        <footer className="px-5 py-4 border-t border-bg-border bg-bg-elev/40 flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 text-[12.5px] font-semibold px-4 py-2 rounded-md bg-accent text-bg-deep disabled:opacity-40"
          >
            {saving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            {saving ? "Saving…" : "Save"}
          </button>

          {mode === "edit" && (
            confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-[11.5px] text-red-300">Confirm delete?</span>
                <button
                  type="button"
                  onClick={destroy}
                  disabled={deleting}
                  className="inline-flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-md bg-red-500/20 text-red-200 border border-red-500/30 disabled:opacity-40"
                >
                  {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                  {deleting ? "Deleting…" : "Yes, delete"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="text-[11.5px] text-fg-muted hover:text-fg"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="inline-flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-md border border-bg-border text-fg-muted hover:text-red-300 hover:border-red-500/30"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </button>
            )
          )}

          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-[12px] text-fg-muted hover:text-fg"
          >
            Close
          </button>
        </footer>
      </aside>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Small reusable form primitives                                               */
/* -------------------------------------------------------------------------- */

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="text-[10px] uppercase tracking-wider text-fg-dim font-semibold border-b border-bg-border pb-1.5">
        {label}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="block text-[11px] text-fg-muted">{label}</label>
      {children}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "email" | "url";
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full text-[12.5px] px-2 py-1.5 rounded-md bg-bg-deep border border-bg-border text-fg placeholder:text-fg-dim"
    />
  );
}

function NumberInput({
  value,
  onChange,
  placeholder,
  step,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  step?: string;
}) {
  return (
    <input
      type="number"
      value={value ?? ""}
      onChange={(e) => {
        const n = Number(e.target.value);
        onChange(e.target.value === "" ? null : Number.isFinite(n) ? n : null);
      }}
      placeholder={placeholder}
      step={step ?? "1"}
      className="w-full text-[12.5px] px-2 py-1.5 rounded-md bg-bg-deep border border-bg-border text-fg placeholder:text-fg-dim"
    />
  );
}

function ToggleSwitch({
  value,
  onChange,
  labelOn,
  labelOff,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  labelOn: string;
  labelOff: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors border ${
          value
            ? "bg-emerald-500/20 border-emerald-500/40"
            : "bg-slate-700/40 border-slate-600/40"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full shadow transition-transform ${
            value ? "translate-x-4 bg-emerald-400" : "translate-x-0.5 bg-slate-400"
          }`}
        />
      </button>
      <span className={`text-[12px] font-medium ${value ? "text-emerald-300" : "text-fg-muted"}`}>
        {value ? labelOn : labelOff}
      </span>
    </div>
  );
}

/**
 * Multi-tag input: type text and press Enter or comma to add a chip.
 * Backspace on empty input removes the last tag.
 */
function TagInput({
  tags,
  onChange,
  placeholder,
  transform,
  chipClass,
}: {
  tags: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  transform?: (s: string) => string;
  chipClass?: string;
}) {
  const [input, setInput] = useState("");

  const commit = (raw: string) => {
    const trimmed = (transform ? transform(raw.trim()) : raw.trim());
    if (!trimmed || tags.includes(trimmed)) return;
    onChange([...tags, trimmed]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(input);
      setInput("");
    } else if (e.key === "Backspace" && input === "" && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };

  const onBlur = () => {
    if (input.trim()) {
      commit(input);
      setInput("");
    }
  };

  const defaultChip = "bg-bg-deep text-fg-muted border-bg-border";

  return (
    <div className="flex flex-wrap gap-1.5 px-2 py-1.5 rounded-md bg-bg-deep border border-bg-border min-h-[36px]">
      {tags.map((tag) => (
        <span
          key={tag}
          className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${chipClass ?? defaultChip}`}
        >
          {tag}
          <button
            type="button"
            onClick={() => onChange(tags.filter((t) => t !== tag))}
            className="opacity-60 hover:opacity-100"
            aria-label={`Remove ${tag}`}
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        placeholder={tags.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[80px] bg-transparent text-[12px] text-fg outline-none placeholder:text-fg-dim"
      />
    </div>
  );
}

/**
 * Multi-select from a fixed option list: clicking an option toggles it.
 */
function MultiSelect({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const toggle = (opt: string) =>
    onChange(value.includes(opt) ? value.filter((x) => x !== opt) : [...value, opt]);

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => toggle(o.value)}
            className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
              on
                ? "bg-accent/10 text-accent border-accent/30"
                : "bg-bg-deep text-fg-dim border-bg-border hover:text-fg-muted"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
