"use client";

/**
 * TeammateToggle — the On/Off switch on an AI Team row (W4a, audit S2-06).
 *
 * The roster hands it only to owners and admins, and only for a teammate that
 * has a switch (never a core one); POST /api/tenant/agents/toggle refuses
 * anyone else on its own. Turning on an agent the workspace built but its
 * manifest does not bind yet ADDS the binding ("add"); otherwise it is
 * "enable" / "disable". Afterwards the page re-reads the roster
 * (router.refresh), so the department channels, Settings and the chat picker,
 * which all read the same manifest, agree with the row.
 *
 * A failed change says so under the switch and leaves the row as it was.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export function TeammateToggle({
  slug,
  name,
  enabled,
  bound,
}: {
  slug: string;
  /** For the accessible label: "Sales: on". */
  name: string;
  enabled: boolean;
  /** False: the manifest does not bind it yet, so On adds the binding. */
  bound: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = enabled ? "disable" : bound ? "enable" : "add";

  async function flip() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/tenant/agents/toggle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, slug }),
      });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!res.ok || !out.ok) {
        setError(out.message || `Not changed (HTTP ${res.status}). Try again.`);
        return;
      }
      router.refresh();
    } catch {
      setError("Not changed: could not reach OASIS. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={`${name}: ${enabled ? "on" : "off"}`}
        onClick={flip}
        disabled={busy}
        className="inline-flex h-6 items-center gap-1.5 rounded-md border border-hairline px-1.5 text-[11px] font-medium leading-4 text-fg-muted transition-colors duration-150 hover:bg-active-hover hover:text-fg disabled:opacity-60"
      >
        <span
          aria-hidden
          className={`relative inline-block h-3 w-5 rounded-full border border-hairline ${enabled ? "bg-status-engaged" : "bg-bg-raised"}`}
        >
          <span
            className={`absolute top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-fg transition-[left] duration-150 ${enabled ? "left-[9px]" : "left-[1px]"}`}
          />
        </span>
        {busy ? "Saving..." : enabled ? "On" : "Off"}
      </button>
      {error && (
        <p role="alert" className="max-w-[16rem] text-right text-[11px] leading-4 text-status-hot">
          {error}
        </p>
      )}
    </div>
  );
}
