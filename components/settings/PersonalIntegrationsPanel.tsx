"use client";

/**
 * PersonalIntegrationsPanel — Settings → Personal section that lets
 * each employee connect their OWN credentials for the services where
 * tenant-shared credentials would be wrong.
 *
 * Phase 4 of the SunBiz multi-employee personalization plan
 * (2026-05-29). Today this hosts Gmail OAuth — when Alex connects
 * his Gmail, emails sent from his seat go from his address, not the
 * tenant owner's shared submissions@. Future per-user services
 * (personal Slack, personal Calendar, etc.) would land here too.
 *
 * Data flow:
 *   - GET /api/integrations/personal/status → which services are
 *     connected for THIS user
 *   - For Gmail: button hits /api/auth/google-oauth/start which
 *     returns a Google consent URL; we redirect the browser there.
 *     Google bounces back to /api/auth/google-oauth/callback which
 *     stores the tokens and redirects to /settings#integrations with
 *     a status query param this component reads.
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, Mail, Check, AlertCircle, X } from "lucide-react";

type PersonalStatus = {
  service: string;
  connected: boolean;
  gmail_address?: string | null;
  expires_at?: string | null;
};

export function PersonalIntegrationsPanel({
  // When false (shared-inbox tenants like SunBiz), suppress the personal
  // Gmail row — outbound goes through the shared submissions@ identity so
  // a personal Gmail OAuth does nothing.
  showGmail = true,
  // When false (tenants whose enabled agents don't include Helios — e.g.
  // CC's personal OASIS which runs bravo/atlas/maven/aura only),
  // suppress the Kixie agent-email row entirely. Kixie is the click-to-
  // call dialer the SunBiz Helios agent uses; rendering its row on
  // tenants that don't have Helios just confuses operators with a
  // setting that does nothing. CC 2026-06-06: "we don't use Kixie for
  // OASIS AI or TextTorrent."
  showKixie = true,
}: {
  showGmail?: boolean;
  showKixie?: boolean;
} = {}) {
  const [statuses, setStatuses] = useState<PersonalStatus[] | null>(null);
  const [busyService, setBusyService] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Phase 5 of TT + Kixie embedding (2026-06-01): per-employee Kixie agent
  // email. Stored encrypted in user_integration_credentials so the call
  // button on the lead drawer rings THIS employee's Kixie line when they
  // trigger a call. Defaults to user_profiles.email server-side if absent.
  const [kixieAgentEmail, setKixieAgentEmail] = useState<string | null>(null);
  const [kixieDraft, setKixieDraft] = useState("");
  const [kixieFlash, setKixieFlash] = useState<string | null>(null);
  const searchParams = useSearchParams();

  // OAuth callback flash messages — surfaced as a banner on first
  // load after the redirect. Looking for ?gmail_oauth=connected|denied|error.
  const oauthFlash = searchParams.get("gmail_oauth");
  const oauthReason = searchParams.get("reason");
  const oauthEmail = searchParams.get("gmail");

  async function refresh() {
    try {
      const r = await fetch("/api/integrations/personal/status", { cache: "no-store" });
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        statuses?: PersonalStatus[];
      };
      if (body.ok && body.statuses) {
        setStatuses(body.statuses);
      } else {
        setStatuses([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setStatuses([]);
    }
    // Load the user's Kixie agent email override (if any) in parallel.
    try {
      const k = await fetch("/api/integrations/personal/kixie", { cache: "no-store" });
      const kbody = (await k.json().catch(() => ({}))) as {
        ok?: boolean;
        kixie_agent_email?: string | null;
      };
      if (kbody.ok) {
        setKixieAgentEmail(kbody.kixie_agent_email || null);
        setKixieDraft(kbody.kixie_agent_email || "");
      }
    } catch {
      // Soft-fail — the rest of the panel is independent.
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function saveKixieAgentEmail() {
    setBusyService("kixie");
    setError(null);
    setKixieFlash(null);
    try {
      const r = await fetch("/api/integrations/personal/kixie", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kixie_agent_email: kixieDraft.trim() }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        kixie_agent_email?: string;
        error?: string;
        message?: string;
      };
      if (!r.ok || !body.ok) {
        setError(body.message || body.error || `save_failed:${r.status}`);
        return;
      }
      setKixieAgentEmail(body.kixie_agent_email || null);
      setKixieFlash("Saved — your Kixie line will ring next time you call from the dashboard.");
    } finally {
      setBusyService(null);
    }
  }

  async function clearKixieAgentEmail() {
    if (!confirm("Clear your Kixie agent email override? Calls will ring whichever Kixie account matches your workspace email.")) return;
    setBusyService("kixie");
    setError(null);
    setKixieFlash(null);
    try {
      const r = await fetch("/api/integrations/personal/kixie", { method: "DELETE" });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { message?: string };
        setError(body.message || `clear_failed:${r.status}`);
        return;
      }
      setKixieAgentEmail(null);
      setKixieDraft("");
      setKixieFlash("Cleared.");
    } finally {
      setBusyService(null);
    }
  }

  async function connectGmail() {
    setBusyService("gmail_oauth");
    setError(null);
    try {
      const r = await fetch("/api/auth/google-oauth/start");
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        url?: string;
        error?: string;
        message?: string;
      };
      if (!body.ok || !body.url) {
        setError(body.message || body.error || `connect_failed:${r.status}`);
        setBusyService(null);
        return;
      }
      // Browser navigation to Google's consent screen. Google bounces
      // back to /api/auth/google-oauth/callback which redirects to
      // /settings#integrations?gmail_oauth=connected (or =error).
      window.location.href = body.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "connect_failed");
      setBusyService(null);
    }
  }

  async function disconnectGmail() {
    if (!confirm("Disconnect Gmail? Sends from your seat will fall back to the workspace default sender.")) return;
    setBusyService("gmail_oauth");
    try {
      const r = await fetch("/api/integrations/personal/disconnect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ service: "gmail_oauth" }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setError(body.error || `disconnect_failed:${r.status}`);
      } else {
        await refresh();
      }
    } finally {
      setBusyService(null);
    }
  }

  const gmailStatus = statuses?.find((s) => s.service === "gmail_oauth");
  const gmailConnected = gmailStatus?.connected === true;

  return (
    <div className="rounded-2xl border border-bg-border bg-bg-elev/40 p-5 space-y-4">
      <header>
        <h3 className="text-sm font-bold text-fg uppercase tracking-wider flex items-center gap-2">
          <Mail className="w-4 h-4 text-accent" />
          Personal integrations
        </h3>
        <p className="text-[12px] text-fg-muted leading-relaxed mt-1">
          Connect your OWN accounts. Sends from your seat will go from your address — teammates keep using their own. Workspace-shared keys{showKixie ? " (TextTorrent, Kixie, etc.)" : ""} stay above; this section is just for credentials that must be you personally.
        </p>
      </header>

      {oauthFlash === "connected" && (
        <div className="flex items-start gap-2 text-sm text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-md p-3">
          <Check className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Gmail connected{oauthEmail ? ` (${oauthEmail})` : ""}. Your future sends will come from your address.
          </span>
        </div>
      )}
      {oauthFlash === "denied" && (
        <div className="flex items-start gap-2 text-sm text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-md p-3">
          <X className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Gmail connection cancelled{oauthReason ? ` (${oauthReason})` : ""}. You can try again any time.
          </span>
        </div>
      )}
      {oauthFlash === "error" && (
        <div className="flex items-start gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-md p-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Gmail connection failed{oauthReason ? `: ${oauthReason}` : ""}. Reach out to support if it persists.
          </span>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 text-[12px] text-red-300 bg-red-500/10 border border-red-500/30 rounded-md p-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {statuses === null ? (
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading…
        </div>
      ) : (
        <ul className="space-y-3">
          {showGmail && (
          <li className="rounded-lg border border-bg-border bg-bg-deep/40 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm text-fg">Gmail</span>
                  {gmailConnected ? (
                    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                      <Check className="w-3 h-3" />
                      Connected
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-bg-elev/60 text-fg-dim border border-bg-border">
                      Not connected
                    </span>
                  )}
                </div>
                <div className="text-[11.5px] text-fg-muted mt-1 leading-relaxed">
                  {gmailConnected
                    ? `Connected as ${gmailStatus?.gmail_address || "(address unknown)"}. Scope: gmail.send only — we cannot read your inbox.`
                    : "Connect your personal Gmail so outbound sends come from your address. Scope: gmail.send only — we cannot read your inbox."}
                </div>
              </div>
              <div className="shrink-0">
                {gmailConnected ? (
                  <button
                    type="button"
                    onClick={disconnectGmail}
                    disabled={busyService === "gmail_oauth"}
                    className="inline-flex items-center gap-1.5 rounded-md border border-bg-border bg-bg-elev px-3 py-1.5 text-[12.5px] font-bold text-fg-muted hover:text-red-300 hover:border-red-500/40 disabled:opacity-50 transition-colors"
                  >
                    {busyService === "gmail_oauth" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={connectGmail}
                    disabled={busyService === "gmail_oauth"}
                    className="inline-flex items-center gap-1.5 rounded-md bg-accent text-bg-deep px-3 py-1.5 text-[12.5px] font-bold hover:bg-accent/90 disabled:opacity-60 transition-colors"
                  >
                    {busyService === "gmail_oauth" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    Connect my Gmail
                  </button>
                )}
              </div>
            </div>
          </li>
          )}

          {/* Per-employee Kixie agent email — Phase 5 of TT + Kixie
              embedding. Drawer click-to-call rings THIS Kixie agent
              when set; falls back to user_profiles.email otherwise.
              CC 2026-06-06: gated by showKixie so OASIS personal
              (no Helios → no Kixie usage) doesn't render this row. */}
          {showKixie && (
          <li className="rounded-lg border border-bg-border bg-bg-deep/40 p-4">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm text-fg">Kixie agent email</span>
                {kixieAgentEmail ? (
                  <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                    <Check className="w-3 h-3" />
                    Override set
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-bg-elev/60 text-fg-dim border border-bg-border">
                    Using your workspace email
                  </span>
                )}
              </div>
              <div className="text-[11.5px] text-fg-muted leading-relaxed">
                Only needed if your Kixie login email is different from your
                workspace email. When set, click-to-call from the lead
                drawer rings THIS Kixie account first (the alley-oop), then
                bridges to the prospect.
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="email"
                  value={kixieDraft}
                  onChange={(e) => setKixieDraft(e.target.value)}
                  placeholder="alex@your-kixie-login.com"
                  className="flex-1 min-w-[200px] rounded-md border border-bg-border bg-bg-elev px-3 py-1.5 text-[12.5px] text-fg placeholder:text-fg-dim focus:outline-none focus:border-accent"
                />
                <button
                  type="button"
                  onClick={saveKixieAgentEmail}
                  disabled={busyService === "kixie" || !kixieDraft.trim()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent text-bg-deep px-3 py-1.5 text-[12.5px] font-bold hover:bg-accent/90 disabled:opacity-60 transition-colors"
                >
                  {busyService === "kixie" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                  Save
                </button>
                {kixieAgentEmail && (
                  <button
                    type="button"
                    onClick={clearKixieAgentEmail}
                    disabled={busyService === "kixie"}
                    className="inline-flex items-center gap-1.5 rounded-md border border-bg-border bg-bg-elev px-3 py-1.5 text-[12.5px] font-bold text-fg-muted hover:text-red-300 hover:border-red-500/40 disabled:opacity-50 transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>
              {kixieFlash && (
                <div className="text-[11.5px] text-emerald-300">{kixieFlash}</div>
              )}
            </div>
          </li>
          )}
        </ul>
      )}
    </div>
  );
}
