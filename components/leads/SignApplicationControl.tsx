"use client";

/**
 * SignApplicationControl — "Sign application" button + inline signature-pad
 * modal for the lead/application drawer header actions.
 *
 * Single-signer, inline, immediate: the logged-in REP presses Sign, draws
 * THEIR OWN signature, and it's stamped at the application's existing
 * signature line (POST /api/leads/[id]/sign-application). This replaces the
 * removed standalone "E-Sign" nav tab for the SunBiz single-signature
 * application case (2026-07-09) — the multi-signer envelope flow
 * (components/esign/*) is a separate, unrelated project and is untouched.
 *
 * Reuses the SAME signature-capture canvas the merchant-facing
 * full-application form and the e-sign /sign/[token] page use
 * (components/forms/SignaturePad.tsx's `SignatureField`) — one
 * signature-capture implementation across the app.
 *
 * `hasApplication`/`currentlySigned` are BEST-EFFORT display hints from the
 * drawer's already-loaded `application` prop — for a lead they can read
 * stale/false-negative pre-"Transfer to Application" (the detail route's
 * listRecords() lookup only surfaces PROMOTED applications; see the route's
 * own comment). So the button stays enabled either way and the server is the
 * actual source of truth: a lead with no application record yet returns a
 * friendly `no_application` error instead of silently no-op'ing.
 */

import { useState } from "react";
import { AlertCircle, Check, CheckCircle2, Loader2, PenLine, X } from "lucide-react";
import { SignatureField } from "@/components/forms/SignaturePad";

export function SignApplicationControl({
  leadId,
  entity,
  currentlySigned,
  signerName,
  onSigned,
}: {
  leadId: string;
  entity: "lead" | "application";
  currentlySigned: boolean;
  signerName?: string | null;
  onSigned?: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [sig, setSig] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function openModal() {
    setDone(null);
    setErr(null);
    setSig("");
    setOpen(true);
  }

  function close() {
    if (busy) return;
    setOpen(false);
    setSig("");
    setErr(null);
  }

  async function submit() {
    if (!sig) return;
    setBusy(true);
    setErr(null);
    try {
      const qs = entity === "application" ? "?entity=application" : "";
      const r = await fetch(`/api/leads/${leadId}/sign-application${qs}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signatureDataUri: sig }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        setDone("Signature added to the application.");
        setOpen(false);
        setSig("");
        await onSigned?.();
        return;
      }
      if (j.error === "no_application") {
        setErr("This lead doesn't have an application yet — complete or transfer the application first.");
      } else if (j.signature_saved) {
        setErr("Signature saved, but the PDF didn't regenerate — try again in a moment.");
      } else if (j.error === "forbidden_role") {
        setErr("Read-only members can't sign applications.");
      } else {
        setErr(j.detail || j.error || `sign_failed_${r.status}`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "network_error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={openModal}
        title={
          currentlySigned
            ? `Currently signed${signerName ? ` by ${signerName}` : ""}. Sign again to replace it.`
            : "Draw your signature onto this application's signature line."
        }
        className="inline-flex items-center gap-2 rounded-md bg-accent/10 border border-accent/30 text-accent px-3 py-1.5 text-[11.5px] font-semibold hover:bg-accent/20"
      >
        <PenLine className="w-3.5 h-3.5" />
        {currentlySigned ? "Re-sign application" : "Sign application"}
      </button>
      {currentlySigned && (
        <span className="ml-2 inline-flex items-center gap-1 text-[10.5px] text-status-good">
          <CheckCircle2 className="w-3 h-3" /> Signed{signerName ? ` by ${signerName}` : ""}
        </span>
      )}
      {done && !open && (
        <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-status-engaged">
          <CheckCircle2 className="w-3 h-3" /> {done}
        </div>
      )}

      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
          role="dialog"
          aria-modal="true"
          aria-label="Sign application"
          onClick={close}
        >
          <div
            className="w-full max-w-sm rounded-xl border border-bg-border bg-bg-elev p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-bold text-fg">
              <PenLine className="h-3.5 w-3.5 text-accent" />
              {currentlySigned ? "Re-sign application" : "Sign application"}
            </div>
            <p className="mb-2 text-[11px] text-fg-dim leading-snug">
              This puts YOUR signature on the application&apos;s signature line
              {currentlySigned ? ", replacing the current one." : "."}
            </p>
            <SignatureField value={sig} onChange={setSig} />
            {err && (
              <div className="mt-2 inline-flex items-start gap-1 text-[11px] text-red-300">
                <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" /> {err}
              </div>
            )}
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={submit}
                disabled={!sig || busy}
                className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-bg-deep disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Sign &amp; save
              </button>
              <button
                type="button"
                onClick={close}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-md border border-bg-border bg-bg-deep px-3 py-1.5 text-[11px] font-semibold text-fg-muted hover:text-fg disabled:opacity-60"
              >
                <X className="h-3 w-3" /> Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
