"use client";

/**
 * ConfirmModal — Adon spec section 4 + 7 (2026-06-10).
 *
 * The single gate between the operator clicking "Send shop-out" on the
 * panel and the POST to /api/applications/[id]/shop-out/run. There is
 * NO double-confirm; this is the only modal.
 *
 * Exact text (Adon spec 4):
 *
 *   You are about to send {N} submission{plural} for {merchant_legal_name}.
 *
 *   CC list: {comma-separated emails, or "(none)"}
 *   Signing as: {agent name OR "SunBiz Submissions"}
 *   Sending from: submissions@sunbizfunding.com
 *
 *   Confirm? [Cancel] [Send]
 *
 * Wrapped in a dialog with overlay + focus trap on the Send button.
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

type Props = {
  open: boolean;
  fundersCount: number;
  merchantName: string;
  ccEmails: string[];
  signerName: string;
  fromAddress: string;
  /** Wired to the parent's "fire POST" handler. */
  onSend: () => void;
  onCancel: () => void;
  /** Disable Send while a run is in flight (parent flips this true at fire-time). */
  sending?: boolean;
};

export default function ConfirmModal({
  open,
  fundersCount,
  merchantName,
  ccEmails,
  signerName,
  fromAddress,
  onSend,
  onCancel,
  sending = false,
}: Props) {
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Auto-focus the Send button when the modal opens so Enter fires it.
  useEffect(() => {
    if (open) {
      // Defer to next tick — focus before paint flickers in some browsers.
      const t = setTimeout(() => sendButtonRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  // Escape closes the dialog (UX 101).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sending) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, sending, onCancel]);

  if (!open) return null;

  const plural = fundersCount === 1 ? "" : "s";
  const ccLabel = ccEmails.length > 0 ? ccEmails.join(", ") : "(none)";

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
      role="presentation"
      onClick={(e) => {
        // Click on the backdrop (but not the dialog) cancels.
        if (e.target === e.currentTarget && !sending) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shop-out-confirm-title"
        className="w-full max-w-lg rounded-md border border-zinc-800 bg-zinc-950 p-6 text-zinc-100 shadow-2xl"
      >
        <h2
          id="shop-out-confirm-title"
          className="text-lg font-semibold text-zinc-50"
        >
          Confirm shop-out
        </h2>

        <p className="mt-3 text-sm text-zinc-200">
          You are about to send{" "}
          <span className="font-medium">{fundersCount}</span> submission{plural} for{" "}
          <span className="font-medium">{merchantName}</span>.
        </p>

        <dl className="mt-4 grid gap-2 text-sm text-zinc-300">
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-zinc-400">CC list:</dt>
            <dd className="font-mono text-xs leading-relaxed text-zinc-200">{ccLabel}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-zinc-400">Signing as:</dt>
            <dd className="text-zinc-200">{signerName}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-zinc-400">Sending from:</dt>
            <dd className="font-mono text-xs text-zinc-200">{fromAddress}</dd>
          </div>
        </dl>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 hover:bg-zinc-800 disabled:opacity-50"
            onClick={onCancel}
            disabled={sending}
          >
            Cancel
          </button>
          <button
            ref={sendButtonRef}
            type="button"
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-emerald-50 hover:bg-emerald-500 disabled:cursor-progress disabled:opacity-70"
            onClick={onSend}
            disabled={sending}
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
