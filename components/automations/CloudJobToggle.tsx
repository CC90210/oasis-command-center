"use client";

/**
 * CloudJobToggle - the one-click ON / PAUSED switch on each scheduled cloud
 * job (2026-10-31). Rendered as a working switch only when the server said
 * this viewer may switch (lib/automations/cloud-job-control.ts); everyone else
 * sees the same state as a read-only badge. The flip shows at once, is undone
 * if the save fails, and the page re-reads the saved state from the server.
 */
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

const MESSAGES: Record<string, string> = {
  not_found: "Only CC can switch cloud jobs.",
  unauthorized: "Sign in again, then try.",
};

export function CloudJobToggle({
  route,
  name,
  enabled,
  canToggle,
}: {
  route: string;
  name: string;
  /** true = ON, false = paused, null = the switch could not be read. */
  enabled: boolean | null;
  canToggle: boolean;
}) {
  const router = useRouter();
  const [on, setOn] = useState<boolean | null>(enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => setOn(enabled), [enabled]);

  if (on === null) {
    return <span className="text-[11px] text-fg-dim">On/off unknown</span>;
  }

  const label = on ? "ON" : "PAUSED";
  if (!canToggle) {
    return (
      <span
        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wider ${
          on ? "border-status-engaged/40 text-status-engaged" : "border-bg-border text-fg-dim"
        }`}
      >
        {label}
      </span>
    );
  }

  async function flip() {
    if (busy || on === null) return;
    const next = !on;
    setBusy(true);
    setError(null);
    setOn(next);
    try {
      const res = await fetch("/api/automations/cloud-jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route, enabled: next }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      if (!res.ok || body.ok !== true) {
        throw new Error(body.message || (body.error && MESSAGES[body.error]) || "Couldn't save. Nothing changed.");
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setOn(!next);
      setError(err instanceof Error ? err.message : "Couldn't save. Nothing changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`${name}: ${on ? "on" : "paused"}. ${on ? "Pause it" : "Turn it on"}.`}
        title={on ? "Click to pause this job" : "Click to turn this job back on"}
        disabled={busy}
        onClick={flip}
        className="inline-flex items-center gap-2 rounded-full px-1 py-0.5 disabled:opacity-60"
      >
        <span
          aria-hidden
          className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${
            on ? "bg-status-engaged" : "bg-fg-dim/40"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
              on ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </span>
        <span className={`w-14 text-left text-[10px] font-semibold tracking-wider ${on ? "text-status-engaged" : "text-fg-dim"}`}>
          {busy ? "SAVING" : label}
        </span>
      </button>
      {error && (
        <span role="alert" className="max-w-[12rem] text-right text-[10px] text-status-hot">
          {error}
        </span>
      )}
    </div>
  );
}
