"use client";

/**
 * SlackDisconnect - remove the Slack connection from this OASIS workspace, with
 * a confirmation step. The bot token is deleted first, then the connection and
 * its team route (lib/connections/service.ts disconnectConnection): after this,
 * events from that Slack workspace find no workspace and are dropped. The app
 * itself stays installed in Slack until someone removes it there.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SlackDisconnect({ teamName }: { teamName: string | null }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/connections/slack/disconnect", { method: "POST" });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || body?.ok !== true) {
        setError(String(body?.message ?? `Not disconnected (HTTP ${res.status}).`));
        return;
      }
      setConfirming(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className="btn-secondary">
        Disconnect
      </button>
    );
  }
  return (
    <div className="rounded-lg border border-hairline bg-bg-raised px-3 py-3">
      <p className="text-[13px] leading-5 text-fg">
        Disconnect {teamName ?? "this Slack workspace"}? OASIS deletes its Slack token and stops reading and answering there. Mapped
        channels and past messages stay until they age out. To remove the app from Slack itself, remove it in Slack too.
      </p>
      {error && <p className="mt-2 text-[12px] text-status-warm">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={() => void disconnect()} disabled={busy} className="btn-danger">
          {busy ? "Disconnecting…" : "Disconnect"}
        </button>
        <button type="button" onClick={() => setConfirming(false)} disabled={busy} className="btn-secondary">
          Cancel
        </button>
      </div>
    </div>
  );
}
