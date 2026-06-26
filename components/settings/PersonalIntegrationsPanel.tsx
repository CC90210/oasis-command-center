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
  // Per-rep "text from my own number" (2026-06-18): each employee can set
  // their own Kixie DID so drawer SMS sends from THEIR number; falls back to
  // the tenant default Kixie number server-side when unset.
  const [kixieFromNumber, setKixieFromNumber] = useState<string | null>(null);
  const [kixieFromDraft, setKixieFromDraft] = useState("");
  // Per-rep "text from my own TextTorrent number" (2026-06-24): each rep sets
  // their own TT sending DID so manual sends go from THEIR number; falls back
  // to the tenant default ("Default Business Number") server-side when unset.
  const [ttFromNumber, setTtFromNumber] = useState<string | null>(null);
  const [ttFromDraft, setTtFromDraft] = useState("");
  // Per-rep "send under my own Text Torrent account" (2026-06-25): the rep's TT
  // sub-account email (X-ACT-AS-USER). When set, blasts + sends go out on THEIR
  // account (their daily limit, their inbox), not the tenant owner's. Required
  // for a rep to run their own blasts.
  const [ttActAsEmail, setTtActAsEmail] = useState<string | null>(null);
  const [ttActAsDraft, setTtActAsDraft] = useState("");
  const [ttFlash, setTtFlash] = useState<string | null>(null);
  const [ttSyncing, setTtSyncing] = useState(false);
  // Per-rep AI nurture mode (2026-06-26): off / semi (50-50, escalates to you) /
  // full (hands-off). The AI works your inbound blast replies in your voice.
  const [nurtureMode, setNurtureMode] = useState<"off" | "semi" | "full">("off");
  const [nurtureNotify, setNurtureNotify] = useState<"telegram" | "email">("telegram");
  const [nurtureFlash, setNurtureFlash] = useState<string | null>(null);
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
        kixie_from_number?: string | null;
      };
      if (kbody.ok) {
        setKixieAgentEmail(kbody.kixie_agent_email || null);
        setKixieDraft(kbody.kixie_agent_email || "");
        setKixieFromNumber(kbody.kixie_from_number || null);
        setKixieFromDraft(kbody.kixie_from_number || "");
      }
    } catch {
      // Soft-fail — the rest of the panel is independent.
    }
    // Load the user's TextTorrent from-number override (if any) in parallel.
    try {
      const t = await fetch("/api/integrations/personal/texttorrent", { cache: "no-store" });
      const tbody = (await t.json().catch(() => ({}))) as {
        ok?: boolean;
        texttorrent_from_number?: string | null;
        texttorrent_act_as_email?: string | null;
      };
      if (tbody.ok) {
        setTtFromNumber(tbody.texttorrent_from_number || null);
        setTtFromDraft(tbody.texttorrent_from_number || "");
        setTtActAsEmail(tbody.texttorrent_act_as_email || null);
        setTtActAsDraft(tbody.texttorrent_act_as_email || "");
      }
    } catch {
      // Soft-fail — independent of the rest of the panel.
    }
    // Load the user's AI nurture mode (if any) in parallel.
    try {
      const n = await fetch("/api/integrations/personal/nurture", { cache: "no-store" });
      const nbody = (await n.json().catch(() => ({}))) as {
        ok?: boolean; mode?: "off" | "semi" | "full"; notify_channel?: "telegram" | "email";
      };
      if (nbody.ok) {
        setNurtureMode(nbody.mode || "off");
        setNurtureNotify(nbody.notify_channel || "telegram");
      }
    } catch {
      // Soft-fail.
    }
  }

  async function saveNurture(mode: "off" | "semi" | "full", notify: "telegram" | "email") {
    setBusyService("nurture");
    setError(null);
    setNurtureFlash(null);
    const prevMode = nurtureMode;
    setNurtureMode(mode);
    try {
      const r = await fetch("/api/integrations/personal/nurture", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, notify_channel: notify }),
      });
      const body = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      if (!r.ok || !body.ok) {
        setNurtureMode(prevMode); // revert optimistic change
        setError(body.message || body.error || `save_failed:${r.status}`);
        return;
      }
      setNurtureFlash(
        mode === "off"
          ? "AI nurture turned off."
          : mode === "semi"
            ? "AI nurture on — 50/50: it answers the clear stuff and escalates the rest to you."
            : "AI nurture on — full auto.",
      );
    } finally {
      setBusyService(null);
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
      const r = await fetch("/api/integrations/personal/kixie?field=kixie_agent_email", { method: "DELETE" });
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

  async function saveKixieFromNumber() {
    setBusyService("kixie");
    setError(null);
    setKixieFlash(null);
    try {
      const r = await fetch("/api/integrations/personal/kixie", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kixie_from_number: kixieFromDraft.trim() }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        kixie_from_number?: string;
        error?: string;
        message?: string;
      };
      if (!r.ok || !body.ok) {
        setError(body.message || body.error || `save_failed:${r.status}`);
        return;
      }
      setKixieFromNumber(body.kixie_from_number || null);
      if (body.kixie_from_number) setKixieFromDraft(body.kixie_from_number);
      setKixieFlash("Saved — your texts will send from your own Kixie number.");
    } finally {
      setBusyService(null);
    }
  }

  async function clearKixieFromNumber() {
    if (!confirm("Clear your Kixie from-number? Your texts will send from the workspace default Kixie number.")) return;
    setBusyService("kixie");
    setError(null);
    setKixieFlash(null);
    try {
      const r = await fetch("/api/integrations/personal/kixie?field=kixie_from_number", { method: "DELETE" });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { message?: string };
        setError(body.message || `clear_failed:${r.status}`);
        return;
      }
      setKixieFromNumber(null);
      setKixieFromDraft("");
      setKixieFlash("Cleared.");
    } finally {
      setBusyService(null);
    }
  }

  async function saveTtFromNumber() {
    setBusyService("texttorrent");
    setError(null);
    setTtFlash(null);
    try {
      const r = await fetch("/api/integrations/personal/texttorrent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ texttorrent_from_number: ttFromDraft.trim() }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        texttorrent_from_number?: string;
        error?: string;
        message?: string;
      };
      if (!r.ok || !body.ok) {
        setError(body.message || body.error || `save_failed:${r.status}`);
        return;
      }
      setTtFromNumber(body.texttorrent_from_number || null);
      if (body.texttorrent_from_number) setTtFromDraft(body.texttorrent_from_number);
      setTtFlash("Saved — your texts will send from your own Text Torrent number.");
    } finally {
      setBusyService(null);
    }
  }

  async function clearTtFromNumber() {
    if (!confirm("Clear your Text Torrent from-number? Your texts will send from the workspace default number.")) return;
    setBusyService("texttorrent");
    setError(null);
    setTtFlash(null);
    try {
      const r = await fetch("/api/integrations/personal/texttorrent?field=texttorrent_from_number", { method: "DELETE" });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { message?: string };
        setError(body.message || `clear_failed:${r.status}`);
        return;
      }
      setTtFromNumber(null);
      setTtFromDraft("");
      setTtFlash("Cleared.");
    } finally {
      setBusyService(null);
    }
  }

  async function saveTtActAsEmail() {
    setBusyService("texttorrent");
    setError(null);
    setTtFlash(null);
    try {
      const r = await fetch("/api/integrations/personal/texttorrent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ texttorrent_act_as_email: ttActAsDraft.trim() }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        texttorrent_act_as_email?: string;
        error?: string;
        message?: string;
      };
      if (!r.ok || !body.ok) {
        setError(body.message || body.error || `save_failed:${r.status}`);
        return;
      }
      setTtActAsEmail(body.texttorrent_act_as_email || null);
      if (body.texttorrent_act_as_email) setTtActAsDraft(body.texttorrent_act_as_email);
      setTtFlash("Saved — your blasts will send on your own Text Torrent account.");
    } finally {
      setBusyService(null);
    }
  }

  async function clearTtActAsEmail() {
    if (!confirm("Clear your Text Torrent account email? Your sends will go out on the workspace owner's account instead of your own.")) return;
    setBusyService("texttorrent");
    setError(null);
    setTtFlash(null);
    try {
      const r = await fetch("/api/integrations/personal/texttorrent?field=texttorrent_act_as_email", { method: "DELETE" });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { message?: string };
        setError(body.message || `clear_failed:${r.status}`);
        return;
      }
      setTtActAsEmail(null);
      setTtActAsDraft("");
      setTtFlash("Cleared.");
    } finally {
      setBusyService(null);
    }
  }

  async function syncTtHistory() {
    setTtSyncing(true);
    setError(null);
    setTtFlash(null);
    try {
      const r = await fetch("/api/integrations/texttorrent/sync", { method: "POST" });
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        inserted?: number;
        chats?: number;
        error?: string;
        message?: string;
      };
      if (!r.ok || !body.ok) {
        setError(body.message || body.error || `sync_failed:${r.status}`);
        return;
      }
      const n = body.inserted ?? 0;
      setTtFlash(
        n > 0
          ? `Synced — imported ${n} message${n === 1 ? "" : "s"} from ${body.chats ?? 0} thread${body.chats === 1 ? "" : "s"} into your inbox.`
          : "Synced — your inbox is already up to date.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "sync_failed");
    } finally {
      setTtSyncing(false);
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
            </div>
          </li>
          )}

          {/* Per-rep Kixie from-number — "text from my own number"
              (2026-06-18). Drawer SMS sends from THIS DID when set; falls
              back to the tenant default Kixie number otherwise. Gated by
              showKixie like the agent-email row above. */}
          {showKixie && (
          <li className="rounded-lg border border-bg-border bg-bg-deep/40 p-4">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm text-fg">Kixie from-number</span>
                {kixieFromNumber ? (
                  <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                    <Check className="w-3 h-3" />
                    {kixieFromNumber}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-bg-elev/60 text-fg-dim border border-bg-border">
                    Using the workspace number
                  </span>
                )}
              </div>
              <div className="text-[11.5px] text-fg-muted leading-relaxed">
                Your own Kixie phone number (DID). When set, texts you send from
                the lead drawer go out from THIS number; otherwise they use the
                workspace default Kixie number. E.164 format, e.g. +17542127833.
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="tel"
                  value={kixieFromDraft}
                  onChange={(e) => setKixieFromDraft(e.target.value)}
                  placeholder="+17542127833"
                  className="flex-1 min-w-[200px] rounded-md border border-bg-border bg-bg-elev px-3 py-1.5 text-[12.5px] text-fg placeholder:text-fg-dim focus:outline-none focus:border-accent"
                />
                <button
                  type="button"
                  onClick={saveKixieFromNumber}
                  disabled={busyService === "kixie" || !kixieFromDraft.trim()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent text-bg-deep px-3 py-1.5 text-[12.5px] font-bold hover:bg-accent/90 disabled:opacity-60 transition-colors"
                >
                  {busyService === "kixie" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                  Save
                </button>
                {kixieFromNumber && (
                  <button
                    type="button"
                    onClick={clearKixieFromNumber}
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

          {/* Per-rep Text Torrent from-number — "text from my own number"
              (2026-06-24). The team shares ONE Text Torrent API key (set in
              Business app keys above); each rep sets their OWN sending number
              here. When set, texts you send from the lead/application drawer or
              inbox go out from THIS number; otherwise they use the workspace
              default. Gated by showKixie like the Kixie rows (both are the
              SunBiz/Helios SMS stack). */}
          {showKixie && (
          <li className="rounded-lg border border-bg-border bg-bg-deep/40 p-4">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm text-fg">Text Torrent from-number</span>
                {ttFromNumber ? (
                  <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                    <Check className="w-3 h-3" />
                    {ttFromNumber}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-bg-elev/60 text-fg-dim border border-bg-border">
                    Using the workspace number
                  </span>
                )}
              </div>
              <div className="text-[11.5px] text-fg-muted leading-relaxed">
                Your own Text Torrent sending number. The API key is shared
                across the team — only your number is personal. When set, texts
                you send from the lead drawer, Applications, or the inbox go out
                from THIS number; otherwise they use the workspace default.
                E.164 format, e.g. +17542127833.
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="tel"
                  value={ttFromDraft}
                  onChange={(e) => setTtFromDraft(e.target.value)}
                  placeholder="+17542127833"
                  className="flex-1 min-w-[200px] rounded-md border border-bg-border bg-bg-elev px-3 py-1.5 text-[12.5px] text-fg placeholder:text-fg-dim focus:outline-none focus:border-accent"
                />
                <button
                  type="button"
                  onClick={saveTtFromNumber}
                  disabled={busyService === "texttorrent" || !ttFromDraft.trim()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent text-bg-deep px-3 py-1.5 text-[12.5px] font-bold hover:bg-accent/90 disabled:opacity-60 transition-colors"
                >
                  {busyService === "texttorrent" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                  Save
                </button>
                {ttFromNumber && (
                  <button
                    type="button"
                    onClick={clearTtFromNumber}
                    disabled={busyService === "texttorrent"}
                    className="inline-flex items-center gap-1.5 rounded-md border border-bg-border bg-bg-elev px-3 py-1.5 text-[12.5px] font-bold text-fg-muted hover:text-red-300 hover:border-red-500/40 disabled:opacity-50 transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>
              {/* Per-rep act-as account email — the other half of "send as me".
                  The from-number is which DID; this is which TT ACCOUNT. Both
                  must be set for a rep to run their own blasts on their own
                  daily limit + inbox. */}
              <div className="mt-1 border-t border-bg-border/60 pt-3 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm text-fg">My Text Torrent account email</span>
                  {ttActAsEmail ? (
                    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                      <Check className="w-3 h-3" />
                      {ttActAsEmail}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30">
                      Required to run your own blasts
                    </span>
                  )}
                </div>
                <div className="text-[11.5px] text-fg-muted leading-relaxed">
                  Your Text Torrent sub-account login email. When set, blasts and
                  sends go out UNDER YOUR account — your own daily send limit and
                  your own inbox — instead of the workspace owner&apos;s. e.g.
                  alex@sunbizfunding.com.
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    type="email"
                    value={ttActAsDraft}
                    onChange={(e) => setTtActAsDraft(e.target.value)}
                    placeholder="alex@sunbizfunding.com"
                    className="flex-1 min-w-[200px] rounded-md border border-bg-border bg-bg-elev px-3 py-1.5 text-[12.5px] text-fg placeholder:text-fg-dim focus:outline-none focus:border-accent"
                  />
                  <button
                    type="button"
                    onClick={saveTtActAsEmail}
                    disabled={busyService === "texttorrent" || !ttActAsDraft.trim()}
                    className="inline-flex items-center gap-1.5 rounded-md bg-accent text-bg-deep px-3 py-1.5 text-[12.5px] font-bold hover:bg-accent/90 disabled:opacity-60 transition-colors"
                  >
                    {busyService === "texttorrent" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    Save
                  </button>
                  {ttActAsEmail && (
                    <button
                      type="button"
                      onClick={clearTtActAsEmail}
                      disabled={busyService === "texttorrent"}
                      className="inline-flex items-center gap-1.5 rounded-md border border-bg-border bg-bg-elev px-3 py-1.5 text-[12.5px] font-bold text-fg-muted hover:text-red-300 hover:border-red-500/40 disabled:opacity-50 transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
              {/* Pull existing TT threads into the Conversations inbox. The
                  inbound webhook only captures NEW texts; this backfills history. */}
              <div className="flex items-center gap-2 flex-wrap pt-1">
                <button
                  type="button"
                  onClick={syncTtHistory}
                  disabled={ttSyncing}
                  className="inline-flex items-center gap-1.5 rounded-md border border-bg-border bg-bg-elev px-3 py-1.5 text-[12.5px] font-bold text-fg-muted hover:text-accent hover:border-accent/40 disabled:opacity-50 transition-colors"
                >
                  {ttSyncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                  {ttSyncing ? "Syncing…" : "Sync my Text Torrent history"}
                </button>
                <span className="text-[10.5px] text-fg-dim">
                  Pulls your recent threads into the Conversations inbox.
                </span>
              </div>
              {ttFlash && (
                <div className="text-[11.5px] text-emerald-300">{ttFlash}</div>
              )}
            </div>
          </li>
          )}

          {/* AI nurture mode — works your inbound blast replies in your voice */}
          <li className="rounded-lg border border-bg-border bg-bg-deep/40 p-4">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm text-fg">AI nurture (your inbound replies)</span>
                <span
                  className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold border ${
                    nurtureMode === "off"
                      ? "bg-bg-elev/60 text-fg-dim border-bg-border"
                      : "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                  }`}
                >
                  {nurtureMode === "off" ? "Off" : nurtureMode === "semi" ? "50/50" : "Full auto"}
                </span>
              </div>
              <div className="text-[11.5px] text-fg-muted leading-relaxed">
                When a merchant replies to your blast, the AI works the conversation in your voice from your number.
                <b> 50/50</b> answers the clear stuff and escalates objections, call requests, and hot leads to you.
                <b> Full</b> is hands-off. Requires your Text Torrent number + account email above.
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {(["off", "semi", "full"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => saveNurture(m, nurtureNotify)}
                    disabled={busyService === "nurture"}
                    className={`px-3 py-1.5 rounded-md text-[12.5px] font-semibold border transition-colors disabled:opacity-60 ${
                      nurtureMode === m
                        ? "bg-accent/10 border-accent/40 text-accent"
                        : "bg-bg-elev border-bg-border text-fg-muted hover:text-fg"
                    }`}
                  >
                    {m === "off" ? "Off" : m === "semi" ? "50/50 (cautious)" : "Full auto"}
                  </button>
                ))}
              </div>
              {nurtureMode !== "off" && (
                <div className="flex items-center gap-2 flex-wrap text-[11.5px] text-fg-muted">
                  Notify me via
                  <select
                    value={nurtureNotify}
                    onChange={(e) => {
                      const v = e.target.value as "telegram" | "email";
                      setNurtureNotify(v);
                      void saveNurture(nurtureMode, v);
                    }}
                    disabled={busyService === "nurture"}
                    className="text-[12px] px-2 py-1 rounded-md bg-bg-elev border border-bg-border text-fg"
                  >
                    <option value="telegram">Telegram</option>
                    <option value="email">Email</option>
                  </select>
                  when it needs you.
                </div>
              )}
              {nurtureFlash && <div className="text-[11.5px] text-emerald-300">{nurtureFlash}</div>}
            </div>
          </li>
        </ul>
      )}
    </div>
  );
}
