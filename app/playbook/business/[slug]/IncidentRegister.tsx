"use client";

/**
 * The Law 25 incident register's entries, and the form that appends one
 * (founders only; the page renders this only for a founder). Append-only: the
 * form adds a new entry; a correction is a new entry that names the one it
 * corrects. Nothing is edited or deleted.
 *
 * Each entry shows its short id and a Correct button. The button opens the
 * form filled with that entry's values and its full id as the entry corrected
 * (lib/playbook/incidents.ts correctionDraft): the route refuses a correction
 * that names no real entry, and the ids are not typed by hand.
 */

import { useState } from "react";
import { correctionDraft } from "@/lib/playbook/incidents";
import type { Incident } from "@/lib/playbook/store";

const FIELD = "w-full rounded-md border border-hairline bg-bg-elev px-2.5 py-1.5 text-sm text-fg";
const LABEL = "text-xs font-medium text-fg-muted";

const shortId = (id: string) => id.slice(0, 8);

export function IncidentRegister({ incidents, state }: { incidents: Incident[] | null; state: "ok" | "table_missing" | "read_failed" }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({ serious_risk: "unknown" });
  const set = (k: string) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function startCorrection(entry: Incident) {
    setForm(correctionDraft(entry));
    setError(null);
    setConfirming(false);
    setOpen(true);
  }

  function startNew() {
    setForm({ serious_risk: "unknown" });
    setError(null);
    setConfirming(false);
    setOpen(true);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/playbook/incidents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; field?: string; message?: string; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.field ? `Check the field "${data.field.replace(/_/g, " ")}".` : data.message || data.error || `The server answered ${res.status}.`);
        return;
      }
      setOpen(false);
      setConfirming(false);
      setForm({ serious_risk: "unknown" });
      // A reload reads the register as saved (see DocActions on router.refresh).
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The request did not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (state === "table_missing") {
    return <p className="text-sm text-fg-muted">The register&apos;s storage is not set up yet (migration bravo__194), so entries cannot be recorded here yet.</p>;
  }
  if (state === "read_failed" || incidents === null) {
    return <p className="text-sm text-fg-muted">The register could not be read just now. Refresh to try again; nothing is shown in place of the real entries.</p>;
  }

  const correcting = form.corrects_id ? form.corrects_id : null;

  return (
    <div className="space-y-4">
      {incidents.length === 0 ? (
        <p className="text-sm text-fg-muted">No incidents recorded.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-fg-dim">
              <tr>
                <th className="py-1.5 pr-3 font-medium">Entry</th>
                <th className="py-1.5 pr-3 font-medium">Aware</th>
                <th className="py-1.5 pr-3 font-medium">When</th>
                <th className="py-1.5 pr-3 font-medium">Information</th>
                <th className="py-1.5 pr-3 font-medium">People</th>
                <th className="py-1.5 pr-3 font-medium">Serious risk</th>
                <th className="py-1.5 pr-3 font-medium">Notified (CAI / people)</th>
                <th className="py-1.5 pr-3 font-medium">Recorded</th>
                <th className="py-1.5 font-medium"><span className="sr-only">Correct</span></th>
              </tr>
            </thead>
            <tbody className="text-fg-muted">
              {incidents.map((i) => (
                <tr key={i.id} className="border-t border-hairline align-top">
                  <td className="py-1.5 pr-3 font-mono" title={i.id}>{shortId(i.id)}</td>
                  <td className="py-1.5 pr-3">{i.aware_at}</td>
                  <td className="py-1.5 pr-3">{i.occurred_period}</td>
                  <td className="py-1.5 pr-3">
                    {i.personal_info}
                    <div className="text-fg-dim">{i.circumstances}</div>
                    {i.corrects_id && <div className="text-fg-dim">Corrects entry {shortId(i.corrects_id)}</div>}
                  </td>
                  <td className="py-1.5 pr-3">{i.persons_count === null ? "Not yet known" : i.persons_count}</td>
                  <td className="py-1.5 pr-3">{i.serious_risk === null ? "Not yet assessed" : i.serious_risk === 1 ? "Yes" : "No"}</td>
                  <td className="py-1.5 pr-3">
                    {i.cai_notified_at ?? "Not notified"} / {i.persons_notified_at ?? "Not notified"}
                  </td>
                  <td className="py-1.5 pr-3">{i.recorded_at.slice(0, 10)} by {i.recorded_by}</td>
                  <td className="py-1.5">
                    <button
                      type="button"
                      className="text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                      aria-label={`Correct entry ${shortId(i.id)}`}
                      onClick={() => startCorrection(i)}
                    >
                      Correct
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!open ? (
        <button type="button" className="btn-primary" onClick={startNew}>Record an incident</button>
      ) : (
        <div className="space-y-3 rounded-lg border border-hairline p-3">
          {correcting && (
            <p className="text-sm text-fg">
              Correcting entry <span className="font-mono">{shortId(correcting)}</span>. Change what was wrong and record it; the original entry stays in the register as it was.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1"><span className={LABEL}>Personal information concerned</span><textarea className={FIELD} value={form.personal_info ?? ""} onChange={set("personal_info")} /></label>
            <label className="space-y-1"><span className={LABEL}>What happened</span><textarea className={FIELD} value={form.circumstances ?? ""} onChange={set("circumstances")} /></label>
            <label className="space-y-1"><span className={LABEL}>When it happened (date or period)</span><input className={FIELD} value={form.occurred_period ?? ""} onChange={set("occurred_period")} /></label>
            <label className="space-y-1"><span className={LABEL}>Date OASIS became aware</span><input type="date" className={FIELD} value={form.aware_at ?? ""} onChange={set("aware_at")} /></label>
            <label className="space-y-1"><span className={LABEL}>People concerned (leave empty if not yet known)</span><input inputMode="numeric" className={FIELD} value={form.persons_count ?? ""} onChange={set("persons_count")} /></label>
            <label className="space-y-1">
              <span className={LABEL}>Risk of serious injury</span>
              <select className={FIELD} value={form.serious_risk ?? "unknown"} onChange={set("serious_risk")}>
                <option value="unknown">Not yet assessed</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
            <label className="space-y-1 sm:col-span-2"><span className={LABEL}>What the risk assessment rests on</span><textarea className={FIELD} value={form.risk_assessment ?? ""} onChange={set("risk_assessment")} /></label>
            <label className="space-y-1"><span className={LABEL}>Commission notified on (if notified)</span><input type="date" className={FIELD} value={form.cai_notified_at ?? ""} onChange={set("cai_notified_at")} /></label>
            <label className="space-y-1"><span className={LABEL}>People notified on (if notified)</span><input type="date" className={FIELD} value={form.persons_notified_at ?? ""} onChange={set("persons_notified_at")} /></label>
            <label className="space-y-1 sm:col-span-2"><span className={LABEL}>Measures taken to reduce the risk</span><textarea className={FIELD} value={form.measures ?? ""} onChange={set("measures")} /></label>
          </div>
          {error && <p role="alert" className="text-sm text-status-hot">{error}</p>}
          {confirming ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-fg">
              An entry cannot be edited or deleted once recorded. Record it?
              <button type="button" className="btn-primary" disabled={busy} onClick={submit}>{busy ? "Recording..." : "Yes, record it"}</button>
              <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={() => setConfirming(false)}>Back</button>
            </div>
          ) : (
            <div className="flex gap-2">
              <button type="button" className="btn-primary" onClick={() => setConfirming(true)}>{correcting ? "Record the correction" : "Record"}</button>
              <button type="button" className="text-xs text-fg-muted hover:text-fg" onClick={() => { setOpen(false); setForm({ serious_risk: "unknown" }); }}>Cancel</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
