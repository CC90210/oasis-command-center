"use client";

/**
 * BackgroundCheckTab — the "BGC" tab in the lead drawer. Reads the lead's latest
 * merchant_background_checks row, auto-polls while a check is running, and lets the
 * operator run/re-run a check or enter results by hand. Mirrors the BankTab
 * (underwriting) fetch + 5s-poll pattern.
 */

import { useCallback, useEffect, useRef, useState } from "react";

type Finding = {
  source?: string;
  court?: string;
  index_number?: string;
  caption?: string;
  filed_date?: string;
  case_type?: string;
  risk?: string;
  match_confidence?: number;
  matched_on?: string[];
};
type Check = {
  id: string;
  status: "pending" | "running" | "completed" | "error" | "needs_assist";
  risk_flag: "none" | "court_case" | "mca_default" | "ucc" | "lien" | "bankruptcy" | "unknown";
  findings: Finding[] | null;
  findings_summary: string | null;
  sources_run: string[] | null;
  error: string | null;
  checked_at: string | null;
  created_at: string;
};

const RISK_LABEL: Record<string, string> = {
  none: "Clear",
  court_case: "Court case",
  mca_default: "MCA default",
  ucc: "UCC filing",
  lien: "Tax lien",
  bankruptcy: "Bankruptcy",
  unknown: "Unverified",
};
function riskColor(flag: string): string {
  if (flag === "none") return "#1f7a4d";
  if (flag === "mca_default") return "#b42318";
  if (flag === "unknown") return "#667085";
  return "#b54708"; // court/ucc/lien/bankruptcy
}
function statusLabel(s: Check["status"]): string {
  return {
    pending: "Queued…",
    running: "Searching court records…",
    completed: "Complete",
    error: "Error",
    needs_assist: "Needs manual run",
  }[s];
}

export function BackgroundCheckTab({ leadId }: { leadId: string; record?: Record<string, unknown> }) {
  const [check, setCheck] = useState<Check | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [manualText, setManualText] = useState("");
  const [manualRisk, setManualRisk] = useState("court_case");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/leads/${leadId}/background-check/latest`, { cache: "no-store" });
      const j = await r.json();
      setCheck(j.check ?? null);
      setErr(null);
    } catch {
      setErr("Could not load the background check.");
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    load();
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [load]);

  // Poll every 5s while a run is in flight.
  useEffect(() => {
    if (check && (check.status === "pending" || check.status === "running")) {
      timer.current = setTimeout(load, 5000);
      return () => { if (timer.current) clearTimeout(timer.current); };
    }
  }, [check, load]);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/leads/${leadId}/background-check/run`, { method: "POST" });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "run_failed"); }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start the check.");
    } finally {
      setBusy(false);
    }
  }

  async function submitManual() {
    if (!manualText.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/leads/${leadId}/background-check/manual-result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ findings_summary: manualText.trim(), risk_flag: manualRisk }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "save_failed"); }
      setShowManual(false);
      setManualText("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save results.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="text-xs text-fg-dim italic py-6 text-center">Loading…</div>;

  const findings = check?.findings ?? [];
  const inFlight = check?.status === "pending" || check?.status === "running";

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium">Background check</div>
        <button
          onClick={run}
          disabled={busy || inFlight}
          className="text-xs px-2 py-1 rounded border border-border disabled:opacity-50"
        >
          {check ? "Re-run" : "Run check"}
        </button>
      </div>

      {!check && (
        <div className="text-xs text-fg-dim">
          No background check yet. It runs automatically when the application is signed, or run it now.
        </div>
      )}

      {check && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-fg-dim">{statusLabel(check.status)}</span>
            {check.status === "completed" && (
              <span
                className="text-xs px-2 py-0.5 rounded-full text-white"
                style={{ backgroundColor: riskColor(check.risk_flag) }}
              >
                {RISK_LABEL[check.risk_flag] ?? check.risk_flag}
              </span>
            )}
            {check.sources_run?.length ? (
              <span className="text-[10px] text-fg-dim">via {check.sources_run.join(", ")}</span>
            ) : null}
          </div>

          {check.findings_summary && <div className="text-xs">{check.findings_summary}</div>}
          {check.error && <div className="text-xs" style={{ color: "#b42318" }}>{check.error}</div>}

          {check.status === "needs_assist" && (
            <div className="text-xs text-fg-dim">
              Automated court search was blocked. Run the search manually, then enter the results below.
            </div>
          )}

          {findings.length > 0 && (
            <div className="space-y-2">
              {findings.map((f, i) => (
                <div key={i} className="rounded border border-border p-2 text-xs space-y-0.5">
                  <div className="font-medium">{f.caption || f.index_number || `Record ${i + 1}`}</div>
                  <div className="text-fg-dim">
                    {[f.court, f.case_type, f.filed_date].filter(Boolean).join(" · ")}
                  </div>
                  <div className="flex items-center gap-2">
                    {typeof f.match_confidence === "number" && (
                      <span className={f.match_confidence >= 0.55 ? "" : "text-fg-dim"}>
                        match {Math.round(f.match_confidence * 100)}%
                        {f.match_confidence < 0.55 ? " (verify)" : ""}
                      </span>
                    )}
                    {f.matched_on?.length ? <span className="text-fg-dim">on {f.matched_on.join(", ")}</span> : null}
                    {f.source ? <span className="text-fg-dim">[{f.source}]</span> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {err && <div className="text-xs" style={{ color: "#b42318" }}>{err}</div>}

      <div>
        <button onClick={() => setShowManual((v) => !v)} className="text-xs text-fg-dim underline">
          {showManual ? "Cancel manual entry" : "Enter results manually"}
        </button>
        {showManual && (
          <div className="mt-2 space-y-2">
            <textarea
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              rows={4}
              placeholder="Paste / summarize what the manual search found…"
              className="w-full text-xs rounded border border-border p-2 bg-transparent"
            />
            <div className="flex items-center gap-2">
              <select
                value={manualRisk}
                onChange={(e) => setManualRisk(e.target.value)}
                className="text-xs rounded border border-border p-1 bg-transparent"
              >
                {Object.entries(RISK_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <button
                onClick={submitManual}
                disabled={busy || !manualText.trim()}
                className="text-xs px-2 py-1 rounded border border-border disabled:opacity-50"
              >
                Save results
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
