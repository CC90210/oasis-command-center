"use client";

import { useState } from "react";
import { Notice, type NoticeValue } from "@/components/os/connections/Notice";

type NumberChoice = { id: string; number: string; name: string; messaging: Record<string, string> };

export function QuoSetupPanel({ onChanged }: { onChanged: () => void }) {
  const [numbers, setNumbers] = useState<NumberChoice[]>([]);
  const [selected, setSelected] = useState("");
  const [recovery, setRecovery] = useState<{ id: string; number: string } | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [notice, setNotice] = useState<NoticeValue>(null);
  async function action(kind: "load" | "setup") {
    setBusy(true); setNotice(null);
    try {
      const response = await fetch("/api/integrations/quo/setup", {
        method: kind === "load" ? "GET" : "POST", cache: "no-store",
        ...(kind === "setup" ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ phoneNumberId: selected }) } : {}),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        if (response.status === 403) setDisabled(true);
        setNotice({ tone: "err", text: result.message || "Setup could not finish. Refresh its status before trying again." });
        if (result.error === "registration_uncertain" || result.error === "setup_in_progress") setState("creating");
        return;
      }
      if (kind === "load") {
        setNumbers(result.numbers); setState(result.state);
        setRecovery(result.selection ?? null);
        setSelected(result.selection?.id ?? (result.numbers.length === 1 ? result.numbers[0].id : ""));
        if (!result.numbers.length && result.state === "idle") setNotice({ tone: "err", text: "Your Quo account has no available phone number. Add a number in Quo first." });
      } else {
        setState("saved"); setNotice({ tone: "ok", text: result.message }); onChanged();
      }
    } catch {
      setNotice({ tone: "err", text: "OASIS could not be reached. Refresh setup status before trying again." });
      if (kind === "setup") setState("creating");
    } finally { setBusy(false); }
  }
  return (
    <section className="space-y-3 rounded-lg border border-hairline bg-bg-raised p-3">
      <h3 className="text-sm font-medium text-fg">Incoming texts and STOP replies</h3>
      <p className="text-[13px] leading-5 text-fg-muted">
        The workspace owner can choose a Quo number and connect its incoming texts here.
        OASIS stores the connection securely. This setup sends no text messages.
      </p>
      <Notice notice={notice} />
      <button type="button" className="btn-secondary" disabled={disabled || busy} onClick={() => void action("load")}>
        {busy ? "Checking…" : "Load numbers and setup status"}
      </button>
      {state === "creating" && <p className="text-[13px] text-fg-muted">A registration started, but its result needs review. Contact support before creating another connection. Automated texts remain blocked.</p>}
      {state === "needs_review" && <p className="text-[13px] text-fg-muted">The saved connection changed after setup. Contact support to reconcile it before creating another registration.</p>}
      {state === "saved" && <p className="text-[13px] text-fg-muted">Setup is saved. Text the chosen Quo number from your own phone, then use Check incoming delivery below. That check must pass before automated texts can run.</p>}
      {state === "registered" && recovery && (
        <div className="space-y-2">
          <p className="text-[13px] text-fg-muted">Incoming texts were registered for {recovery.number}. Finish saving that connection without creating another registration.</p>
          <button type="button" className="btn-primary" disabled={disabled || busy} onClick={() => void action("setup")}>Finish saving setup</button>
        </div>
      )}
      {numbers.length > 0 && state === "idle" && (
        <div className="space-y-2">
          <label htmlFor="quo-setup-number" className="label">Number for automated texts</label>
          <select id="quo-setup-number" className="input w-full" value={selected} disabled={disabled || busy} onChange={event => setSelected(event.target.value)}>
            <option value="">Choose a number</option>
            {numbers.map(number => <option key={number.id} value={number.id}>{number.name ? `${number.name} — ` : ""}{number.number}</option>)}
          </select>
          {numbers.filter(number => number.id === selected).map(number => <p key={number.id} className="text-xs text-fg-dim">Messaging: Canada {number.messaging.CA}; US {number.messaging.US}; international {number.messaging.Intl}.</p>)}
          <button type="button" className="btn-primary" disabled={disabled || busy || !selected} onClick={() => void action("setup")}>
            Connect incoming texts
          </button>
        </div>
      )}
    </section>
  );
}
