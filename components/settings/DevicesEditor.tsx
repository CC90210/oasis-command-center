"use client";

/**
 * DevicesEditor — the advanced diagnostics list of paired machines for this
 * tenant, closed by default under "Devices (advanced)".
 *
 * Each row in bridge_pairings is a local install (`oasis bridge start`
 * pinging /api/bridge/ping every 60s). Revoking sets revoked_at; the daemon
 * sees 403 on its next ping, exits, and the computer must be connected again
 * to bring it back online.
 *
 * It does NOT pair anything. A computer is added one way: "Add a device" at
 * the top of Settings > Devices (the connector code, with a link to install
 * the connector). This list used to carry its own "Connect this computer" /
 * "Connect another computer" buttons, and the section a "Full install" link,
 * more ways to do the same job, which left people unsure which one to press
 * (2026-10-15, CC 2026-10-16).
 *
 * REVOKE STAYS ONLY WHERE IT HAS NO OTHER HOME (CC 2026-10-16: this list is
 * diagnostics, not a second place to manage computers). The viewer's own
 * computers are disconnected from "Your computers" above, so their rows here
 * carry no Revoke. A teammate's computer has no Disconnect anywhere else, so
 * its Revoke stays: removing it would leave a pairing nobody can undo.
 */

import { useEffect, useState } from "react";
import { Loader2, Trash2, Check, AlertCircle, Monitor, RefreshCw, Info } from "lucide-react";
import { machineState, presenceWords, timeAgo } from "@/lib/devices/presence";

type Device = {
  id: string;
  label: string;
  machine_fingerprint: string | null;
  last_seen_at: string | null;
  last_seen_ip: string | null;
  created_at: string;
  revoked_at: string | null;
  /** GET /api/devices: true for the viewer's own pairing (O3a). */
  mine?: boolean;
};

/**
 * Plain words for what this workspace's computer owner has, for everyone else
 * (DV0, 2026-10-11, after the 2026-10-11 incident: Adon, a verified operator
 * but not the computer owner, hit a 404 running the full-install command,
 * which names a private repository only the owner's own GitHub account can
 * read). Never a dead button, never the repository name.
 *
 * Updated (DV1): the server side of the connector program (O3a's 'connector'
 * pair-code purpose and scope) is live; the one-click installer that would
 * make this notice obsolete is J2, not shipped yet. So this stays honest
 * instead of promising an install that does not exist, and points this
 * viewer at the one place every signed-in person (this one included) can
 * already get a connector code: Settings > Connect your computer.
 *
 * Updated (D0, 2026-10-12): the old copy flattened "no one-click installer
 * exists yet for a non-team computer" down to a plain claim that there was
 * no install step at all for anyone — false, since the connector already
 * runs on OASIS's own team computers today. Said plainly instead, still
 * never a button that cannot work.
 */
function OwnerOnlyConnectNotice() {
  return (
    <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-4 space-y-2">
      <div className="flex items-center gap-2 text-sm font-bold text-fg">
        <Info className="w-4 h-4 text-fg-dim" aria-hidden="true" />
        Connecting your own computer
      </div>
      <p className="text-xs text-fg-muted leading-relaxed">
        Connecting your own computer would let your agents use its files,
        tools and scheduled jobs. That runs through the OASIS connector app,
        which runs today on OASIS&apos;s own team computers. If you already
        have it, get a connector code from Settings &gt; Connect your
        computer and paste it into the app. If you do not have it yet,
        there is no button here to install it: a one-click installer for
        every other computer is coming, but it is not out yet. Until a
        computer is connected and approved, your department chats pause
        instead of running on someone else&apos;s computer.
      </p>
    </div>
  );
}

/**
 * `installRepo`: the private harness repo, passed by SettingsContent only when
 * the signed-in viewer is this workspace's AGENTS OWNER (lib/agents-owner.ts,
 * O1) — null for every other viewer, operator included, so the repo's name
 * never reaches a non-owner's rendered props. A non-owner sees
 * OwnerOnlyConnectNotice instead of the connect buttons and Revoke; the paired
 * device list itself stays visible (read-only) so they can see what the
 * owner has connected.
 */
export function DevicesEditor({ installRepo }: { installRepo: string | null }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // device id being revoked
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch("/api/devices");
      const j = await r.json();
      if (j.ok) setDevices(j.devices as Device[]);
      else setError(j.error || `http_${r.status}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load_failed");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function revoke(id: string) {
    if (!confirm("Revoke this computer? Its bridge stops working within 60 seconds. To use it again, connect it from this page.")) return;
    setBusy(id);
    setError(null);
    try {
      // confirm=true: the person just said yes in the dialog above. The API
      // requires it to disconnect someone else's computer (O3a), and a
      // missing flag used to make that Revoke answer 409 with nothing done.
      const r = await fetch(`/api/devices?id=${encodeURIComponent(id)}&confirm=true`, { method: "DELETE" });
      const j = await r.json();
      if (!j.ok) {
        setError(j.error || `http_${r.status}`);
      } else {
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "revoke_failed");
    } finally {
      setBusy(null);
    }
  }

  if (devices === null) {
    return (
      <div className="text-fg-dim text-sm flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> loading devices…
      </div>
    );
  }
  if (devices.length === 0) {
    return (
      <div className="space-y-3">
        {error && (
          <div className="rounded-md border border-status-warm/40 bg-status-warm/10 p-3 text-sm text-status-warm flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            <span className="font-mono">{error}</span>
          </div>
        )}
        {installRepo ? (
          <>
            <div className="text-fg-muted text-sm">
              No computers connected yet. Connect one so your agents can use its
              files, tools and scheduled jobs. Chat works without one.
            </div>
            <div className="text-fg-muted text-sm">
              To connect one, use Add a device at the top of Settings &gt; Devices.
            </div>
          </>
        ) : (
          <>
            <div className="text-fg-muted text-sm">
              No computers connected yet. Chat works without one.
            </div>
            <OwnerOnlyConnectNotice />
          </>
        )}
      </div>
    );
  }
  const active = devices.filter((d) => !d.revoked_at);
  const revoked = devices.filter((d) => d.revoked_at);

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-md border border-status-warm/40 bg-status-warm/10 p-3 text-sm text-status-warm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          <span className="font-mono">{error}</span>
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-fg-muted">
          {active.length} active{revoked.length > 0 ? ` · ${revoked.length} revoked` : ""}
        </div>
        <button onClick={load} className="text-fg-dim hover:text-accent text-xs inline-flex items-center gap-1" title="Refresh">
          <RefreshCw className="w-3 h-3" /> refresh
        </button>
      </div>
      {!installRepo && <OwnerOnlyConnectNotice />}
      <ul className="divide-y divide-bg-border">
        {active.map((d) => {
          // The one online rule (lib/devices/presence.ts): idle is not online.
          const state = machineState(d.last_seen_at, Date.now());
          const fresh = state === "online";
          return (
            <li key={d.id} className="py-3 flex items-center justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <Monitor className={`w-4 h-4 mt-0.5 ${fresh ? "text-accent" : "text-fg-dim"}`} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-fg truncate" title={d.label}>{d.label}</span>
                    {/* The words AI brain and Your computers print for the same state (presenceWords), not
                        machineState's raw lowercase key shouted in capitals (CC 2026-10-16). */}
                    <span data-testid="device-presence" className={`text-[11px] font-semibold ${fresh ? "text-accent" : "text-fg-dim"}`}>
                      {presenceWords(state, d.last_seen_at)}
                    </span>
                  </div>
                  <div className="text-[10px] text-fg-dim font-mono mt-0.5 truncate" title={d.machine_fingerprint || undefined}>
                    {d.machine_fingerprint || "no fingerprint"}
                  </div>
                  <div className="text-[10px] text-fg-muted font-mono mt-1">
                    last ping {timeAgo(d.last_seen_at, { moment: true })} · paired {timeAgo(d.created_at, { moment: true })}
                    {d.last_seen_ip && ` · ${d.last_seen_ip}`}
                  </div>
                </div>
              </div>
              {installRepo && d.mine === true && (
                <span className="text-[11px] text-fg-dim shrink-0">Disconnect it in Your computers above</span>
              )}
              {installRepo && d.mine !== true && (
                <button
                  onClick={() => revoke(d.id)}
                  disabled={busy === d.id}
                  className="btn-danger inline-flex items-center gap-1 shrink-0"
                  title="Revoke this pairing"
                >
                  {busy === d.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                  Revoke
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {revoked.length > 0 && (
        <details className="text-xs text-fg-dim">
          <summary className="cursor-pointer hover:text-fg-muted">Revoked ({revoked.length})</summary>
          <ul className="mt-2 space-y-1.5 pl-4">
            {revoked.map((d) => (
              <li key={d.id} className="flex items-center gap-2">
                <Check className="w-3 h-3 text-fg-faint" />
                <span className="font-mono">{d.label}</span>
                <span>· revoked {timeAgo(d.revoked_at, { moment: true })}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
