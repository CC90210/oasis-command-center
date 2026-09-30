"use client";

/**
 * SlackDisconnect - remove the Slack connection from this OASIS workspace, with
 * a confirmation step. The bot token is deleted first, then the connection, its
 * team route, the channel map and the Slack people OASIS looked up, in one batch
 * (lib/connections/service.ts disconnectConnection): after this, events from
 * that Slack workspace find no workspace and are dropped. Mirrored messages
 * age out on the retention clock. The app itself stays installed in Slack until
 * someone removes it there.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { disconnectSlack } from "@/components/settings/slack-disconnect-action";

export function SlackDisconnect({ teamName, retentionDays }: { teamName: string | null; retentionDays: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The request never throws: a failure, including one that never reached
  // OASIS, is the sentence under the button (slack-disconnect-action.ts).
  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      const done = await disconnectSlack();
      if (!done.ok) {
        setError(done.text);
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
        Disconnect {teamName ?? "this Slack workspace"}? OASIS deletes its Slack token, the channel map and the Slack names it looked
        up, and stops reading and answering there. Messages already mirrored stay on their Conversations tab until they age out
        ({retentionDays} days). To remove the app from Slack itself, remove it in Slack too.
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
