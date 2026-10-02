"use client";

/**
 * TwilioWebhooksPanel - inside the Twilio drawer, under the keys: the two
 * addresses the workspace's own Twilio account calls OASIS on, each with a
 * copy button, and one explicit button that sets them on the saved number or
 * messaging service through Twilio's API (never automatically; it asks first).
 *
 * The URLs come from the server (/api/integrations/twilio/webhooks GET, OASIS's
 * public origin), never from this page's own address. Without the Auth Token
 * OASIS cannot verify an incoming text, so the panel says so and the server
 * refuses to point a number at OASIS until it is saved.
 */

import { useCallback, useEffect, useState } from "react";
import { Notice, type NoticeValue } from "@/components/os/connections/Notice";

type Info = {
  inbound_url: string;
  status_url: string;
  sender: { kind: "number" | "messaging_service"; label: string } | null;
  inbound_verifiable: boolean;
};

const ENDPOINT = "/api/integrations/twilio/webhooks";

/** One address with a copy button (also the Slack drawer's Request URLs). */
export function CopyRow({ label, value, hint }: { label: string; value: string; hint: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="space-y-1">
      <div className="text-[12px] font-medium text-fg-dim">{label}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-hairline bg-bg-raised px-2 py-1.5 font-mono text-[12px] text-fg" title={value}>
          {value}
        </code>
        <button type="button" onClick={copy} className="btn-secondary shrink-0" aria-label={`Copy the ${label.toLowerCase()} address`}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="text-[12px] leading-4 text-fg-dim">{hint}</p>
    </div>
  );
}

export function TwilioWebhooksPanel({ canManage, version }: { canManage: boolean; version?: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeValue>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(ENDPOINT, { credentials: "include", cache: "no-store" });
      const data = (await res.json().catch(() => null)) as (Info & { ok?: boolean; error?: string }) | null;
      if (res.ok && data?.ok) {
        setInfo(data);
        setLoadError(null);
      } else {
        setLoadError(data?.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "network_error");
    }
  }, []);

  // Re-read when the card's status changes (a sender saved, a test run).
  useEffect(() => {
    void load();
  }, [load, version]);

  const apply = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(ENDPOINT, { method: "POST", credentials: "include", cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; message?: string; error?: string } | null;
      setNotice(
        res.ok && data?.ok
          ? { tone: "ok", text: data.message || "Twilio now calls OASIS." }
          : { tone: "err", text: data?.message || `Twilio was not changed (${data?.error || `HTTP ${res.status}`}).` },
      );
    } catch (err) {
      console.error("[connections.twilio.webhooks]", err);
      setNotice({ tone: "err", text: "Could not reach OASIS. Twilio was not changed." });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <section className="space-y-3">
      <div>
        <h3 className="mb-1.5 text-xs font-medium text-fg-dim">Webhooks</h3>
        <p className="text-[13px] leading-5 text-fg-muted">
          Twilio calls OASIS at these two addresses: one for texts your customers send, one for what happened to each
          text OASIS sent. Paste them into Twilio yourself, or let OASIS set them for you.
        </p>
      </div>

      <Notice notice={notice} />

      {loadError ? (
        <p className="rounded-lg border border-status-warm/30 bg-status-warm/10 px-3 py-2 text-[13px] leading-5 text-fg">
          The webhook addresses could not be read ({loadError}). Refresh to try again.
        </p>
      ) : !info ? (
        <p className="text-[13px] text-fg-dim">Loading...</p>
      ) : (
        <>
          <CopyRow
            label="Incoming texts"
            value={info.inbound_url}
            hint="In Twilio: your number's Messaging configuration, 'A message comes in', Webhook, HTTP POST."
          />
          <CopyRow
            label="Delivery updates"
            value={info.status_url}
            hint="OASIS asks Twilio for these on every text it sends. A messaging service also takes it as its status callback."
          />
          {!info.inbound_verifiable && (
            <p className="rounded-lg border border-status-warm/30 bg-status-warm/10 px-3 py-2 text-[13px] leading-5 text-fg">
              Incoming texts need your Auth Token. Twilio signs every incoming text with it, and OASIS refuses any text it
              cannot verify. Sending works with an API key alone.
            </p>
          )}
          {canManage &&
            (info.sender ? (
              confirming ? (
                <div className="rounded-lg border border-hairline bg-bg-raised px-3 py-3">
                  <p className="text-[13px] leading-5 text-fg">
                    {info.sender.kind === "number"
                      ? `OASIS sets the incoming-message address of ${info.sender.label} in your Twilio account to the one above. Texts to that number then reach OASIS instead of wherever they go today.`
                      : `OASIS sets the incoming-message address and the status callback of messaging service ${info.sender.label} in your Twilio account to the ones above.`}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" onClick={apply} disabled={busy} className="btn-primary">
                      {busy ? "Setting them in Twilio..." : "Set them"}
                    </button>
                    <button type="button" onClick={() => setConfirming(false)} disabled={busy} className="btn-secondary">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={busy || !info.inbound_verifiable}
                  className="btn-secondary"
                >
                  Set these on {info.sender.label} in Twilio
                </button>
              )
            ) : (
              <p className="text-[13px] leading-5 text-fg-muted">
                Save a From Number or a Messaging Service SID above, and OASIS can set these on it for you.
              </p>
            ))}
        </>
      )}
    </section>
  );
}
