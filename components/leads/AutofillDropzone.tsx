"use client";

/**
 * AutofillDropzone — drop a merchant application (PDF or photo); Claude reads it
 * and fills the application. Two modes:
 *   - "existing": POST /api/leads/[id]/autofill-application (fills the open lead)
 *   - "new":      POST /api/leads/new-from-document (creates a new lead + app)
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, FileUp, CheckCircle2, AlertCircle, PenLine, Check, X } from "lucide-react";

type SigConfirm = { preview: string; applicationId: string };

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
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Signature extracted from the dropped app, pending operator confirm before it
  // lands on the legal PDF (CC-approved visual reproduction + mandatory confirm).
  const [sig, setSig] = useState<SigConfirm | null>(null);
  const [sigBusy, setSigBusy] = useState(false);

  async function send(file: File) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const url =
        mode === "existing"
          ? `/api/leads/${leadId}/autofill-application`
          : `/api/leads/new-from-document`;
      const r = await fetch(url, { method: "POST", credentials: "include", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setErr(j.detail || j.error || `failed_${r.status}`);
        return;
      }
      const n = Array.isArray(j.applied_keys) ? j.applied_keys.length : 0;
      setMsg(`Filled ${n} field${n === 1 ? "" : "s"} from the application.`);
      if (mode === "new" && j.application_id && tenantSlug) {
        router.push(`/t/${tenantSlug}/applications?application=${j.application_id}`);
      } else if (
        mode === "existing" &&
        typeof j.signature_preview === "string" &&
        typeof j.application_id === "string"
      ) {
        // A signature was extracted — hold for the operator to confirm it before
        // reloading (it only lands on the PDF after they tap "Use it").
        setSig({ preview: j.signature_preview, applicationId: j.application_id });
      } else {
        onDone?.();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "network_error");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  // Operator's decision on the extracted signature. "Use it" embeds it on the
  // application PDF; "Skip" leaves the ruled signature line (re-sign via the
  // signature pad). Either way we reload the drawer afterward.
  async function resolveSignature(use: boolean) {
    if (!use || !sig || !leadId) {
      setSig(null);
      onDone?.();
      return;
    }
    setSigBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/leads/${leadId}/application-signature`, {
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
        disabled={busy}
        title="Drop a merchant application (PDF or photo). AI reads it and fills the application fields automatically."
        className="inline-flex items-center gap-2 rounded-md bg-accent/10 border border-accent/30 text-accent px-3 py-1.5 text-[11.5px] font-semibold hover:bg-accent/20 disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileUp className="w-3.5 h-3.5" />}
        {busy ? "Reading application…" : text}
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
