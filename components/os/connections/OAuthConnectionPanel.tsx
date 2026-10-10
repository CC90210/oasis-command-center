"use client";

/**
 * OAuthConnectionPanel - Test again and Disconnect for an app connected at the
 * vendor's own sign-in page (QuickBooks, Xero, Zoom, WhatsApp), inside the
 * ConnectorDrawer. The Connect / Reconnect button is the drawer's footer, the
 * same button Constant Contact has; this panel only appears once there is a
 * connection to look after.
 *
 * It never decides a status. Test again posts to /api/connections/[provider]/test
 * (a live read with a fresh access token), Disconnect posts to .../disconnect
 * (the server tells the vendor to forget OASIS, then deletes OASIS's copy of the
 * tokens), and the hub re-reads every status afterwards (onChanged).
 */

import { useState } from "react";
import { Notice, type NoticeValue } from "@/components/os/connections/Notice";
import type { ConnectorStatus } from "@/lib/os/connectors";

type Busy = "test" | "disconnect" | null;

async function post(url: string): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }> {
  const res = await fetch(url, { method: "POST", cache: "no-store" });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: res.ok && data?.ok === true, status: res.status, data };
}

function serverMessage(r: { status: number; data: Record<string, unknown> | null }, fallback: string): string {
  const message = r.data?.message;
  if (typeof message === "string" && message.trim()) return message;
  // A bare code is for the logs; the owner reads what to do.
  console.error("[connections.oauth_panel]", r.status, r.data?.error);
  return `${fallback}. Try again in a minute.`;
}

export function OAuthConnectionPanel({
  providerId,
  providerName,
  status,
  onChanged,
}: {
  providerId: string;
  providerName: string;
  status: ConnectorStatus | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<NoticeValue>(null);
  const [confirming, setConfirming] = useState(false);

  const hasConnection = status?.kind === "connected" || status?.kind === "configured" || status?.kind === "attention";
  const base = `/api/connections/${encodeURIComponent(providerId)}`;

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<void>) => {
    setBusy(kind);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      console.error(`[connections.oauth_panel.${kind}]`, error);
      setNotice({ tone: "err", text: "Could not reach OASIS. Check your connection and try again." });
    } finally {
      setBusy(null);
    }
  };

  const test = () =>
    run("test", async () => {
      const r = await post(`${base}/test`);
      if (!r.ok) {
        setNotice({ tone: "err", text: serverMessage(r, "The check could not run") });
        return;
      }
      const conn = r.data?.connection as { verified?: boolean; last_health_detail?: string | null } | undefined;
      setNotice(
        conn?.verified
          ? { tone: "ok", text: `The live check with ${providerName} passed.` }
          : { tone: "err", text: conn?.last_health_detail || `The live check with ${providerName} did not pass.` },
      );
      onChanged();
    });

  const disconnect = () =>
    run("disconnect", async () => {
      const r = await post(`${base}/disconnect`);
      setConfirming(false);
      if (!r.ok) {
        setNotice({ tone: "err", text: serverMessage(r, `${providerName} could not be disconnected`) });
        return;
      }
      const sharedElsewhere = r.data?.vendor_revoke_skipped_reason === "shared_with_another_workspace";
      setNotice({
        tone: r.data?.vendor_revoked === false && !sharedElsewhere ? "err" : "ok",
        text: sharedElsewhere
          ? `${providerName} disconnected here and OASIS deleted its copy. ${providerName} was not told to forget OASIS, because another OASIS workspace is still using that same account.`
          : r.data?.vendor_revoked === false
            ? `${providerName} disconnected and OASIS deleted its copy of the sign-in, but ${providerName} could not be told to forget OASIS. Remove OASIS from ${providerName}'s connected apps too.`
            : `${providerName} disconnected. ${providerName} was told to forget OASIS and the stored sign-in was deleted.`,
      });
      onChanged();
    });

  if (!hasConnection) return notice ? <Notice notice={notice} /> : null;

  return (
    <div className="space-y-5">
      <Notice notice={notice} />
      <section>
        <h3 className="mb-2 text-xs font-medium text-fg-dim">Connected account</h3>
        <p className="text-[13px] leading-5 text-fg">{status?.account ?? "Account name not available"}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={test} disabled={busy !== null} className="btn-secondary">
            {busy === "test" ? "Checking…" : "Test again"}
          </button>
          {!confirming && (
            <button type="button" onClick={() => setConfirming(true)} disabled={busy !== null} className="btn-secondary">
              Disconnect
            </button>
          )}
        </div>
        {confirming && (
          <div className="mt-3 rounded-lg border border-hairline bg-bg-raised px-3 py-3">
            <p className="text-[13px] leading-5 text-fg">
              Disconnect {providerName}? OASIS tells {providerName} to forget its access, deletes the stored sign-in and
              stops reading this account. You can connect it again at any time.
            </p>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={disconnect} disabled={busy !== null} className="btn-danger">
                {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
              </button>
              <button type="button" onClick={() => setConfirming(false)} disabled={busy !== null} className="btn-secondary">
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
