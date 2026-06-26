"use client";

/**
 * AutofillDropzone — drop a merchant application (PDF or photo). It's filed +
 * QUEUED; a VPS daemon reads it with the Claude Code CLI on CC's subscription
 * (not the metered API) and fills the application. Two modes:
 *   - "existing": POST /api/leads/[id]/autofill-application (fills the open lead)
 *   - "new":      POST /api/leads/new-from-document (creates a new lead + app)
 * Both return { queued, job_id }. We poll /api/extraction-jobs/[job_id] until the
 * fields land, then (if a signature was found) show the confirm prompt — the
 * signature only embeds on the legal PDF after the operator taps "Use it".
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, FileUp, CheckCircle2, AlertCircle, PenLine, Check, X } from "lucide-react";

type SigConfirm = { preview: string; applicationId: string; leadId: string };

const POLL_MS = 2500;
const POLL_DEADLINE_MS = 180_000; // ~3 min: CLI vision + apply, generously

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function AutofillDropzone({
  mode,
  leadId,
  tenantSlug,
  onDone,
  label,
}: {
  mode: "existing" | "new";
  leadId?: string;
  tenantSlug?: string;
  onDone?: () => void;
  label?: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false); // queued → polling the daemon
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Signature extracted from the dropped app, pending operator confirm before it
  // lands on the legal PDF (CC-approved visual reproduction + mandatory confirm).
  const [sig, setSig] = useState<SigConfirm | null>(null);
  const [sigBusy, setSigBusy] = useState(false);

  async function pollJob(jobId: string): Promise<
    | { status: "applied"; appliedKeys: number; signaturePreview: string | null; applicationId: string | null; jobLeadId: string | null }
    | { status: "failed"; error: string | null }
    | { status: "timeout" }
  > {
    const deadline = Date.now() + POLL_DEADLINE_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      let j: Record<string, unknown> = {};
      try {
        const r = await fetch(`/api/extraction-jobs/${jobId}`, { credentials: "include" });
        j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        if (!r.ok || !j.ok) continue; // transient — keep polling
      } catch {
        continue; // network blip — keep polling
      }
      const status = String(j.status || "");
      if (status === "applied") {
        return {
          status: "applied",
          appliedKeys: Array.isArray(j.applied_keys) ? j.applied_keys.length : 0,
          signaturePreview: typeof j.signature_preview === "string" ? j.signature_preview : null,
          applicationId: typeof j.application_id === "string" ? j.application_id : null,
          jobLeadId: typeof j.lead_id === "string" ? j.lead_id : null,
        };
      }
      if (status === "failed") {
        return { status: "failed", error: typeof j.error === "string" ? j.error : null };
      }
      // queued | processing | extracted → keep polling
    }
    return { status: "timeout" };
  }

  async function send(file: File) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    setSig(null);
    let jobId: string | null = null;
    try {
      const fd = new FormData();
      fd.append("file", file);
      const url =
        mode === "existing" ? `/api/leads/${leadId}/autofill-application` : `/api/leads/new-from-document`;
      const r = await fetch(url, { method: "POST", credentials: "include", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok || !j.job_id) {
        setErr(j.detail || j.error || `failed_${r.status}`);
        return;
      }
      jobId = j.job_id as string;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "network_error");
      return;
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }

    // Queued. Poll the daemon until the fields land.
    setReading(true);
    setMsg("Reading application on the subscription… this can take up to a minute.");
    try {
      const res = await pollJob(jobId);
      if (res.status === "failed") {
        setErr(res.error ? `Couldn't read it (${res.error}). Re-drop or fill manually.` : "Couldn't read the application. Re-drop or fill manually.");
        return;
      }
      if (res.status === "timeout") {
        setMsg("Still reading — the fields will appear shortly. Refresh the drawer in a moment.");
        return;
      }
      // applied
      setMsg(`Filled ${res.appliedKeys} field${res.appliedKeys === 1 ? "" : "s"} from the application.`);
      const resolvedLeadId = leadId || res.jobLeadId || "";
      if (res.signaturePreview && res.applicationId && resolvedLeadId) {
        // A signature was found — hold for the operator to confirm before it
        // lands on the PDF.
        setSig({ preview: res.signaturePreview, applicationId: res.applicationId, leadId: resolvedLeadId });
      } else if (mode === "new" && res.applicationId && tenantSlug) {
        router.push(`/t/${tenantSlug}/applications?application=${res.applicationId}`);
      } else {
        onDone?.();
      }
    } finally {
      setReading(false);
    }
  }

  // Operator's decision on the extracted signature. "Use it" embeds it on the
  // application PDF; "Skip" leaves the ruled signature line (re-sign via the pad).
  async function resolveSignature(use: boolean) {
    if (!use || !sig) {
      setSig(null);
      onDone?.();
      return;
    }
    setSigBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/leads/${sig.leadId}/application-signature`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ application_id: sig.applicationId, signature_data_uri: sig.preview }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) setMsg("Signature added to the application PDF.");
      else if (j.signature_saved)
        setErr("Signature saved, but the PDF didn't regenerate — regenerate it from the drawer.");
      else setErr(j.detail || j.error || `signature_failed_${r.status}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "network_error");
    } finally {
      setSigBusy(false);
      setSig(null);
      onDone?.();
    }
  }

  const text = label || (mode === "existing" ? "Autofill from application" : "New from application");
  const working = busy || reading;

  return (
    <div className="min-w-0">
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) send(f);
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={working}
        title="Drop a merchant application (PDF or photo). The VPS reads it on the subscription and fills the application fields automatically."
        className="inline-flex items-center gap-2 rounded-md bg-accent/10 border border-accent/30 text-accent px-3 py-1.5 text-[11.5px] font-semibold hover:bg-accent/20 disabled:opacity-50"
      >
        {working ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileUp className="w-3.5 h-3.5" />}
        {busy ? "Uploading…" : reading ? "Reading application…" : text}
      </button>
      {msg && (
        <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-status-engaged">
          <CheckCircle2 className="w-3 h-3" /> {msg}
        </div>
      )}
      {err && (
        <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-red-300">
          <AlertCircle className="w-3 h-3" /> {err}
        </div>
      )}

      {sig && (
        <div className="mt-2 max-w-[280px] rounded-lg border border-accent/30 bg-bg-deep/40 p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-fg">
            <PenLine className="h-3.5 w-3.5 text-accent" />
            Signature found — use it on the application?
          </div>
          {/* White backing so a dark ink signature reads against the dark UI. */}
          <div className="mb-2 flex items-center justify-center rounded-md border border-bg-border bg-white p-1">
            {/* eslint-disable-next-line @next/next/no-img-element -- data-URI preview, not a static asset */}
            <img src={sig.preview} alt="Extracted merchant signature" className="max-h-[64px] max-w-full object-contain" />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => resolveSignature(true)}
              disabled={sigBusy}
              className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-bg-deep disabled:opacity-60"
            >
              {sigBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Use it
            </button>
            <button
              type="button"
              onClick={() => resolveSignature(false)}
              disabled={sigBusy}
              className="inline-flex items-center gap-1 rounded-md border border-bg-border bg-bg-elev px-2.5 py-1 text-[11px] font-semibold text-fg-muted hover:text-fg disabled:opacity-60"
            >
              <X className="h-3 w-3" /> Skip
            </button>
          </div>
          <div className="mt-1.5 text-[10px] leading-snug text-fg-dim">
            Confirm this is the merchant&apos;s signature before it lands on the PDF. If it&apos;s off, Skip and use the signature pad.
          </div>
        </div>
      )}
    </div>
  );
}
