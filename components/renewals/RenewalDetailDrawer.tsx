"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Activity, Building2, ExternalLink, Loader2, RefreshCw, Settings2, Trash2, X } from "lucide-react";
import { LeadFileBody, type DetailPayload } from "@/components/leads/LeadFileBody";
import { LenderPickerField, type LenderOption } from "@/components/renewals/RecordFundedDeal";
import { isTermUnit, type TermUnit } from "@/lib/renewals/derive";

type Detail = {
  deal: Record<string, unknown>;
  lead: { id: string; data: Record<string, unknown> } | null;
  lender: { id: string; data: Record<string, unknown> } | null;
  events: Array<Record<string, unknown>>;
};
type Tab = "overview" | "lead" | "lender" | "activity" | "automation";
type RenewalEditForm = {
  funded_amount_usd: string;
  factor_rate: string;
  term_value: string;
  term_unit: TermUnit;
  funded_at: string;
  points_pct: string;
  notes: string;
};

export function RenewalDetailDrawer() {
  const params = useSearchParams();
  const router = useRouter();
  const id = params.get("renewal");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [leadDetail, setLeadDetail] = useState<DetailPayload | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const close = useCallback(() => {
    if (dirty && !window.confirm("Discard your unsaved renewal changes?")) return;
    const next = new URLSearchParams(params.toString());
    next.delete("renewal");
    router.replace(next.toString() ? `?${next}` : "?", { scroll: false });
  }, [dirty, params, router]);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    const response = await fetch(`/api/renewals/${id}`, { cache: "no-store" });
    const json = await response.json();
    if (!json.ok) { setError(json.error || "load_failed"); return; }
    setDetail(json);
    if (json.deal?.lead_id) {
      const leadResponse = await fetch(`/api/leads/${json.deal.lead_id}/detail`, { cache: "no-store" });
      const leadJson = await leadResponse.json();
      if (leadJson.ok) setLeadDetail(leadJson);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!id) return;
    const prior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const key = (event: KeyboardEvent) => event.key === "Escape" && close();
    document.addEventListener("keydown", key);
    return () => { document.body.style.overflow = prior; document.removeEventListener("keydown", key); };
  }, [id, close]);
  if (!id) return null;

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "overview", label: "Overview" }, { key: "lead", label: "Lead" },
    { key: "lender", label: "Lender" }, { key: "activity", label: "Activity" },
    { key: "automation", label: "Automation" },
  ];
  const deal = detail?.deal || {};
  return (
    <div className="fixed inset-0 z-[120]" role="dialog" aria-modal="true" aria-label="Renewal file">
      <button type="button" className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={close} aria-label="Close renewal" />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-3xl flex-col border-l border-accent/25 bg-[#080c14] shadow-2xl">
        <div className="h-px bg-gradient-to-r from-transparent via-cyan-400 to-accent" />
        <header className="flex items-start justify-between border-b border-border px-6 py-5">
          <div><div className="text-[10px] font-bold uppercase tracking-[.16em] text-accent">Renewal file</div>
            <h2 className="mt-1 text-xl font-semibold text-fg">{String(deal.merchant_name || "Loading renewal…")}</h2>
            <p className="mt-1 text-xs text-fg-muted">{String(deal.lender_name || "Lender not linked")} • {String(deal.next_renewal_date || "No renewal date")}</p>
          </div>
          <button type="button" onClick={close} className="rounded-lg border border-border p-2 text-fg-muted hover:text-fg"><X size={17} /></button>
        </header>
        <nav className="flex overflow-x-auto border-b border-border px-4">
          {tabs.map((item) => <button key={item.key} type="button" onClick={() => setTab(item.key)} className={`px-3 py-3 text-xs font-semibold ${tab === item.key ? "border-b-2 border-accent text-accent" : "text-fg-muted"}`}>{item.label}</button>)}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {error && <div className="m-6 rounded-xl border border-status-hot/30 bg-status-hot/10 p-4 text-status-hot">{error}</div>}
          {!detail && !error && <div className="flex h-60 items-center justify-center gap-2 text-fg-muted"><Loader2 className="animate-spin" /> Loading renewal file…</div>}
          {detail && tab === "overview" && <Overview deal={deal} lender={detail.lender} onSaved={load} onDirtyChange={setDirty} onDeleted={() => {
            setDirty(false);
            const next = new URLSearchParams(params.toString());
            next.delete("renewal");
            router.replace(next.toString() ? `?${next}` : "?", { scroll: false });
            router.refresh();
          }} />}
          {detail && tab === "lead" && (leadDetail ? <LeadFileBody tenantSlug="sun" leadId={String(deal.lead_id)} entity="lead" record={leadDetail.record.data} documents={leadDetail.documents} application={leadDetail.application} onReload={load} /> :
            <Empty icon={<ExternalLink />} text="No linked lead file is available." />)}
          {detail && tab === "lender" && <LenderPanel lender={detail.lender} onSaved={load} />}
          {detail && tab === "activity" && <ActivityPanel events={detail.events} />}
          {detail && tab === "automation" && <AutomationPanel dealId={id} events={detail.events} onSaved={load} />}
        </div>
      </aside>
    </div>
  );
}

function Overview({ deal, lender, onSaved, onDirtyChange, onDeleted }: {
  deal: Record<string, unknown>;
  lender: Detail["lender"];
  onSaved: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onDeleted: () => void;
}) {
  const initialTermUnit: TermUnit = isTermUnit(deal.term_unit) ? deal.term_unit : "months";
  const [form, setForm] = useState<RenewalEditForm>({ funded_amount_usd: String(deal.funded_amount_usd || ""), factor_rate: String(deal.factor_rate || ""), term_value: String(deal.term_value || deal.term_months || ""), term_unit: initialTermUnit, funded_at: String(deal.funded_at || ""), points_pct: String(deal.points_pct || ""), notes: String(deal.notes || "") });
  const [lenderId, setLenderId] = useState(String(deal.lender_id || ""));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  function update(key: keyof RenewalEditForm, value: string) {
    setForm((current) => ({ ...current, [key]: key === "term_unit" ? value as TermUnit : value }));
    onDirtyChange(true);
  }
  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/renewals/${deal.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, lender_id: lenderId }),
      });
      const json = await response.json();
      if (!response.ok || !json.ok) throw new Error(json.message || json.error || "Unable to save renewal.");
      await onSaved();
      onDirtyChange(false);
      setMessage({ kind: "success", text: "Renewal updated." });
    } catch (caught) {
      setMessage({ kind: "error", text: caught instanceof Error ? caught.message : "Unable to save renewal." });
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    const merchant = String(deal.merchant_name || "this renewal");
    if (!window.confirm(`Delete the renewal for ${merchant}? This cannot be undone.`)) return;
    setDeleting(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/renewals/${deal.id}`, { method: "DELETE" });
      const json = await response.json();
      if (!response.ok || !json.ok) throw new Error(json.message || json.error || "Unable to delete renewal.");
      onDeleted();
    } catch (caught) {
      setMessage({ kind: "error", text: caught instanceof Error ? caught.message : "Unable to delete renewal." });
      setDeleting(false);
    }
  }
  return <div className="space-y-6 p-6">
    {!deal.lender_id && <div className="rounded-xl border border-status-warm/30 bg-status-warm/10 p-4 text-sm text-status-warm">Link a canonical lender before automated outreach can run.</div>}
    <div className="grid grid-cols-2 gap-4">{Object.entries(form).map(([key, value]) => key === "notes" ?
      <label key={key} className="col-span-2 text-xs text-fg-muted">Notes<textarea className="input mt-1 min-h-24" value={value} onChange={(e) => update(key as keyof RenewalEditForm, e.target.value)} /></label> :
      key === "term_unit" ?
      <label key={key} className="text-xs text-fg-muted">Term unit<select className="input mt-1" value={value} onChange={(e) => update(key as keyof RenewalEditForm, e.target.value)}><option value="months">Months</option><option value="weeks">Weeks</option><option value="days">Days</option></select></label> :
      <label key={key} className="text-xs text-fg-muted">{key.replaceAll("_", " ")}<input type={key === "funded_at" ? "date" : "number"} step={key === "term_value" ? "1" : "0.01"} className="input mt-1" value={value} onChange={(e) => update(key as keyof RenewalEditForm, e.target.value)} /></label>)}</div>
    <LenderPickerField value={lenderId} initialName={String(lender?.data?.name || deal.lender_name || "")} onChange={(selected: LenderOption) => {
      setLenderId(selected.id);
      onDirtyChange(true);
    }} />
    <div className="rounded-xl border border-border bg-bg-panel p-4 text-sm"><Building2 size={16} className="mb-2 text-accent" />Linked lender: {String(lender?.data?.name || deal.lender_name || "None")}</div>
    {message && <div role="status" className={`rounded-xl border p-3 text-sm ${message.kind === "error" ? "border-status-hot/30 bg-status-hot/10 text-status-hot" : "border-status-good/30 bg-status-good/10 text-status-good"}`}>{message.text}</div>}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <button type="button" onClick={save} disabled={saving || deleting} className="btn-primary">{saving ? "Saving…" : "Save changes"}</button>
      <button type="button" onClick={remove} disabled={saving || deleting} className="inline-flex items-center gap-2 rounded-lg border border-status-hot/35 px-3 py-2 text-xs font-semibold text-status-hot hover:bg-status-hot/10 disabled:opacity-50">
        {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} {deleting ? "Deleting…" : "Delete renewal"}
      </button>
    </div>
  </div>;
}

function LenderPanel({ lender, onSaved }: { lender: Detail["lender"]; onSaved: () => Promise<void> }) {
  const initial = lender?.data || {};
  const lenderId = lender?.id || "";
  const [form, setForm] = useState({ contact_name: String(initial.contact_name || ""), contact_email: String(initial.contact_email || initial.contact || ""), contact_phone: String(initial.contact_phone || initial.phone || "") });
  if (!lender) return <Empty icon={<Building2 />} text="No canonical lender is linked. Use the renewal overview to attach one." />;
  async function save() { await fetch(`/api/manifest/sun/records/lender?id=${lenderId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ patch: form }) }); await onSaved(); }
  return <div className="space-y-4 p-6"><h3 className="font-semibold text-fg">{String(initial.name || "Lender")}</h3>
    {Object.entries(form).map(([key, value]) => <label key={key} className="block text-xs text-fg-muted">{key.replaceAll("_", " ")}<input className="input mt-1" value={value} onChange={(e) => setForm({ ...form, [key]: e.target.value })} /></label>)}
    <button type="button" onClick={save} className="btn-primary">Save lender contact</button>
    <Link href="/t/sun/lenders" className="inline-flex items-center gap-1 text-xs text-accent">Open full lender editor <ExternalLink size={12} /></Link>
  </div>;
}

function ActivityPanel({ events }: { events: Detail["events"] }) { return <div className="space-y-3 p-6">{events.length ? events.map((event) => <div key={String(event.id)} className="rounded-xl border border-border bg-bg-panel p-4"><div className="text-sm font-semibold text-fg">{String(event.event_kind)} • {String(event.status)}</div><div className="mt-1 text-xs text-fg-muted">{String(event.created_at)}</div>{Boolean(event.last_error) && <div className="mt-2 text-xs text-status-warm">{String(event.last_error)}</div>}</div>) : <Empty icon={<Activity />} text="No renewal automation activity yet." />}</div>; }
function AutomationPanel({ dealId, events, onSaved }: { dealId: string; events: Detail["events"]; onSaved: () => Promise<void> }) {
  const event = events[0]; const [working, setWorking] = useState(false);
  async function act(action: string) { setWorking(true); await fetch(`/api/renewals/${dealId}/outreach`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) }); await onSaved(); setWorking(false); }
  if (!event) return <Empty icon={<Settings2 />} text="The 50% event has not been materialized yet." />;
  return <div className="space-y-4 p-6"><div className="rounded-xl border border-accent/25 bg-accent/5 p-5"><div className="text-[10px] uppercase text-accent">50% outreach</div><div className="mt-2 text-xl font-semibold text-fg">{String(event.status)}</div><div className="mt-1 text-xs text-fg-muted">Threshold {String(event.threshold_date)}</div>{Boolean(event.last_error) && <div className="mt-3 text-sm text-status-warm">{String(event.last_error)}</div>}</div>
    <div className="flex gap-2">{["review_required","blocked","failed"].includes(String(event.status)) && <button disabled={working} onClick={() => act(String(event.status) === "review_required" ? "approve" : "retry")} className="btn-primary inline-flex gap-2">{working && <RefreshCw size={13} className="animate-spin" />} {String(event.status) === "review_required" ? "Approve lender email" : "Retry"}</button>} {!["sent","cancelled"].includes(String(event.status)) && <button onClick={() => act("cancel")} className="btn-secondary">Cancel</button>}</div>
  </div>;
}
function Empty({ icon, text }: { icon: React.ReactNode; text: string }) { return <div className="flex h-56 flex-col items-center justify-center gap-3 p-6 text-center text-fg-muted">{icon}<span className="text-sm">{text}</span></div>; }
