"use client";

/**
 * Settings → Revenue goal (2026-09-24). The ONE place a goal is set; Today, the
 * Bravo chat and the CLI dashboards all read the resulting revenue_goals row.
 * Setting a new goal supersedes the current one — history is kept below.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Goal = {
  id: string;
  label: string;
  target_cents: number;
  currency: "USD" | "CAD";
  period_start: string;
  period_end: string;
  status?: string;
};

const money = (g: Goal) => `${g.currency === "CAD" ? "CA" : ""}$${(g.target_cents / 100).toLocaleString("en-US")}`;

export function RevenueGoalPanel({ canEdit }: { canEdit: boolean }) {
  const router = useRouter();
  const [active, setActive] = useState<Goal | null>(null);
  const [history, setHistory] = useState<Goal[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState({ label: "", amount: "", currency: "USD", start: "", end: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/goals");
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setLoadError(body.error || `HTTP ${res.status}`);
      return;
    }
    setLoadError(null);
    setActive(body.active);
    setHistory(body.history || []);
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: form.label,
          [form.currency === "CAD" ? "target_cad" : "target_usd"]: Number(form.amount),
          period_start: form.start,
          period_end: form.end,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(body.error || `HTTP ${res.status}`);
        return;
      }
      setMessage("Saved — Today now counts down to this goal.");
      setForm({ label: "", amount: "", currency: "USD", start: "", end: "" });
      await load();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 text-sm">
      {loadError ? (
        <p className="text-status-warm">Couldn&apos;t load the goal: {loadError}</p>
      ) : active ? (
        <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-3">
          <div className="text-[10px] uppercase tracking-wider text-fg-dim">Active goal</div>
          <div className="mt-1 font-semibold text-fg">{active.label}</div>
          <div className="text-fg-muted">
            {money(active)} collected, {active.period_start} → {active.period_end} (deadline day counts)
          </div>
        </div>
      ) : (
        <p className="text-fg-muted">No active goal. Today shows a &ldquo;no goal&rdquo; card until one is set.</p>
      )}

      {canEdit && (
        <form onSubmit={save} className="grid sm:grid-cols-2 gap-3">
          <label className="sm:col-span-2 flex flex-col gap-1">
            <span className="text-xs text-fg-muted">Name</span>
            <input className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="November sprint — revenue collected" required />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">Target collected</span>
            <input className="input" type="number" min="1" step="1" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">Currency</span>
            <select className="select" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
              <option value="USD">USD</option>
              <option value="CAD">CAD</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">Starts</span>
            <input className="input" type="date" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} required />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">Deadline (counts)</span>
            <input className="input" type="date" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} required />
          </label>
          <div className="sm:col-span-2 flex items-center gap-3">
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? "Saving…" : active ? "Replace active goal" : "Set goal"}
            </button>
            {message && <span className="text-xs text-fg-muted">{message}</span>}
          </div>
        </form>
      )}

      {history.filter((g) => g.status !== "active").length > 0 && (
        <details className="text-xs text-fg-dim">
          <summary className="cursor-pointer">Past goals</summary>
          <ul className="mt-2 space-y-1">
            {history
              .filter((g) => g.status !== "active")
              .map((g) => (
                <li key={g.id}>
                  {g.label} — {money(g)}, {g.period_start} → {g.period_end} ({g.status})
                </li>
              ))}
          </ul>
        </details>
      )}
    </div>
  );
}
