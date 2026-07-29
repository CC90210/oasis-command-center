"use client";

/**
 * RecordFundedDeal — manual funded-deal entry, the intake behind the Renewals tab.
 *
 * Phase 1 of activating renewals. The tab itself has been built and wired for a
 * while; it had nothing to show because nothing ever wrote a funded deal. This
 * is that write path.
 *
 * Deliberately five fields plus two optional ones. The operator does NOT enter a
 * renewal date or a commission figure — both are derived server-side from the
 * term and the points, so they cannot drift and nobody has to remember to
 * update them. The preview below the form shows what will be computed, so the
 * derivation is visible rather than magic.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/Card";
import {
  ArrowLeft,
  Building2,
  CalendarPlus,
  Check,
  ChevronRight,
  Clock3,
  Loader2,
  Search,
} from "lucide-react";
import { nextRenewalDate, estCommissionUsd } from "@/lib/renewals/derive";

type FieldErrors = Record<string, string>;

const EMPTY = {
  lead_id: "",
  merchant_name: "",
  contact_name: "",
  lender_name: "",
  funded_amount_usd: "",
  term_months: "",
  factor_rate: "",
  points_pct: "",
  funded_at: "",
  notes: "",
};

type LeadOption = {
  id: string;
  business_name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  stage: string | null;
  amount_requested: number | null;
  updated_at: string;
};

const inputCls =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg " +
  "placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent";
const labelCls = "block text-[11px] uppercase tracking-[0.12em] text-fg-muted font-bold mb-1.5";

function toNum(v: string): number | null {
  const cleaned = v.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function fmtRelativeDate(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  const days = Math.max(0, Math.floor(elapsed / 86_400_000));
  if (days === 0) return "Updated today";
  if (days === 1) return "Updated yesterday";
  if (days < 7) return `Updated ${days} days ago`;
  return `Updated ${new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function titleCase(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function RecordFundedDeal() {
  const router = useRouter();
  const [form, setForm] = useState({ ...EMPTY });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  /** Armed when the server flags a possible duplicate; the next submit overrides. */
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [leadQuery, setLeadQuery] = useState("");
  const [leadResults, setLeadResults] = useState<LeadOption[]>([]);
  const [selectedLead, setSelectedLead] = useState<LeadOption | null>(null);
  const [searching, setSearching] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setErrors((prev) => (prev[k] ? { ...prev, [k]: "" } : prev));
    // Editing after a duplicate warning means this may no longer be the same
    // deal — re-arm the check rather than carrying a stale override.
    setConfirmDuplicate(false);
  };

  // Live preview of the two derived fields, using the SAME functions the server
  // uses — so what the operator sees here is what gets stored, not an estimate.
  const termNum = toNum(form.term_months);
  const previewRenewal = nextRenewalDate(form.funded_at || null, termNum);
  const previewCommission = estCommissionUsd(toNum(form.funded_amount_usd), toNum(form.points_pct));

  async function searchLeads(e?: React.FormEvent, query = leadQuery) {
    e?.preventDefault();
    setSearching(true);
    setFormError(null);
    try {
      const res = await fetch(`/api/renewals?q=${encodeURIComponent(query)}`);
      const json = await res.json();
      if (!res.ok || !json?.ok) throw new Error();
      setLeadResults(json.leads || []);
    } catch {
      setFormError("Could not search leads. Please try again.");
    } finally {
      setSearching(false);
    }
  }

  // Shopping-Out-style discovery: opening the control loads recent deals, and
  // typing filters continuously. There is no separate "Search" action.
  useEffect(() => {
    if (!pickerOpen || selectedLead) return;
    const timer = window.setTimeout(() => void searchLeads(undefined, leadQuery), leadQuery ? 180 : 0);
    return () => window.clearTimeout(timer);
    // searchLeads intentionally uses only the query passed above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadQuery, pickerOpen, selectedLead]);

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) setPickerOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, []);

  useEffect(() => {
    if (!selectedLead) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) clearLead();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [selectedLead, saving]);

  function chooseLead(lead: LeadOption) {
    setSelectedLead(lead);
    setPickerOpen(false);
    setLeadResults([]);
    setErrors({});
    setForm((current) => ({
      ...current,
      lead_id: lead.id,
      merchant_name: lead.business_name,
      contact_name: lead.contact_name || "",
    }));
  }

  function clearLead() {
    setSelectedLead(null);
    setLeadQuery("");
    setPickerOpen(true);
    setForm({ ...EMPTY });
    setSaved(null);
    setConfirmDuplicate(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    setFormError(null);
    setSaved(null);
    try {
      const res = await fetch("/api/renewals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Carry the operator's "yes, really" through on the second submit.
        body: JSON.stringify({ ...form, confirm_duplicate: confirmDuplicate }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        if (json?.errors) setErrors(json.errors as FieldErrors);
        // A flagged duplicate is a question, not a rejection — arm the next
        // submit to go through rather than making the operator find a workaround.
        if (res.status === 409 && json?.error === "possible_duplicate") {
          setConfirmDuplicate(true);
        }
        setFormError(
          json?.message ||
            (res.status === 403
              ? "You don't have permission to record funded deals."
              : json?.errors
                ? "Please fix the highlighted fields."
                : "Could not save the funded deal."),
        );
        return;
      }
      setSaved(json.deal?.merchant_name || form.merchant_name);
      setForm({ ...EMPTY });
      setSelectedLead(null);
      setLeadQuery("");
      setConfirmDuplicate(false);
      // The tab is a server component reading funded_deals — refresh so the new
      // row and the recalculated summary tiles appear without a manual reload.
      router.refresh();
    } catch {
      setFormError("Network error — the deal was not saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-fg-muted font-bold mb-4">
        <CalendarPlus size={12} className="text-accent" />
        <span>Record a funded deal</span>
      </div>
      {saved && !selectedLead && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-status-warm/30 bg-status-warm/10 px-4 py-3 text-sm text-status-warm" role="status">
          <Check size={15} /> Recorded {saved}. The renewal schedule is now active.
        </div>
      )}

      <form onSubmit={selectedLead ? submit : searchLeads} className="space-y-4">
        {!selectedLead ? (
          <div className="rounded-xl border border-border bg-bg-subtle/40 p-4 md:p-5">
            <div className="mb-4 flex items-start gap-3">
              <div className="rounded-lg bg-accent/10 p-2.5 text-accent"><Building2 size={19} /></div>
              <div>
                <div className="text-sm font-semibold text-fg">Choose the funded deal</div>
                <p className="mt-0.5 text-xs text-fg-muted">Start with a recent deal or type to find any lead in the CRM.</p>
              </div>
            </div>
            <div ref={pickerRef} className="relative">
              <label className={labelCls} htmlFor="fd-lead-search">Find a CRM deal</label>
              <div className={`rounded-xl border bg-bg shadow-sm transition ${pickerOpen ? "border-accent ring-2 ring-accent/20" : "border-border hover:border-fg-muted/50"}`}>
                <div className="relative">
                  <Search size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-muted" />
                  <input
                    id="fd-lead-search"
                    type="search"
                    autoComplete="off"
                    className="h-12 w-full rounded-xl bg-transparent pl-10 pr-11 text-sm text-fg outline-none placeholder:text-fg-muted"
                    value={leadQuery}
                    onFocus={() => setPickerOpen(true)}
                    onClick={() => setPickerOpen(true)}
                    onChange={(e) => { setLeadQuery(e.target.value); setPickerOpen(true); }}
                  placeholder="Search business, contact, phone, or email…"
                  role="combobox"
                  aria-expanded={pickerOpen}
                  aria-controls="renewal-lead-options"
                  />
                  {searching && <Loader2 size={16} className="absolute right-3.5 top-1/2 -translate-y-1/2 animate-spin text-accent" />}
                </div>
                <button
                  type="button"
                  onClick={() => searchLeads()}
                  disabled={searching}
                  className="sr-only"
                >
                  {searching ? "Searching…" : "Search"}
                </button>
              </div>
              </div>

            {pickerOpen && leadResults.length > 0 && (
              <div id="renewal-lead-options" role="listbox" className="absolute z-30 mt-2 max-h-[390px] w-full overflow-y-auto rounded-xl border border-border bg-bg p-1.5 shadow-2xl shadow-black/20">
                <div className="sticky top-0 z-10 mb-1 flex items-center justify-between rounded-lg bg-bg-subtle px-3 py-2">
                  <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.13em] text-fg-muted">
                    <Clock3 size={12} />{leadQuery ? "Matching deals" : "Most recent deals"}
                  </span>
                  <span className="text-[10px] tabular-nums text-fg-muted">{leadResults.length} shown</span>
                </div>
                {leadResults.map((lead) => (
                  <button
                    key={lead.id}
                    type="button"
                    onPointerDown={(event) => {
                      // Commit selection before any outside-click/focus handler
                      // can dismiss the option between pointer-down and click.
                      event.preventDefault();
                      chooseLead(lead);
                    }}
                    onClick={() => chooseLead(lead)}
                    className="group flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-accent/8 focus:bg-accent/8 focus:outline-none"
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-bg-subtle text-sm font-bold text-accent">
                      {lead.business_name.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                      <span className="truncate">{lead.business_name}</span>
                      {lead.stage && <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[9px] uppercase tracking-wide text-accent">{titleCase(lead.stage)}</span>}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-fg-muted">
                      {[lead.contact_name, lead.phone, lead.email].filter(Boolean).join(" · ") || "No contact details"}
                    </div>
                    <div className="mt-1 text-[10px] text-fg-muted">{fmtRelativeDate(lead.updated_at)}</div>
                    </div>
                    <ChevronRight size={16} className="shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
                  </button>
                ))}
              </div>
            )}
            {pickerOpen && !searching && leadResults.length === 0 && (
              <div className="absolute z-30 mt-2 w-full rounded-xl border border-border bg-bg px-5 py-9 text-center shadow-2xl">
                <Search size={22} className="mx-auto mb-2 text-fg-muted" />
                <div className="text-sm font-medium text-fg">{leadQuery ? "No matching deals" : "No recent deals yet"}</div>
                <p className="mt-1 text-xs text-fg-muted">{leadQuery ? "Try a business, contact, phone, or email." : "Start typing to search the CRM."}</p>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="fixed inset-0 z-[80] flex items-center justify-center p-3 sm:p-6" role="presentation">
              <button
                type="button"
                className="absolute inset-0 bg-black/65 backdrop-blur-sm"
                onClick={() => !saving && clearLead()}
                aria-label="Close funding details"
              />
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="renewal-deal-title"
                className="relative z-10 flex max-h-[94vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-bg-panel shadow-2xl shadow-black/40"
              >
                <header className="flex items-center justify-between border-b border-border bg-bg-subtle/70 px-5 py-4">
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-accent">New renewal deal</div>
                    <h2 id="renewal-deal-title" className="mt-1 text-lg font-semibold text-fg">Add funding details</h2>
                    <p className="mt-0.5 text-xs text-fg-muted">These terms determine when renewal outreach begins.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => !saving && clearLead()}
                    disabled={saving}
                    className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-fg-muted hover:bg-bg hover:text-fg disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </header>
                <div className="overflow-y-auto p-5 sm:p-6 space-y-5">
            <div className="flex items-center justify-between rounded-xl border border-accent/30 bg-accent/5 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-sm font-bold text-accent">
                  {selectedLead.business_name.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.12em] text-fg-muted font-bold">Selected lead</div>
                <div className="mt-0.5 truncate text-sm font-semibold text-fg">{selectedLead.business_name}</div>
                {selectedLead.contact_name && <div className="truncate text-xs text-fg-muted">{selectedLead.contact_name}</div>}
                </div>
              </div>
              <button type="button" onClick={clearLead} className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium text-fg-muted hover:bg-bg hover:text-fg" aria-label="Choose a different lead">
                <ArrowLeft size={14} /> Change deal
              </button>
            </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
            <label className={labelCls} htmlFor="fd-merchant">Deal / merchant name *</label>
            <input
              id="fd-merchant" className={inputCls} value={form.merchant_name}
              onChange={set("merchant_name")} placeholder="Remington Builders LLC"
              aria-invalid={!!errors.merchant_name} required
            />
            {errors.merchant_name && <p className="mt-1 text-xs text-status-hot">{errors.merchant_name}</p>}
          </div>

          <div>
            <label className={labelCls} htmlFor="fd-amount">Amount funded *</label>
            <input
              id="fd-amount" className={inputCls} value={form.funded_amount_usd}
              onChange={set("funded_amount_usd")} placeholder="85,000" inputMode="decimal"
              aria-invalid={!!errors.funded_amount_usd} required
            />
            {errors.funded_amount_usd && <p className="mt-1 text-xs text-status-hot">{errors.funded_amount_usd}</p>}
          </div>

          <div>
            <label className={labelCls} htmlFor="fd-funded-at">Funded date *</label>
            <input
              id="fd-funded-at" type="date" className={inputCls} value={form.funded_at}
              onChange={set("funded_at")} aria-invalid={!!errors.funded_at} required
            />
            {errors.funded_at && <p className="mt-1 text-xs text-status-hot">{errors.funded_at}</p>}
          </div>

          <div>
            <label className={labelCls} htmlFor="fd-term">Term (months) *</label>
            <input
              id="fd-term" className={inputCls} value={form.term_months}
              onChange={set("term_months")} placeholder="10" inputMode="numeric"
              aria-invalid={!!errors.term_months} required
            />
            {errors.term_months
              ? <p className="mt-1 text-xs text-status-hot">{errors.term_months}</p>
              : <p className="mt-1 text-[11px] text-fg-muted">Sets the renewal date.</p>}
          </div>

          <div>
            <label className={labelCls} htmlFor="fd-points">Points (%)</label>
            <input
              id="fd-points" className={inputCls} value={form.points_pct}
              onChange={set("points_pct")} placeholder="11" inputMode="decimal"
              aria-invalid={!!errors.points_pct}
            />
            {errors.points_pct
              ? <p className="mt-1 text-xs text-status-hot">{errors.points_pct}</p>
              : <p className="mt-1 text-[11px] text-fg-muted">Sets the estimated commission.</p>}
          </div>

          <div>
            <label className={labelCls} htmlFor="fd-factor">Factor rate *</label>
            <input
              id="fd-factor" className={inputCls} value={form.factor_rate}
              onChange={set("factor_rate")} placeholder="1.35" inputMode="decimal"
              aria-invalid={!!errors.factor_rate} required
            />
            {errors.factor_rate && <p className="mt-1 text-xs text-status-hot">{errors.factor_rate}</p>}
          </div>

          <div>
            <label className={labelCls} htmlFor="fd-contact">Contact name</label>
            <input
              id="fd-contact" className={inputCls} value={form.contact_name}
              onChange={set("contact_name")} placeholder="Ray Remington"
            />
          </div>

          <div>
            {/* Internal only. The renewal row reads this to avoid showing
                "No lender assigned"; it is never rendered on a merchant-facing
                surface. [[feedback_never_mention_lenders]] */}
            <label className={labelCls} htmlFor="fd-lender">Funder</label>
            <input
              id="fd-lender" className={inputCls} value={form.lender_name}
              onChange={set("lender_name")} placeholder="Who funded it"
            />
          </div>

          <div className="md:col-span-2">
            <label className={labelCls} htmlFor="fd-notes">Notes</label>
            <textarea
              id="fd-notes" className={inputCls} rows={2} value={form.notes}
              onChange={set("notes")} placeholder="Anything worth remembering at renewal time"
            />
          </div>
        </div>

        {/* The derived fields, shown before saving so they are visible rather
            than magic. Computed with the same functions the server uses. */}
        {(previewRenewal || previewCommission !== null) && (
          <div className="rounded-lg border border-border bg-bg-subtle px-3 py-2.5 text-xs text-fg-muted">
            <span className="font-bold uppercase tracking-[0.12em] text-[10px]">Will be calculated</span>
            <div className="mt-1.5 flex flex-wrap gap-x-6 gap-y-1">
              <span>
                Renewal date:{" "}
                <span className="text-fg font-medium">{previewRenewal ?? "needs a funded date + term"}</span>
                {previewRenewal && <span className="ml-1">(halfway through the term)</span>}
              </span>
              <span>
                Est. commission:{" "}
                <span className="text-fg font-medium">
                  {previewCommission === null ? "needs an amount + points" : fmtUsd(previewCommission)}
                </span>
              </span>
            </div>
          </div>
        )}

        {formError && (
          <p className="text-sm text-status-hot" role="alert">{formError}</p>
        )}
        {saved && (
          <p className="flex items-center gap-1.5 text-sm text-status-warm" role="status">
            <Check size={14} /> Recorded {saved}. It will appear in the list below.
          </p>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit" disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {saving ? "Saving…" : confirmDuplicate ? "Record it anyway" : "Record funded deal"}
          </button>
          <span className="text-[11px] text-fg-muted">* required</span>
        </div>
                </div>
              </div>
            </div>
          </>
        )}
      </form>
    </Card>
  );
}
