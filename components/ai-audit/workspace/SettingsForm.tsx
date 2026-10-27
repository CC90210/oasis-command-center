"use client";

/**
 * The workspace's AI audit settings. The tax rule has no default on purpose:
 * whether OASIS charges GST/HST, and at what rate, is CC's to say, and no
 * proposal can be submitted until he does.
 *
 * The exchange rate is CC's too: USD is the core currency, and a client who
 * pays in CAD gets the USD prices converted at the rate saved here. "Use the
 * Bank of Canada rate" only fills the field; nothing changes until he saves.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AiAuditSettings } from "@/lib/ai-audit/store";
import { describeError, postJson, type ActionResult } from "./api";

export function SettingsForm({ settings, rowVersion, isOwner }: { settings: AiAuditSettings; rowVersion: number; isOwner: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<string>(settings.tax ? settings.tax.mode : "");
  const [rate, setRate] = useState(settings.tax && settings.tax.mode === "registered" ? String(settings.tax.rate_bps / 100) : "13");
  const [label, setLabel] = useState(settings.tax && settings.tax.mode === "registered" ? settings.tax.label : "HST");
  const [number, setNumber] = useState(settings.tax && settings.tax.mode === "registered" ? settings.tax.number ?? "" : "");
  const [deposit, setDeposit] = useState(settings.deposit_bps ? String(settings.deposit_bps / 100) : "");
  const [currency, setCurrency] = useState<string>(settings.default_currency);
  const [turnaround, setTurnaround] = useState(settings.turnaround);
  const [fxRate, setFxRate] = useState(settings.fx_usd_cad ? (settings.fx_usd_cad.rate_ppm / 1_000_000).toFixed(4) : "");
  const [fxAsOf, setFxAsOf] = useState(settings.fx_usd_cad?.as_of ?? "");
  const [fxSource, setFxSource] = useState<"bank_of_canada" | "owner">(settings.fx_usd_cad?.source ?? "owner");

  async function lookUpRate() {
    setBusy(true);
    setMessage(null);
    let r: ActionResult;
    try {
      const res = await fetch("/api/ai-audit/settings/fx", { cache: "no-store" });
      r = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as ActionResult;
    } catch {
      r = { ok: false, error: "network_error" };
    }
    setBusy(false);
    const rate = r.ok && r.rate && typeof r.rate === "object" ? (r.rate as { rate_ppm?: unknown; as_of?: unknown }) : null;
    if (!rate || typeof rate.rate_ppm !== "number" || typeof rate.as_of !== "string") {
      setMessage(describeError(r.ok ? { ok: false, error: "fx_unreadable" } : r));
      return;
    }
    setFxRate((rate.rate_ppm / 1_000_000).toFixed(4));
    setFxAsOf(rate.as_of);
    setFxSource("bank_of_canada");
    setMessage(`The Bank of Canada's rate for ${rate.as_of} is filled in. Save the settings to use it.`);
  }
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setMessage(null);
    const tax = mode === "registered" ? { mode: "registered", rate_bps: Math.round(Number(rate) * 100), label, number } : mode === "not_registered" ? { mode: "not_registered" } : null;
    const fxNumber = Number(fxRate.trim());
    if (fxRate.trim() && !(fxNumber >= 0.5 && fxNumber <= 3)) {
      setBusy(false);
      setMessage("The exchange rate is CAD for one USD, between 0.5 and 3 (for example 1.4025).");
      return;
    }
    const fx_usd_cad = fxRate.trim() ? { rate_ppm: Math.round(fxNumber * 1_000_000), as_of: fxAsOf || new Date().toISOString().slice(0, 10), source: fxSource } : null;
    const r = await postJson("/api/ai-audit/settings", {
      settings: { tax, deposit_bps: deposit ? Math.round(Number(deposit) * 100) : null, default_currency: currency, engine: settings.engine, turnaround, fx_usd_cad },
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
            <option value="USD">USD</option>
            <option value="CAD">CAD</option>
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
      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
        <h2 className="text-sm font-semibold text-fg">Exchange rate for CAD proposals</h2>
        <p className="text-[13px] text-fg-muted">
          Prices are in USD. When a client would rather pay in CAD, switch their proposal to CAD and every catalogue price is converted at this rate. The rate used is shown on each line and to the
          client. Leave it empty and CAD proposals use only prices you type.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <div className="label">CAD for 1 USD</div>
            <input
              className="input w-32 tabular-nums"
              inputMode="decimal"
              disabled={disabled}
              value={fxRate}
              placeholder="1.4025"
              onChange={(e) => {
                setFxRate(e.target.value);
                setFxSource("owner");
                setFxAsOf(new Date().toISOString().slice(0, 10));
              }}
            />
          </div>
          {isOwner ? (
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void lookUpRate()}>
              Use the Bank of Canada rate
            </button>
          ) : null}
          {fxRate.trim() && fxAsOf ? (
            <span className="self-center text-[12px] text-fg-dim">
              {fxSource === "bank_of_canada" ? "Bank of Canada" : "Typed by you"}, {fxAsOf}
            </span>
          ) : null}
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
