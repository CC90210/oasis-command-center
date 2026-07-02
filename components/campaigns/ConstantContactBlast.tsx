"use client";

/**
 * ConstantContactBlast — the Constant Contact email-blast surface. Rendered both
 * on the /email-blast page and as the 4th Campaigns channel tab.
 *
 * Phase 1 (this): connection-aware shell — Connect (admin) / Connected status,
 * driven by /api/integrations/constant-contact/{status,authorize}. The composer
 * (template picker → recipients → test-send → launch) lands in Phase 2.
 */

import { useCallback, useEffect, useState } from "react";
import { Mail, Loader2, CheckCircle2, AlertCircle, Plug } from "lucide-react";

type Status = { ok: boolean; connected?: boolean; configured?: boolean; can_connect?: boolean };

export function ConstantContactBlast() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/integrations/constant-contact/status", { cache: "no-store" });
      setStatus(await r.json());
    } catch {
      setStatus({ ok: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Surface the OAuth redirect result (?constant_contact=connected|denied|error).
    const p = new URLSearchParams(window.location.search);
    const cc = p.get("constant_contact");
    if (cc === "connected") setBanner({ kind: "ok", text: "Constant Contact connected." });
    else if (cc === "denied") setBanner({ kind: "err", text: "Connection cancelled." });
    else if (cc === "error") setBanner({ kind: "err", text: `Connection error: ${p.get("reason") || "unknown"}` });
  }, [load]);

  // Connect runs in a POPUP so this window (and its Supabase session) never
  // navigates. The popup does the OAuth dance and postMessages the result back.
  function connect() {
    setConnecting(true);
    setBanner(null);
    const url = "/api/integrations/constant-contact/authorize";
    const popup = window.open(url, "cc_oauth", "popup,width=620,height=780");
    if (!popup) {
      // Popup blocked — fall back to a full-window redirect (still safe: this flow
      // sets no cookies and reads no session).
      window.location.href = url;
      return;
    }
    let poll: ReturnType<typeof setInterval>;
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data as { source?: string; status?: string; reason?: string } | null;
      if (!d || d.source !== "cc_oauth") return;
      window.removeEventListener("message", onMsg);
      clearInterval(poll);
      setConnecting(false);
      if (d.status === "connected") {
        setBanner({ kind: "ok", text: "Constant Contact connected." });
        load();
      } else if (d.status === "denied") {
        setBanner({ kind: "err", text: "Connection cancelled." });
      } else {
        setBanner({ kind: "err", text: `Connection error: ${d.reason || "unknown"}` });
      }
      try { popup.close(); } catch { /* already closed */ }
    };
    window.addEventListener("message", onMsg);
    // If the operator closes the popup manually, stop the spinner + re-check status.
    poll = setInterval(() => {
      if (popup.closed) {
        clearInterval(poll);
        window.removeEventListener("message", onMsg);
        setConnecting(false);
        load();
      }
    }, 800);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Mail className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">Email Blast — Constant Contact</h2>
      </div>

      {banner && (
        <div className={`rounded-md border px-3 py-2 text-[12px] ${banner.kind === "ok" ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300" : "border-red-500/40 bg-red-500/10 text-red-300"}`}>
          {banner.text}
        </div>
      )}

      {loading ? (
        <div className="text-xs text-fg-dim italic py-6">Loading…</div>
      ) : !status?.configured ? (
        <div className="rounded-md border border-status-warm/40 bg-status-warm/5 px-3 py-3 text-[12px] text-status-warm">
          Constant Contact isn&apos;t configured on the server yet (missing app credentials). Once the API key + app
          secret are set, an admin can connect it here.
        </div>
      ) : status?.connected ? (
        <div className="space-y-3">
          <div className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-1.5 text-[12px] text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" /> Connected to Constant Contact
          </div>
          <div className="rounded-md border border-bg-border bg-bg-deep/30 px-3 py-3 text-[12px] text-fg-dim">
            The blast composer (template picker, recipient list, test-send, and launch) is coming in the next phase.
            The account is connected and ready.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="text-[12px] text-fg-dim">
            Connect the SunBiz Constant Contact account once to enable email blasts. You&apos;ll approve access on
            Constant Contact and come right back.
          </div>
          <button
            type="button"
            onClick={connect}
            disabled={connecting || !status?.can_connect}
            title={status?.can_connect ? "Connect Constant Contact" : "Only an admin can connect this integration"}
            className="inline-flex items-center gap-2 rounded-md bg-accent/10 border border-accent/30 text-accent px-3 py-1.5 text-[12px] font-semibold hover:bg-accent/20 disabled:opacity-50"
          >
            {connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />}
            {connecting ? "Starting…" : "Connect Constant Contact"}
          </button>
          {!status?.can_connect && (
            <div className="inline-flex items-center gap-1 text-[11px] text-fg-dim">
              <AlertCircle className="h-3 w-3" /> Ask an admin/owner to connect it.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
