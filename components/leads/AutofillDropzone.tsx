"use client";

/**
 * AutofillDropzone — drop a merchant application (PDF or photo); Claude reads it
 * and fills the application. Two modes:
 *   - "existing": POST /api/leads/[id]/autofill-application (fills the open lead)
 *   - "new":      POST /api/leads/new-from-document (creates a new lead + app)
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, FileUp, CheckCircle2, AlertCircle } from "lucide-react";

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
    </div>
  );
}
