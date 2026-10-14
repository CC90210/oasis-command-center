"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { postFinanceAction } from "./ActionForm";
import { dangerButton, primaryButton, quietButton } from "./ui";

/** A single-click Finances action (void, exclude, pin, reconcile...). */
export function ActionButton({
  action,
  payload,
  label,
  ariaLabel,
  confirm,
  tone = "quiet",
  disabled = false,
  onPendingChange,
}: {
  action: string;
  payload: Record<string, unknown>;
  label: string;
  ariaLabel?: string;
  confirm?: string;
  tone?: "quiet" | "primary" | "danger";
  disabled?: boolean;
  onPendingChange?: (pending: boolean) => void;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [transitionPending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const inFlight = useRef(false);
  const pendingCallback = useRef(onPendingChange);
  const reportedPending = useRef(false);
  const pending = submitting || transitionPending;
  const locked = disabled || pending;
  const cls = tone === "danger" ? dangerButton : tone === "primary" ? primaryButton : quietButton;

  const reportPending = useCallback((next: boolean) => {
    if (reportedPending.current === next) return;
    reportedPending.current = next;
    pendingCallback.current?.(next);
  }, []);

  useEffect(() => {
    pendingCallback.current = onPendingChange;
  }, [onPendingChange]);

  useEffect(() => {
    reportPending(pending);
    return () => {
      if (pending) reportPending(false);
    };
  }, [pending, reportPending]);

  return (
    <span className="inline-flex items-center gap-2" aria-busy={pending}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-disabled={locked}
        disabled={locked}
        className={cls}
        onClick={async () => {
          if (locked || inFlight.current) return;
          if (confirm && !window.confirm(confirm)) return;
          inFlight.current = true;
          reportPending(true);
          setSubmitting(true);
          setErr(null);
          setNote(null);
          try {
            const r = await postFinanceAction({ action, ...payload });
            if (!r.ok) {
              setErr(r.message || "Failed.");
              return;
            }
            const data = r.data ?? {};
            if (typeof data.message === "string") setNote(data.message);
            startTransition(() => {
              if (typeof data.redirect === "string") router.push(data.redirect);
              else router.refresh();
            });
          } catch (error) {
            setErr(error instanceof Error ? error.message : "Network error.");
          } finally {
            inFlight.current = false;
            setSubmitting(false);
          }
        }}
      >
        {pending ? "Working…" : label}
      </button>
      {(err || note) && (
        <span role="status" aria-live="polite" className={`text-xs ${err ? "text-status-hot" : "text-status-engaged"}`}>
          {err || note}
        </span>
      )}
    </span>
  );
}
