"use client";

/**
 * SignClient — the interactive part of the public /sign/[token] page.
 *
 * Draw-signature capture reuses the SAME component the full-application
 * public form already uses (components/forms/SignaturePad.tsx's exported
 * `SignatureField` — canvas + signature_pad@5.1.3, PNG data-URI on stroke
 * end) rather than a fresh implementation. A typed-name toggle sits next
 * to it (rendered in the same italic-serif "script style" the appended PDF
 * certificate page uses — lib/esign/pdf.ts's StandardFonts.TimesRomanItalic)
 * since a from-scratch signature isn't always practical on a desktop
 * trackpad.
 *
 * The source PDF is iframed from the token-gated /api/sign/[token]/pdf
 * endpoint (a real URL with Content-Type: application/pdf) so the browser's
 * native PDF viewer loads it directly. A client-built blob:/data: URL was
 * unreliable (blank iframe in some browsers). An "Open in new tab" fallback
 * link points at the same URL.
 */

import { useState } from "react";
import { CheckCircle2, AlertCircle, Loader2, PenLine, Type as TypeIcon } from "lucide-react";
import { SignatureField } from "@/components/forms/SignaturePad";

type Props = {
  token: string;
  envelopeTitle: string;
  message: string | null;
  signerName: string;
  consentDisclosureVersion: string;
  sourcePdfBase64: string;
};

type Mode = "draw" | "type";
type ViewState = "signing" | "submitting" | "signed" | "declined" | "error";

// The source PDF is served from the token-gated /api/sign/[token]/pdf endpoint
// and iframed directly (a client-built blob:/data: URL rendered blank in some
// browsers).

const DISCLOSURE_TEXT =
  "By checking this box and clicking Sign, you agree to use an electronic signature and electronic records for this document, in place of a handwritten signature and paper records. You confirm you can access and view this document, and you consent to conduct this transaction electronically, consistent with the U.S. ESIGN Act and UETA. You may withdraw consent at any time before signing by closing this page.";

export function SignClient({
  token,
  envelopeTitle,
  message,
  signerName,
  consentDisclosureVersion,
}: Props) {
  const pdfUrl = `/api/sign/${encodeURIComponent(token)}/pdf`;

  const [mode, setMode] = useState<Mode>("draw");
  const [drawnSignature, setDrawnSignature] = useState("");
  const [typedName, setTypedName] = useState(signerName || "");
  const [consented, setConsented] = useState(false);
  const [view, setView] = useState<ViewState>("signing");
  const [error, setError] = useState<string | null>(null);
  const [showDecline, setShowDecline] = useState(false);
  const [declineReason, setDeclineReason] = useState("");

  const hasSignature = mode === "draw" ? !!drawnSignature : typedName.trim().length > 0;
  const canSubmit = hasSignature && consented && view !== "submitting";

  async function submitSign() {
    if (!canSubmit) return;
    setView("submitting");
    setError(null);
    try {
      const res = await fetch(`/api/sign/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consented: true,
          signatureDataUri: mode === "draw" ? drawnSignature : undefined,
          typedName: mode === "type" ? typedName.trim() : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setView("error");
        setError("We couldn't record your signature. The link may have expired — ask for a fresh one.");
        return;
      }
      setView("signed");
    } catch {
      setView("error");
      setError("Network error — check your connection and try again.");
    }
  }

  async function submitDecline() {
    setView("submitting");
    setError(null);
    try {
      const res = await fetch(`/api/sign/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decline: true, declineReason: declineReason.trim().slice(0, 500) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setView("error");
        setError("We couldn't record your decline. The link may have expired.");
        return;
      }
      setView("declined");
    } catch {
      setView("error");
      setError("Network error — check your connection and try again.");
    }
  }

  if (view === "signed") {
    return (
      <CenteredCard>
        <CheckCircle2 className="h-10 w-10 text-status-good mx-auto" />
        <h1 className="text-xl font-bold mt-3">You&apos;re all set</h1>
        <p className="text-sm text-fg-muted mt-2 leading-relaxed">
          Your signature on <strong className="text-fg">{envelopeTitle}</strong> has been recorded. You
          can close this page.
        </p>
      </CenteredCard>
    );
  }

  if (view === "declined") {
    return (
      <CenteredCard>
        <AlertCircle className="h-10 w-10 text-status-warm mx-auto" />
        <h1 className="text-xl font-bold mt-3">You declined to sign</h1>
        <p className="text-sm text-fg-muted mt-2 leading-relaxed">
          We&apos;ve recorded that you declined <strong className="text-fg">{envelopeTitle}</strong>.
          Whoever sent this will be notified.
        </p>
      </CenteredCard>
    );
  }

  return (
    <main className="min-h-screen bg-bg-deep text-fg px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-3xl space-y-4">
        <header className="space-y-1">
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-fg-dim">OASIS E-Sign</div>
          <h1 className="text-lg sm:text-xl font-bold">{envelopeTitle}</h1>
          <p className="text-xs text-fg-muted">
            Requested for {signerName ? <span className="text-fg">{signerName}</span> : "you"}
          </p>
          {message && (
            <div className="rounded-md border border-bg-border bg-bg-elev/60 px-3 py-2 text-xs text-fg-muted leading-relaxed mt-2">
              {message}
            </div>
          )}
        </header>

        <div className="rounded-xl border border-bg-border bg-bg-panel overflow-hidden">
          {pdfUrl ? (
            <>
              <iframe src={pdfUrl} title="Document to sign" className="w-full" style={{ height: "60vh", minHeight: 360, border: "none" }} />
              <div className="px-3 py-2 border-t border-bg-border text-[11px] text-fg-dim">
                Not rendering?{" "}
                <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-fg">
                  Open the PDF in a new tab
                </a>
                .
              </div>
            </>
          ) : (
            <div className="p-6 text-sm text-fg-muted">Couldn&apos;t render the document preview.</div>
          )}
        </div>

        {!showDecline ? (
          <div className="rounded-xl border border-bg-border bg-bg-panel p-4 sm:p-5 space-y-4">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setMode("draw")}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold border ${mode === "draw" ? "bg-bg-elev border-accent text-fg" : "border-bg-border text-fg-muted hover:text-fg"}`}
              >
                <PenLine className="h-3.5 w-3.5" /> Draw
              </button>
              <button
                type="button"
                onClick={() => setMode("type")}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold border ${mode === "type" ? "bg-bg-elev border-accent text-fg" : "border-bg-border text-fg-muted hover:text-fg"}`}
              >
                <TypeIcon className="h-3.5 w-3.5" /> Type
              </button>
            </div>

            {mode === "draw" ? (
              <SignatureField value={drawnSignature} onChange={setDrawnSignature} />
            ) : (
              <div className="space-y-1.5">
                <input
                  type="text"
                  value={typedName}
                  onChange={(e) => setTypedName(e.target.value)}
                  placeholder="Type your full legal name"
                  className="w-full rounded-md border border-bg-border bg-bg-deep px-3 py-2 text-sm text-fg"
                />
                {typedName.trim() && (
                  <div className="rounded-md border border-bg-border bg-white px-4 py-3">
                    <span style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontStyle: "italic", fontSize: 28, color: "#1f2937" }}>
                      {typedName.trim()}
                    </span>
                  </div>
                )}
              </div>
            )}

            <label className="flex items-start gap-2.5 text-[11px] text-fg-muted leading-relaxed cursor-pointer">
              <input
                type="checkbox"
                checked={consented}
                onChange={(e) => setConsented(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5"
              />
              <span>
                {DISCLOSURE_TEXT}
                <span className="text-fg-dim"> (disclosure {consentDisclosureVersion})</span>
              </span>
            </label>

            {error && <p className="text-xs text-status-hot">{error}</p>}

            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                onClick={() => setShowDecline(true)}
                className="text-xs text-fg-dim hover:text-fg underline-offset-2 hover:underline"
              >
                I don&apos;t want to sign this
              </button>
              <button
                type="button"
                onClick={submitSign}
                disabled={!canSubmit}
                className="ml-auto inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-bold text-white shadow-sm disabled:opacity-40"
              >
                {view === "submitting" && <Loader2 className="h-4 w-4 animate-spin" />}
                Sign &amp; Submit
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-bg-border bg-bg-panel p-4 sm:p-5 space-y-3">
            <h2 className="text-sm font-bold">Decline to sign</h2>
            <p className="text-xs text-fg-muted">Optional — let them know why.</p>
            <textarea
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-bg-border bg-bg-deep px-3 py-2 text-sm text-fg"
              placeholder="Reason (optional)"
            />
            {error && <p className="text-xs text-status-hot">{error}</p>}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setShowDecline(false)}
                className="text-xs text-fg-muted hover:text-fg underline-offset-2 hover:underline"
              >
                ← Back to signing
              </button>
              <button
                type="button"
                onClick={submitDecline}
                disabled={view === "submitting"}
                className="ml-auto inline-flex items-center gap-2 rounded-lg border border-status-hot/50 bg-status-hot/10 px-5 py-2.5 text-sm font-bold text-status-hot disabled:opacity-40"
              >
                {view === "submitting" && <Loader2 className="h-4 w-4 animate-spin" />}
                Confirm decline
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-bg-deep text-fg flex items-center justify-center px-6 py-10">
      <div className="max-w-md w-full rounded-2xl border border-bg-border bg-bg-elev/50 p-8 text-center">{children}</div>
    </main>
  );
}
