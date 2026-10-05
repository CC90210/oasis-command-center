"use client";

/**
 * Key-paste modal for integrations whose connection_kind is "api_key".
 * Opens on Connect-style click. Operator pastes the key, we POST it to
 * the local bridge's /env/set endpoint (CORS-allowed for the dashboard
 * origin, token-gated by the bridge_token at ~/.oasis/bridge_token).
 *
 * Why local bridge: the operator's CLI tools read a protected local secret
 * store. Routing through the bridge keeps the secret on the operator's
 * machine — the hosted dashboard never receives it.
 *
 * If the bridge is offline, saving fails closed until the paired-machine
 * supervisor is restored. We never instruct the operator to edit secret
 * files manually.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Check, KeyRound, Loader2, X, ExternalLink } from "lucide-react";
import { BRIDGE_CHAT_BASE } from "@/lib/agent-roots";

type Props = {
  open: boolean;
  onClose: () => void;
  service: string;          // integrations_health.service value
  serviceLabel: string;     // human label
  envKey: string;           // env var name (e.g. STRIPE_API_KEY)
  apiKeyUrl?: string;       // where to grab the key
  bridgeToken?: string | null;
};

export function KeyPasteModal({ open, onClose, service, serviceLabel, envKey, apiKeyUrl, bridgeToken }: Props) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [bridgeOnline, setBridgeOnline] = useState<boolean | null>(null);

  useEffect(() => {
    if (!open) return;
    setValue("");
    setError(null);
    setSuccess(false);
    setBridgeOnline(null);
    // Probe bridge so we can show the right CTA + a useful fallback hint
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    fetch(`${BRIDGE_CHAT_BASE}/health`, { signal: ctl.signal })
      .then((r) => setBridgeOnline(r.ok))
      .catch(() => setBridgeOnline(false))
      .finally(() => clearTimeout(t));
  }, [open]);

  if (!open) return null;

  async function save() {
    if (busy || !value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Bridge gates /env/set on CORS origin (only the dashboard's URL is
      // allowed). bridgeToken is reserved for headless / non-browser callers.
      const res = await fetch(`${BRIDGE_CHAT_BASE}/env/set`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(bridgeToken ? { authorization: `Bearer ${bridgeToken}` } : {}),
        },
        body: JSON.stringify({
          key: envKey,
          value: value.trim(),
          ping_service: service,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setError(String(data.error || `http_${res.status}`));
        return;
      }
      setSuccess(true);
      setTimeout(() => {
        router.refresh();
        onClose();
      }, 800);
    } catch (e) {
      setError(e instanceof Error ? e.message : "request_failed");
    } finally {
      setBusy(false);
    }
  }

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-deep/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-bg-border bg-bg-panel shadow-[0_20px_60px_-12px_rgba(0,212,255,0.3)] p-6 relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 text-fg-dim hover:text-fg transition-colors"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-2.5 mb-1">
          <div className="w-8 h-8 rounded-lg bg-accent/15 border border-accent/30 flex items-center justify-center text-accent">
            <KeyRound className="w-4 h-4" />
          </div>
          <h2 className="text-base font-bold text-fg">Connect {serviceLabel}</h2>
        </div>
        <p className="text-xs text-fg-muted leading-relaxed mb-4">
          Paste your API key here. The bridge saves it to the protected local secret store on your paired machine, so it never touches our servers. The integration flips green within ~5 seconds of save.
        </p>

        <label className="block">
          <span className="text-[10px] uppercase tracking-wider font-bold text-fg-muted">
            {envKey}
          </span>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            disabled={busy || success}
            placeholder="paste key here…"
            autoFocus
            className="mt-1 w-full bg-bg-elev border border-bg-border rounded-lg px-3 py-2 text-sm font-mono text-fg placeholder-fg-dim focus:outline-none focus:border-accent disabled:opacity-50"
          />
        </label>

        {apiKeyUrl && (
          <a
            href={apiKeyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-accent hover:text-accent-bright inline-flex items-center gap-1 mt-2"
          >
            don&apos;t have one yet → grab a key <ExternalLink className="w-3 h-3" />
          </a>
        )}

        {bridgeOnline === false && (
          <div className="mt-4 rounded-lg border border-status-warm/40 bg-status-warm/5 p-3 text-xs text-status-warm">
            <div className="font-bold mb-1">Bridge offline.</div>
            <div className="text-fg-muted leading-relaxed">
              Open Settings → Devices, or run <code className="text-accent">oasis bridge status</code> followed by <code className="text-accent">oasis bridge restart</code> on the paired machine. Return here when the bridge reports online; secret entry stays disabled until then.
            </div>
            <a
              href="/settings/devices"
              className="mt-2 inline-flex text-xs font-semibold text-accent hover:text-accent-bright"
            >
              Open Devices
            </a>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-lg border border-status-hot/40 bg-status-hot/10 p-2 text-xs text-status-hot font-mono break-all">
            {error}
          </div>
        )}
        {success && (
          <div className="mt-3 rounded-lg border border-status-engaged/40 bg-status-engaged/10 p-2 text-xs text-status-engaged inline-flex items-center gap-1.5">
            <Check className="w-3.5 h-3.5" /> Saved. {serviceLabel} flips live in a moment.
          </div>
        )}

        <div className="flex items-center justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="btn-secondary text-xs"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy || !value.trim() || success || bridgeOnline === false}
            className="btn-send text-sm"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            {busy ? "" : "Save key"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
