"use client";
import { useEffect, useRef, useState } from "react";

type Status = { configured: boolean; ready: boolean; reason: string; inbound_url: string; receivedAt: string | null };
const messages: Record<string, string> = {
  configuration_missing: "Save the webhook fields and an explicit From number above to connect STOP replies.",
  awaiting_signed_delivery: "Waiting for a signed incoming message from the configured Quo number.",
  needs_provider_check: "An incoming delivery was verified. Check Quo's current webhook settings before automated texts can send.",
  provider_configuration_mismatch: "The Quo webhook must be enabled, use this address, and receive messages only for the configured number.",
  provider_revision_changed: "Quo's webhook settings changed. Save the current signing key and verify a new signed incoming delivery.",
  provider_delivery_backlog: "Quo has incoming deliveries still waiting or retrying. Automated reminders wait until those deliveries are resolved.",
  provider_deliveries_failed: "Quo has failed incoming deliveries. Automated texts stay blocked until those deliveries are resolved.",
  ready: "STOP replies are connected. Automated texts still follow consent, delivery hours and live-send settings.",
};
export function QuoWebhooksPanel({ version }: { version?: number }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false); const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController(); setStatus(null); setError(false); setBusy(false);
    fetch("/api/integrations/quo/webhooks", { cache: "no-store", signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(); return response.json(); })
      .then(value => { if (generation.current === current && !controller.signal.aborted) setStatus(value); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [version]);
  async function check() {
    const current = generation.current;
    setBusy(true); setError(false); setStatus(current => current ? { ...current, ready: false } : null);
    try {
      const response = await fetch("/api/integrations/quo/webhooks", { method: "POST" });
      if (!response.ok) throw new Error(); const value = await response.json();
      if (generation.current === current) setStatus(value);
    } catch { if (generation.current === current) setError(true); }
    finally { if (generation.current === current) setBusy(false); }
  }
  return <section className="space-y-2 rounded-lg border border-bg-border p-3 text-sm">
    <p className="font-medium">Incoming STOP replies</p>
    <p className="text-fg-muted">{error ? "The connection could not be checked. Automated texts stay blocked until it can be verified." : status ? messages[status.reason] ?? "Connection status is unknown." : "Reading connection status…"}</p>
    {status && <p className="break-all text-xs text-fg-muted">Webhook address: {status.inbound_url}</p>}
    <p className="text-xs text-fg-muted">In Quo, use message.received, API version 2026-03-30, and only your configured phone number. Save its signing key above, then receive a signed message or use Quo&apos;s webhook test delivery. Repeat this after rotating the signing key. This check sends no text.</p>
    <button type="button" disabled={busy || !status?.configured} onClick={check} className="rounded border border-bg-border px-3 py-1.5 disabled:opacity-50">{busy ? "Checking…" : "Check STOP connection"}</button>
  </section>;
}
