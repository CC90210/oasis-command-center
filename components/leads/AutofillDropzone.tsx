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

/**
 * Turn the daemon's internal failure token into something a rep can act on.
 *
 * For three weeks the only thing anyone saw when an application drop broke was
 * the literal string "Couldn't read it (download_failed)." — a rep cannot tell
 * from that whether to re-drop, wait, or give up, so Ezra reasonably concluded
 * the feature was dead and went back to JotForm. The two cases need opposite
 * actions: a `blocked:` prefix means the reader is misconfigured and re-dropping
 * will fail identically every time, while anything else is worth one retry.
 *
 * The raw code is still shown in parentheses because support needs it, but it
 * is no longer the whole message.
 */
function explainFailure(error: string | null): string {
  if (!error) return "Couldn't read this application. Try dropping it again, or enter the deal manually.";
  if (error.startsWith("blocked:")) {
    return (
      "The application reader is offline, so this file can't be read automatically right now. " +
      "Nothing was saved, so enter the deal manually. The team has been alerted. " +
      `(${error})`
    );
  }
  return `Couldn't read this application. Try dropping it again, or enter the deal manually. (${error})`;
}

/**
 * Plain-language message for a failed UPLOAD (the POST that queues the job),
 * as opposed to explainFailure() above which covers a failed EXTRACTION.
 *
 * Adon, 2026-09-15: the drop "kept on getting error-coded". Half of that was a
 * real outage (Cloudflare's Browser Integrity Check answering the VPS callbacks
 * with "error code: 1010"); the other half was this screen, which printed
 * `failed_500` and stopped. A rep cannot act on a status code.
 *
 * 🚨 WHETHER ANYTHING WAS SAVED IS NOT UNIFORM — do not collapse these branches
 * back into one blanket "Nothing was saved."
 *
 * The first version of this function did exactly that, and it was WRONG for one
 * real path. The two routes differ:
 *
 *   new-from-document      uploads to a `_extraction_pending/` path and, if the
 *                          job insert then fails, REMOVES it. Nothing saved.
 *   autofill-application   calls uploadLeadDocument() FIRST, which commits a
 *                          real `lead_documents` row against the lead, and does
 *                          NOT roll it back if the job insert fails. The
 *                          document IS filed and shows on the Documents tab.
 *
 * Telling a rep "nothing was saved" there sends them to re-drop a file the lead
 * already has — the exact duplicate this screen is supposed to prevent. Every
 * size/type/role check runs BEFORE either upload, so those branches genuinely
 * did save nothing; only `queue_failed` and an unknown crash are ambiguous, and
 * an unknown crash gets a hedge rather than a promise.
 *
 * The raw code stays in parentheses so we can diagnose from a screenshot.
 */
function explainUploadFailure(
  status: number,
  detail: string | null,
  raw: string,
  mode: "existing" | "new",
): string {
  const code = detail || (raw ? raw.slice(0, 120) : `HTTP ${status}`);
  // Only claim this where the server rejected the file BEFORE storing it.
  const nothingSaved = ` Nothing was saved. (${code})`;

  // Rejected before either upload ran — safe to promise nothing was stored.
  if (status === 401 || status === 403) {
    return "Your session expired, so the upload was rejected. Reload the page, sign in again, and drop the file once more." + nothingSaved;
  }
  if (status === 413 || detail === "file_too_large") {
    return "That file is too large to upload. Split it or compress it and try again, or enter the deal manually." + nothingSaved;
  }
  if (status === 415 || detail === "unsupported_type") {
    return "That file type can't be read. Drop a PDF of the signed application." + nothingSaved;
  }
  if (detail === "empty_file" || detail === "file_required") {
    return "That file was empty, so there was nothing to read. Drop the signed application PDF." + nothingSaved;
  }
  if (status === 429) {
    return "Too many uploads at once. Wait a moment and drop the file again." + nothingSaved;
  }
  // The upload itself failed, on either route — the file never landed.
  if (detail === "upload_failed") {
    return "The file couldn't be stored, so reading it never started. Try again, or enter the deal manually." + nothingSaved;
  }
  // The file stored but the job didn't queue. THIS is where the two routes part.
  if (detail === "queue_failed") {
    return mode === "existing"
      ? "The application was filed to this lead, but reading it never started. " +
          `It's already on the Documents tab — don't drop it again, or you'll file a second copy. Fill the fields manually. (${code})`
      : "Couldn't start reading this application, and the upload was discarded, so nothing was saved. " +
          `Try again, or enter the deal manually. (${code})`;
  }
  // Unknown server failure — including the empty-bodied 500 an uncaught throw
  // produces. We do NOT know how far it got, so we do not pretend to.
  if (status >= 500 || !raw) {
    return (
      "The application reader failed before it could start. " +
      (mode === "existing"
        ? "Check the lead's Documents tab before dropping the file again, so you don't file two copies. "
        : "No new lead was created. ") +
      `Enter the deal manually, and tell APEX if it keeps happening. (${code})`
    );
  }
  return `Couldn't start reading this application. Try again, or enter the deal manually. (${code})`;
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
  // For "new" mode: the created application to navigate to AFTER the signature is
  // confirmed/skipped (Codex 2026-06-26 — a signature must not swallow the redirect).
  const [pendingRedirect, setPendingRedirect] = useState<string | null>(null);

  function goToNewApplication(applicationId: string) {
    if (tenantSlug) router.push(`/t/${tenantSlug}/applications?application=${applicationId}`);
  }

  async function pollJob(jobId: string): Promise<
    | { status: "applied"; appliedKeys: number; signaturePreview: string | null; applicationId: string | null; jobLeadId: string | null; matchedExisting: boolean }
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
          matchedExisting: j.matched_existing === true,
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
      // Read as TEXT first. `r.json()` on an empty-bodied 500 rejects, the
      // `.catch(() => ({}))` swallowed it into `{}`, and the rep was shown the
      // bare string "failed_500" — a status code with no instruction attached.
      // Keeping the raw body lets explainUploadFailure say something the rep
      // can act on, and still print the code for us.
      const raw = await r.text();
      let j: Record<string, unknown> = {};
      try {
        j = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        j = {};
      }
      if (!r.ok || !j.ok || !j.job_id) {
        setErr(
          explainUploadFailure(
            r.status,
            (typeof j.detail === "string" && j.detail) ||
              (typeof j.error === "string" && j.error) ||
              null,
            raw,
            mode,
          ),
        );
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
        setErr(explainFailure(res.error));
        return;
      }
      if (res.status === "timeout") {
        setMsg("Still reading — the fields will appear shortly. Refresh the drawer in a moment.");
        return;
      }
      // applied
      // Say when the document joined a merchant we already had. Without this the
      // rep drops a file, no new card appears, and the only way to find out why
      // is to go looking — which is how people conclude a feature is broken.
      setMsg(
        res.matchedExisting
          ? `Matched an existing merchant. Filled ${res.appliedKeys} field${res.appliedKeys === 1 ? "" : "s"} on their file instead of creating a duplicate.`
          : `Filled ${res.appliedKeys} field${res.appliedKeys === 1 ? "" : "s"} from the application.`,
      );
      const resolvedLeadId = leadId || res.jobLeadId || "";
      const newRedirect = mode === "new" && res.applicationId && tenantSlug ? res.applicationId : null;
      setPendingRedirect(newRedirect);
      if (res.signaturePreview && res.applicationId && resolvedLeadId) {
        // A signature was found — hold for the operator to confirm before it
        // lands on the PDF. The new-mode redirect (if any) runs after confirm.
        setSig({ preview: res.signaturePreview, applicationId: res.applicationId, leadId: resolvedLeadId });
      } else if (newRedirect) {
        goToNewApplication(newRedirect);
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
      if (pendingRedirect) goToNewApplication(pendingRedirect);
      else onDone?.();
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
      if (pendingRedirect) goToNewApplication(pendingRedirect);
      else onDone?.();
    }
  }

  const text = label || (mode === "existing" ? "Autofill from application" : "New Form Application");
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
