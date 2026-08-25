"use client";

/**
 * KixieWebhookSyncCard — owner-only one-click "Register all Kixie webhooks"
 * button. Phase 4 of TT + Kixie full embedding (2026-06-01).
 *
 * Renders right below the IntegrationKeysPanel on the tenant Settings page
 * when Kixie is in the tenant's required_services. The button POSTs to
 * /api/integrations/kixie/sync-webhooks which iterates the 9 Kixie webhook
 * event types (KIXIE_WEBHOOK_EVENTS in lib/integrations/kixie.ts) and
 * registers our /api/webhooks/kixie URL for each.
 *
 * Replaces the manual "paste this URL 9 times into Kixie's dashboard"
 * onboarding step.
 */

import { useState } from "react";
import { Card } from "@/components/Card";
import { Loader2, CheckCircle2, AlertCircle, Webhook } from "lucide-react";

type SyncResult = {
  event: string;
  ok: boolean;
  error?: string;
};

type SyncResponse = {
  ok: boolean;
  webhook_url?: string;
  registered?: number;
  total?: number;
  results?: SyncResult[];
  error?: string;
  message?: string;
};

export function KixieWebhookSyncCard({ isOwner }: { isOwner: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SyncResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function syncNow() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetch("/api/integrations/kixie/sync-webhooks", {
        method: "POST",
      });
      const body = (await r.json().catch(() => ({}))) as SyncResponse;
      if (!r.ok || !body.ok) {
        setError(body.message || body.error || `sync_failed:${r.status}`);
      }
      setResult(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "sync_failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Kixie webhook registration"
      subtitle="Point all 9 Kixie webhook events at this dashboard in one click. Run this once after saving your Kixie API key, and again any time your dashboard URL changes."
    >
      {!isOwner ? (
        <div className="text-sm text-fg-muted">
          Only the workspace owner can register Kixie webhooks. Ask your workspace owner to run this from Settings.
        </div>
      ) : (
        <div className="space-y-3">
          <button
            type="button"
            onClick={syncNow}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-md bg-accent text-bg-deep px-3 py-2 text-[13px] font-bold hover:bg-accent/90 disabled:opacity-60 transition-colors"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Webhook className="w-4 h-4" />}
            Register all 9 Kixie webhooks
          </button>

          {error && (
            <div className="flex items-start gap-2 text-[12px] text-red-300 bg-red-500/10 border border-red-500/30 rounded-md p-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              {error}
            </div>
          )}

          {result?.ok && (
            <div className="space-y-2">
              <div className="text-[12px] text-emerald-300">
                Registered {result.registered} of {result.total} events at{" "}
                <code className="text-fg">{result.webhook_url}</code>
              </div>
              {result.results && result.results.length > 0 && (
                <ul className="space-y-1 text-[12px]">
                  {result.results.map((r) => (
                    <li key={r.event} className="flex items-start gap-2">
                      {r.ok ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                      ) : (
                        <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                      )}
                      <code className="text-fg">{r.event}</code>
                      {r.error && (
                        <span className="text-fg-muted text-[11px]">— {r.error}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
