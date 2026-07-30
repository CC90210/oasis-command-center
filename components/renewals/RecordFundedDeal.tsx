"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Command,
  Loader2,
  Mail,
  Phone,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import { nextRenewalDate, estCommissionUsd } from "@/lib/renewals/derive";

type FieldErrors = Record<string, string>;

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

const inputCls =
  "w-full rounded-xl border border-border bg-bg px-3.5 py-2.5 text-sm text-fg " +
  "placeholder:text-fg-muted outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20";
const labelCls = "mb-1.5 block text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted";

function toNum(value: string): number | null {
  const cleaned = value.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function fmtUsd(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function relativeDate(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  const days = Math.max(0, Math.floor(elapsed / 86_400_000));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function titleCase(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export default function RecordFundedDeal() {
  const router = useRouter();
  const launchRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pickerDialogRef = useRef<HTMLElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);

  const [mounted, setMounted] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedLead, setSelectedLead] = useState<LeadOption | null>(null);
  const [leadQuery, setLeadQuery] = useState("");
  const [leadResults, setLeadResults] = useState<LeadOption[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchNonce, setSearchNonce] = useState(0);

  const [form, setForm] = useState({ ...EMPTY });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const renewalDate = nextRenewalDate(form.funded_at || null, toNum(form.term_months));
  const commission = estCommissionUsd(toNum(form.funded_amount_usd), toNum(form.points_pct));

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!pickerOpen) return;
    const requestId = ++requestRef.current;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const response = await fetch(`/api/renewals?q=${encodeURIComponent(leadQuery.trim())}`, {
          signal: controller.signal,
        });
        const json = await response.json();
        if (!response.ok || !json?.ok) throw new Error("search_failed");
        if (requestId !== requestRef.current) return;
        setLeadResults(json.leads || []);
        setActiveIndex(0);
      } catch (error) {
        if (controller.signal.aborted || requestId !== requestRef.current) return;
        setLeadResults([]);
        setSearchError(error instanceof Error ? "We couldn't load CRM deals." : "Search failed.");
      } finally {
        if (requestId === requestRef.current) setSearching(false);
      }
    }, leadQuery ? 200 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [leadQuery, pickerOpen, searchNonce]);

  useEffect(() => {
    if (!pickerOpen && !selectedLead) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [pickerOpen, selectedLead]);

  useEffect(() => {
    if (pickerOpen) window.setTimeout(() => searchRef.current?.focus(), 0);
  }, [pickerOpen]);

  useEffect(() => {
    if (!selectedLead) return;
    window.setTimeout(() => document.getElementById("fd-amount")?.focus(), 0);
  }, [selectedLead]);

  function openPicker() {
    setSaved(null);
    setLeadQuery("");
    setSearchError(null);
    setPickerOpen(true);
  }

  function closePicker() {
    setPickerOpen(false);
    window.setTimeout(() => launchRef.current?.focus(), 0);
  }

  function selectLead(lead: LeadOption) {
    setPickerOpen(false);
    setSelectedLead(lead);
    setErrors({});
    setFormError(null);
    setConfirmDuplicate(false);
    setForm({
      ...EMPTY,
      lead_id: lead.id,
      merchant_name: lead.business_name,
      contact_name: lead.contact_name || "",
    });
  }

  function closeDrawer(restoreFocus = true) {
    if (saving) return;
    setSelectedLead(null);
    setForm({ ...EMPTY });
    setErrors({});
    setFormError(null);
    setConfirmDuplicate(false);
    if (restoreFocus) window.setTimeout(() => launchRef.current?.focus(), 0);
  }

  function changeDeal() {
    closeDrawer(false);
    setPickerOpen(true);
  }

  function handlePickerKeys(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closePicker();
      return;
    }
    if (!leadResults.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % leadResults.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + leadResults.length) % leadResults.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectLead(leadResults[activeIndex]);
    }
  }

  function handleDrawerKeys(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDrawer();
      return;
    }
    if (event.key !== "Tab" || !drawerRef.current) return;
    const focusable = Array.from(
      drawerRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handlePickerDialogKeys(event: React.KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closePicker();
      return;
    }
    if (event.key !== "Tab" || !pickerDialogRef.current) return;
    const focusable = Array.from(
      pickerDialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const setField =
    (key: keyof typeof EMPTY) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setForm((current) => ({ ...current, [key]: event.target.value }));
      setErrors((current) => (current[key] ? { ...current, [key]: "" } : current));
      setConfirmDuplicate(false);
    };

  function focusFirstError(nextErrors: FieldErrors) {
    const order = ["funded_amount_usd", "factor_rate", "term_months", "funded_at"];
    const first = order.find((key) => nextErrors[key]) || Object.keys(nextErrors)[0];
    if (!first) return;
    window.setTimeout(() => document.getElementById(`fd-${first.replaceAll("_", "-")}`)?.focus(), 0);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedLead || saving) return;
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      const response = await fetch("/api/renewals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, confirm_duplicate: confirmDuplicate }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || !json?.ok) {
        const nextErrors = (json?.errors || {}) as FieldErrors;
        setErrors(nextErrors);
        if (response.status === 409 && json?.error === "possible_duplicate") {
          setConfirmDuplicate(true);
        }
        setFormError(
          json?.message ||
            (Object.keys(nextErrors).length
              ? "Check the highlighted funding details."
              : "The renewal could not be saved. Your entries are still here."),
        );
        focusFirstError(nextErrors);
        return;
      }
      const merchant = json.deal?.merchant_name || selectedLead.business_name;
      setSaved(merchant);
      setSelectedLead(null);
      setForm({ ...EMPTY });
      setErrors({});
      setFormError(null);
      setConfirmDuplicate(false);
      router.refresh();
      window.setTimeout(() => launchRef.current?.focus(), 0);
    } catch {
      setFormError("Network error. Your entries are still here—try saving again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <section className="relative overflow-hidden rounded-2xl border border-accent/20 bg-bg-panel shadow-card">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_0%,rgba(59,130,246,0.14),transparent_38%),radial-gradient(circle_at_90%_100%,rgba(0,212,255,0.08),transparent_34%)]" />
        <div className="relative flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3.5">
            <div className="rounded-xl border border-accent/30 bg-accent/10 p-3 text-accent shadow-[0_0_24px_-8px_rgba(59,130,246,0.8)]">
              <Sparkles size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">Renewal command</span>
                <span className="h-1 w-1 rounded-full bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,1)]" />
              </div>
              <h2 className="mt-1 text-base font-semibold text-fg">Track a newly funded deal</h2>
              <p className="mt-1 max-w-xl text-xs leading-relaxed text-fg-muted">
                Find a CRM deal, enter its funding terms, and activate outreach at the halfway point.
              </p>
            </div>
          </div>
          <button
            ref={launchRef}
            type="button"
            onClick={openPicker}
            className="btn-primary inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl px-5"
          >
            <Plus size={16} /> Add Renewal
          </button>
        </div>
        {saved && (
          <div className="relative flex items-center gap-2 border-t border-status-engaged/20 bg-status-engaged/5 px-5 py-3 text-sm text-status-engaged" role="status">
            <Check size={15} /> {saved} is now tracked for renewal outreach.
          </div>
        )}
      </section>

      {mounted && pickerOpen &&
        createPortal(
          <div className="fixed inset-0 z-[100] flex items-start justify-center p-3 pt-[8vh] sm:p-6 sm:pt-[12vh]">
            <button type="button" className="absolute inset-0 bg-black/75 backdrop-blur-md" onClick={closePicker} aria-label="Close deal picker" />
            <section ref={pickerDialogRef} onKeyDown={handlePickerDialogKeys} role="dialog" aria-modal="true" aria-labelledby="renewal-picker-title" className="relative z-10 w-full max-w-3xl overflow-hidden rounded-2xl border border-accent/25 bg-[#080c14] shadow-[0_28px_90px_-24px_rgba(0,0,0,0.95),0_0_50px_-28px_rgba(59,130,246,0.9)]">
              <div className="h-px bg-gradient-to-r from-transparent via-cyan-400 to-transparent opacity-80" />
              <header className="flex items-start justify-between border-b border-border px-5 py-4">
                <div>
                  <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-accent">
                    <Command size={12} /> Deal finder
                  </div>
                  <h2 id="renewal-picker-title" className="mt-1 text-lg font-semibold text-fg">Select a funded deal</h2>
                </div>
                <button type="button" onClick={closePicker} className="rounded-lg border border-border p-2 text-fg-muted hover:border-accent/40 hover:bg-accent/10 hover:text-fg" aria-label="Close">
                  <X size={16} />
                </button>
              </header>

              <div className="p-4 sm:p-5">
                <div className="relative">
                  <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-accent" />
                  <input
                    ref={searchRef}
                    type="search"
                    role="combobox"
                    aria-expanded="true"
                    aria-controls="renewal-picker-results"
                    aria-activedescendant={leadResults[activeIndex] ? `renewal-option-${leadResults[activeIndex].id}` : undefined}
                    value={leadQuery}
                    onChange={(event) => setLeadQuery(event.target.value)}
                    onKeyDown={handlePickerKeys}
                    placeholder="Search business, owner, phone, or email…"
                    className="h-14 w-full rounded-xl border border-accent/30 bg-[#0d131f] pl-11 pr-12 text-sm text-fg outline-none transition placeholder:text-fg-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                  />
                  {searching ? (
                    <Loader2 size={17} className="absolute right-4 top-1/2 -translate-y-1/2 animate-spin text-accent" />
                  ) : leadQuery ? (
                    <button type="button" onClick={() => setLeadQuery("")} className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-fg-muted hover:bg-bg-elev hover:text-fg" aria-label="Clear search">
                      <X size={15} />
                    </button>
                  ) : null}
                </div>

                <div className="mt-3 flex items-center justify-between px-1">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
                    <Clock3 size={12} /> {leadQuery ? "Matching CRM deals" : "25 most recent deals"}
                  </div>
                  <div className="hidden items-center gap-2 text-[10px] text-fg-muted sm:flex">
                    <kbd className="rounded border border-border bg-bg-elev px-1.5 py-0.5">↑↓</kbd> navigate
                    <kbd className="rounded border border-border bg-bg-elev px-1.5 py-0.5">↵</kbd> select
                    <kbd className="rounded border border-border bg-bg-elev px-1.5 py-0.5">esc</kbd> close
                  </div>
                </div>

                <div id="renewal-picker-results" role="listbox" className="mt-2 max-h-[52vh] min-h-52 overflow-y-auto rounded-xl border border-border bg-[#060910] p-1.5">
                  {searching && leadResults.length === 0 ? (
                    <PickerSkeleton />
                  ) : searchError ? (
                    <div className="flex min-h-52 flex-col items-center justify-center px-5 text-center">
                      <RotateCcw size={22} className="text-status-warm" />
                      <p className="mt-3 text-sm font-medium text-fg">{searchError}</p>
                      <button type="button" onClick={() => setSearchNonce((value) => value + 1)} className="btn-secondary mt-3 inline-flex items-center gap-2">
                        <RotateCcw size={13} /> Retry
                      </button>
                    </div>
                  ) : leadResults.length === 0 ? (
                    <div className="flex min-h-52 flex-col items-center justify-center px-5 text-center">
                      <Search size={24} className="text-fg-muted" />
                      <p className="mt-3 text-sm font-medium text-fg">{leadQuery ? "No matching deals" : "No recent deals yet"}</p>
                      <p className="mt-1 text-xs text-fg-muted">Try a business name, owner, phone, or email.</p>
                    </div>
                  ) : (
                    leadResults.map((lead, index) => (
                      <button
                        id={`renewal-option-${lead.id}`}
                        key={lead.id}
                        type="button"
                        role="option"
                        aria-selected={index === activeIndex}
                        onMouseEnter={() => setActiveIndex(index)}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          selectLead(lead);
                        }}
                        onClick={() => selectLead(lead)}
                        className={`group grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl border px-3 py-3 text-left transition ${
                          index === activeIndex
                            ? "border-accent/35 bg-accent/10 shadow-[inset_3px_0_0_rgba(59,130,246,0.9)]"
                            : "border-transparent hover:border-border hover:bg-bg-elev/70"
                        }`}
                      >
                        <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-accent/25 bg-gradient-to-br from-accent/20 to-cyan-400/5 font-mono text-sm font-bold text-cyan-200">
                          {initials(lead.business_name)}
                        </div>
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm font-semibold text-fg">{lead.business_name}</span>
                            {lead.stage && <span className="shrink-0 rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-accent">{titleCase(lead.stage)}</span>}
                          </div>
                          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-muted">
                            {lead.contact_name && <span className="flex items-center gap-1"><UserRound size={11} />{lead.contact_name}</span>}
                            {lead.phone && <span className="flex items-center gap-1"><Phone size={11} />{lead.phone}</span>}
                            {lead.email && <span className="flex min-w-0 items-center gap-1"><Mail size={11} /><span className="max-w-52 truncate">{lead.email}</span></span>}
                          </div>
                          <div className="mt-1.5 flex items-center gap-3 text-[10px] text-fg-dim">
                            <span>{relativeDate(lead.updated_at)}</span>
                            {lead.amount_requested !== null && <span className="font-mono text-cyan-200/80">{fmtUsd(lead.amount_requested)} requested</span>}
                          </div>
                        </div>
                        <ChevronRight size={17} className="text-fg-muted transition group-hover:translate-x-0.5 group-hover:text-accent" />
                      </button>
                    ))
                  )}
                </div>
              </div>
            </section>
          </div>,
          document.body,
        )}

      {mounted && selectedLead &&
        createPortal(
          <div className="fixed inset-0 z-[110]" onKeyDown={handleDrawerKeys}>
            <button type="button" className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => closeDrawer()} aria-label="Close funding drawer" />
            <aside
              ref={drawerRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="renewal-drawer-title"
              className="absolute inset-x-0 bottom-0 flex max-h-[94vh] flex-col overflow-hidden rounded-t-2xl border border-border bg-[#080c14] shadow-2xl sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[min(620px,94vw)] sm:rounded-none sm:rounded-l-2xl"
            >
              <div className="h-px bg-gradient-to-r from-transparent via-cyan-400 to-accent" />
              <header className="flex items-start justify-between border-b border-border px-5 py-4 sm:px-6">
                <div>
                  <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-accent">
                    <CircleDollarSign size={12} /> Funding profile
                  </div>
                  <h2 id="renewal-drawer-title" className="mt-1 text-xl font-semibold text-fg">Activate renewal tracking</h2>
                  <p className="mt-1 text-xs text-fg-muted">Add the current deal terms. Outreach starts halfway through the term.</p>
                </div>
                <button type="button" onClick={() => closeDrawer()} disabled={saving} className="rounded-lg border border-border p-2 text-fg-muted hover:border-accent/40 hover:bg-accent/10 hover:text-fg disabled:opacity-50" aria-label="Close">
                  <X size={17} />
                </button>
              </header>

              <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
                <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5 sm:p-6">
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-accent/25 bg-[linear-gradient(135deg,rgba(59,130,246,0.12),rgba(0,212,255,0.04))] p-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-accent/25 bg-accent/10 font-mono text-sm font-bold text-cyan-200">
                        {initials(selectedLead.business_name)}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-fg">{selectedLead.business_name}</div>
                        <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-fg-muted">
                          {selectedLead.contact_name && <span>{selectedLead.contact_name}</span>}
                          {selectedLead.stage && <span>• {titleCase(selectedLead.stage)}</span>}
                        </div>
                      </div>
                    </div>
                    <button type="button" onClick={changeDeal} disabled={saving} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-bg/60 px-2.5 py-2 text-xs font-medium text-fg-muted hover:border-accent/40 hover:text-fg disabled:opacity-50">
                      <ArrowLeft size={13} /> Change
                    </button>
                  </div>

                  <section>
                    <div className="mb-3 flex items-center gap-2">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/15 font-mono text-[10px] font-bold text-accent">01</span>
                      <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-fg-muted">Required deal terms</h3>
                    </div>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <Field label="Funding amount" htmlFor="fd-funded-amount-usd" error={errors.funded_amount_usd} required>
                        <input id="fd-funded-amount-usd" className={inputCls} value={form.funded_amount_usd} onChange={setField("funded_amount_usd")} placeholder="$85,000" inputMode="decimal" required aria-invalid={!!errors.funded_amount_usd} />
                      </Field>
                      <Field label="Factor rate" htmlFor="fd-factor-rate" error={errors.factor_rate} required>
                        <input id="fd-factor-rate" className={inputCls} value={form.factor_rate} onChange={setField("factor_rate")} placeholder="1.35" inputMode="decimal" required aria-invalid={!!errors.factor_rate} />
                      </Field>
                      <Field label="Term" htmlFor="fd-term-months" error={errors.term_months} hint="Months" required>
                        <input id="fd-term-months" className={inputCls} value={form.term_months} onChange={setField("term_months")} placeholder="10" inputMode="numeric" required aria-invalid={!!errors.term_months} />
                      </Field>
                      <Field label="Funded date" htmlFor="fd-funded-at" error={errors.funded_at} required>
                        <input id="fd-funded-at" type="date" className={inputCls} value={form.funded_at} onChange={setField("funded_at")} required aria-invalid={!!errors.funded_at} />
                      </Field>
                    </div>
                  </section>

                  <section>
                    <div className="mb-3 flex items-center gap-2">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-bg-elev font-mono text-[10px] font-bold text-fg-muted">02</span>
                      <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-fg-muted">Optional context</h3>
                    </div>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <Field label="Funder" htmlFor="fd-lender-name" error={errors.lender_name}>
                        <input id="fd-lender-name" className={inputCls} value={form.lender_name} onChange={setField("lender_name")} placeholder="Who funded the deal" />
                      </Field>
                      <Field label="Commission points" htmlFor="fd-points-pct" error={errors.points_pct} hint="%">
                        <input id="fd-points-pct" className={inputCls} value={form.points_pct} onChange={setField("points_pct")} placeholder="11" inputMode="decimal" aria-invalid={!!errors.points_pct} />
                      </Field>
                      <Field label="Contact override" htmlFor="fd-contact-name" error={errors.contact_name}>
                        <input id="fd-contact-name" className={inputCls} value={form.contact_name} onChange={setField("contact_name")} placeholder="Primary contact" />
                      </Field>
                      <div className="sm:col-span-2">
                        <label className={labelCls} htmlFor="fd-notes">Renewal notes</label>
                        <textarea id="fd-notes" className={`${inputCls} min-h-20 resize-y`} value={form.notes} onChange={setField("notes")} placeholder="Context to remember when outreach begins…" />
                      </div>
                    </div>
                  </section>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border border-accent/25 bg-accent/8 p-4">
                      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-accent"><CalendarDays size={13} /> Outreach begins</div>
                      <div className="mt-2 font-mono text-lg font-semibold text-fg">{renewalDate || "Awaiting term + date"}</div>
                      <p className="mt-1 text-[11px] text-fg-muted">50% through the funding term</p>
                    </div>
                    <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/5 p-4">
                      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-cyan-300"><CircleDollarSign size={13} /> Est. commission</div>
                      <div className="mt-2 font-mono text-lg font-semibold text-fg">{commission === null ? "Awaiting points" : fmtUsd(commission)}</div>
                      <p className="mt-1 text-[11px] text-fg-muted">Calculated from amount × points</p>
                    </div>
                  </div>

                  {formError && (
                    <div className={`rounded-xl border px-4 py-3 text-sm ${confirmDuplicate ? "border-status-warm/35 bg-status-warm/10 text-status-warm" : "border-status-hot/35 bg-status-hot/10 text-status-hot"}`} role="alert">
                      {formError}
                    </div>
                  )}
                </div>

                <footer className="flex items-center justify-between gap-3 border-t border-border bg-bg-panel/95 px-5 py-4 sm:px-6">
                  <span className="hidden text-[10px] uppercase tracking-[0.13em] text-fg-muted sm:block">Four required fields • server verified</span>
                  <div className="ml-auto flex items-center gap-2">
                    <button type="button" onClick={() => closeDrawer()} disabled={saving} className="btn-secondary">Cancel</button>
                    <button type="submit" disabled={saving} className="btn-primary inline-flex min-w-40 items-center justify-center gap-2">
                      {saving ? <Loader2 size={14} className="animate-spin" /> : confirmDuplicate ? <RotateCcw size={14} /> : <ArrowRight size={14} />}
                      {saving ? "Saving…" : confirmDuplicate ? "Record anyway" : "Activate renewal"}
                    </button>
                  </div>
                </footer>
              </form>
            </aside>
          </div>,
          document.body,
        )}
    </>
  );
}

function Field({
  label,
  htmlFor,
  error,
  hint,
  required = false,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label htmlFor={htmlFor} className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">{label}{required ? " *" : ""}</label>
        {hint && <span className="text-[10px] text-fg-dim">{hint}</span>}
      </div>
      {children}
      {error && <p className="mt-1.5 text-xs text-status-hot">{error}</p>}
    </div>
  );
}

function PickerSkeleton() {
  return (
    <div className="space-y-1.5 p-1" aria-label="Loading recent deals">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex animate-pulse items-center gap-3 rounded-xl border border-transparent px-3 py-3 motion-reduce:animate-none">
          <div className="h-11 w-11 rounded-xl bg-bg-elev" />
          <div className="flex-1">
            <div className="h-3 w-2/5 rounded bg-bg-elev" />
            <div className="mt-2 h-2.5 w-3/5 rounded bg-bg-elev/70" />
            <div className="mt-2 h-2 w-1/4 rounded bg-bg-elev/50" />
          </div>
        </div>
      ))}
    </div>
  );
}
