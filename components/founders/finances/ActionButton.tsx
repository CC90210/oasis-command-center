"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postFinanceAction } from "./ActionForm";
import { dangerButton, primaryButton, quietButton } from "./ui";

/** A single-click Finances action (void, exclude, pin, reconcile...). */
export function ActionButton({
  action,
  payload,
  label,
  confirm,
  tone = "quiet",
}: {
  action: string;
  payload: Record<string, unknown>;
  label: string;
  confirm?: string;
  tone?: "quiet" | "primary" | "danger";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const cls = tone === "danger" ? dangerButton : tone === "primary" ? primaryButton : quietButton;
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        className={cls}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setBusy(true);
          setErr(null);
          setNote(null);
          const r = await postFinanceAction({ action, ...payload }).catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : "Network error." }));
          setBusy(false);
          if (!r.ok) {
            setErr(r.message || "Failed.");
            return;
          }
          const data = (r as { data?: Record<string, unknown> }).data;
          if (typeof data?.message === "string") setNote(data.message);
          if (typeof data?.redirect === "string") router.push(data.redirect);
          else router.refresh();
        }}
      >
        {busy ? "Working…" : label}
      </button>
      {err && <span className="text-xs text-status-hot">{err}</span>}
      {note && <span className="text-xs text-status-engaged">{note}</span>}
    </span>
  );
}
