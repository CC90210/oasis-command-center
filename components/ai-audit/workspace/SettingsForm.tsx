"use client";

/**
 * The workspace's AI audit settings. The tax rule has no default on purpose:
 * whether OASIS charges GST/HST, and at what rate, is CC's to say, and no
 * proposal can be submitted until he does.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AiAuditSettings } from "@/lib/ai-audit/store";
import { describeError, postJson } from "./api";

export function SettingsForm({ settings, rowVersion, isOwner }: { settings: AiAuditSettings; rowVersion: number; isOwner: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<string>(settings.tax ? settings.tax.mode : "");
  const [rate, setRate] = useState(settings.tax && settings.tax.mode === "registered" ? String(settings.tax.rate_bps / 100) : "13");
  const [label, setLabel] = useState(settings.tax && settings.tax.mode === "registered" ? settings.tax.label : "HST");
  const [number, setNumber] = useState(settings.tax && settings.tax.mode === "registered" ? settings.tax.number ?? "" : "");
  const [deposit, setDeposit] = useState(settings.deposit_bps ? String(settings.deposit_bps / 100) : "");
  const [currency, setCurrency] = useState<string>(settings.default_currency);
  const [turnaround, setTurnaround] = useState(settings.turnaround);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setMessage(null);
    const tax = mode === "registered" ? { mode: "registered", rate_bps: Math.round(Number(rate) * 100), label, number } : mode === "not_registered" ? { mode: "not_registered" } : null;
    const r = await postJson("/api/ai-audit/settings", {
      settings: { tax, deposit_bps: deposit ? Math.round(Number(deposit) * 100) : null, default_currency: currency, engine: settings.engine, turnaround },
      expected_row_version: rowVersion,
    });
    setBusy(false);
    if (!r.ok) {
      setMessage(describeError(r));
      return;
    }
    setMessage("Saved.");
    router.refresh();
  }

  const disabled = !isOwner || busy;
  return (
    <div className="grid max-w-2xl gap-5">
      {!isOwner ? <p className="text-sm text-fg-muted">Only the workspace owner can change these.</p> : null}
      {message ? <div className="rounded-lg border border-hairline bg-bg-panel px-4 py-2.5 text-sm text-fg">{message}</div> : null}
      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
        <h2 className="text-sm font-semibold text-fg">Tax on proposals</h2>
        <select className="select" disabled={disabled} value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="">Not set (proposals cannot be submitted)</option>
          <option value="not_registered">Not registered: no tax added</option>
          <option value="registered">Registered: add tax</option>
        </select>
        {mode === "registered" ? (
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <div className="label">Name</div>
              <input className="input" disabled={disabled} value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
            <div>
              <div className="label">Rate %</div>
              <input className="input tabular-nums" inputMode="decimal" disabled={disabled} value={rate} onChange={(e) => setRate(e.target.value)} />
            </div>
            <div>
              <div className="label">Registration number</div>
              <input className="input" disabled={disabled} value={number} onChange={(e) => setNumber(e.target.value)} />
            </div>
          </div>
        ) : null}
      </section>
      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4 md:grid-cols-2">
        <div>
          <div className="label">Default currency</div>
          <select className="select" disabled={disabled} value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="CAD">CAD</option>
            <option value="USD">USD</option>
          </select>
        </div>
        <div>
          <div className="label">Default deposit % (blank: full payment)</div>
          <input className="input tabular-nums" inputMode="decimal" disabled={disabled} value={deposit} onChange={(e) => setDeposit(e.target.value)} />
        </div>
        <div className="md:col-span-2">
          <div className="label">Turnaround you promise (used in the handbook)</div>
          <input className="input" disabled={disabled} value={turnaround} onChange={(e) => setTurnaround(e.target.value)} placeholder="for example: within five business days" />
        </div>
      </section>
      {isOwner ? (
        <button type="button" className="btn-primary justify-self-start" disabled={busy} onClick={save}>
          Save settings
        </button>
      ) : null}
    </div>
  );
}
