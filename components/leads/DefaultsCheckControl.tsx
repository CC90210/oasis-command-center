"use client";

/**
 * DefaultsCheckControl — the one-click "Search for defaults" action on the Docs
 * tab. Two ways in, same pipeline:
 *   1. Button → enqueue a background check on the lead's existing application data
 *      (POST /api/leads/[id]/background-check/run). The JARVIS bg-check-worker
 *      runs the NYSCEF court search + MCA-default cross-ref; results land in BGC.
 *   2. Drop an application file → AutofillDropzone loads the application onto the
 *      lead (extract-on-subscription), then onDone enqueues the same check — for
 *      a lead whose application we have as a file from before.
 */

import { useState } from "react";
import { Loader2, ShieldAlert, CheckCircle2, AlertCircle } from "lucide-react";
import { AutofillDropzone } from "./AutofillDropzone";

export function DefaultsCheckControl({ leadId }: { leadId: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function runCheck() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch(`/api/leads/${leadId}/background-check/run`, {
        method: "POST",
        credentials: "include",
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `failed_${r.status}`);
      setMsg(
        j.reused
          ? "A check is already running — open the BGC tab to watch."
          : "Default search started — open the BGC tab to watch results.",
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could_not_start");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-bg-border bg-bg-deep/30 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-fg">
        <ShieldAlert className="h-3.5 w-3.5 text-accent" /> Background check
      </div>
      <div className="text-[11px] text-fg-dim">
        Search NY court records for prior defaults, judgments, and lawsuits using this lead&apos;s
        application. Results land in the BGC tab.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={runCheck}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-md bg-accent/10 border border-accent/30 text-accent px-3 py-1.5 text-[11.5px] font-semibold hover:bg-accent/20 disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldAlert className="w-3.5 h-3.5" />}
          {busy ? "Starting…" : "Search for defaults"}
        </button>
        <AutofillDropzone
          mode="existing"
          leadId={leadId}
          onDone={runCheck}
          label="…or drop an application to load + check"
        />
      </div>
      {msg && (
        <div className="inline-flex items-center gap-1 text-[11px] text-status-engaged">
          <CheckCircle2 className="w-3 h-3" /> {msg}
        </div>
      )}
      {err && (
        <div className="inline-flex items-center gap-1 text-[11px] text-red-300">
          <AlertCircle className="w-3 h-3" /> {err}
        </div>
      )}
    </div>
  );
}
