"use client";

/**
 * Dismiss a note from Admin > Agent ops (2026-10-28): marks it read here (read_via dashboard), which
 * also takes an undelivered directive out of the relay, so it never reaches a computer.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function DismissNote({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function dismiss() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/inbox/mark-read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!res.ok || !body?.ok) {
        setError("Couldn't dismiss it. Try again.");
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={dismiss}
        disabled={busy || pending}
        className="rounded-md border border-bg-border px-2 py-0.5 text-[11px] text-fg-muted hover:border-fg-dim hover:text-fg disabled:opacity-50"
      >
        {busy || pending ? "Dismissing…" : "Dismiss"}
      </button>
      {error && <span className="text-[11px] text-status-warm">{error}</span>}
    </span>
  );
}
