"use client";

/**
 * YourComputersCard — "Your computers" (O3b). Each person's OWN computers,
 * in plain words, with an Approve button for one they have not approved yet.
 *
 * Reads GET /api/devices (O3a: returns the viewer's own pairings always, plus
 * every pairing for an owner/admin with `mine` set) and GET /api/bridge/
 * cli-status (the same CLI inventory the coding harness card reads, matched
 * here by pairing id for the department inventory lines). Approves with
 * POST /api/devices/[id]/approve (O3a, owner-of-that-computer only).
 *
 * computerAnswerState (lib/devices/presence.ts) is the ONE rule: a heartbeat
 * alone never reads as able to answer department work, only a fresh CLAIM
 * does — and before O4's claim loop and J1's connector exist, no computer
 * ever reports one, so every approved computer here reads 'offline' until
 * then. That is the honest state, not a bug in this card.
 *
 * Disconnecting a computer (any state) stays in DevicesEditor below, which
 * already carries the revoke flow and its own pinned copy; this card never
 * duplicates it.
 */

import { useEffect, useState } from "react";
import { AlertCircle, Check, Clock, Copy, Loader2, Monitor, RefreshCw } from "lucide-react";
import {
  bestComputerAnswerState,
  computerAnswerState,
  machineState,
  type ComputerAnswerState,
} from "@/lib/devices/presence";
import { departmentInventoryLine, type CliProvider, type CliStatusInfo } from "@/lib/bridge-cli-status";

type DeviceRow = {
  id: string;
  user_id: string | null;
  label: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
  scope: string | null;
  paired_via: string | null;
  claim_enabled_at: string | null;
  claim_state_at: string | null;
  claim_blocked_reason: string | null;
  claim_capacity: number | null;
  mine: boolean;
  /** The pairing's owner display name, for a Team computers row only (API
   * leaves this null for the viewer's own rows, which never need it). */
  owner_name: string | null;
};

type MachineInventory = { id: string | null; label: string | null; data: Record<CliProvider, CliStatusInfo> };

const BLOCKED_REASON_WORDS: Record<string, string> = {
  subscription_auth_failure: "Claude Code is signed out",
  subscription_limit: "your Claude plan's usage limit was reached",
  department_profile_unsupported: "its department profile is out of date",
  department_profile_unsafe: "its department profile failed a safety check",
  cli_not_found: "Claude Code isn't installed there anymore",
  claude_account_changed: "it signed in to a different Claude account; approve it again",
  claude_account_shared: "its Claude account is already bound to another person's computer",
};

function blockedWords(reason: string): string {
  return BLOCKED_REASON_WORDS[reason] || reason.replace(/_/g, " ");
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s ago`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)} min ago`;
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** The exact row line (ui_changes section 1), from the one state. */
function rowLine(label: string, state: ComputerAnswerState, claimStateAt: string | null, lastSeenAt: string | null): string {
  if (state === "can_answer") return `${label} · Ready for department work, checked ${timeAgo(claimStateAt)}`;
  if (state === "busy") return `${label} · Finishing a reply`;
  if (state === "not_approved") return `${label} · Waiting for your approval`;
  if (state === "offline") return `${label} · Offline since ${timeAgo(lastSeenAt)}`;
  return `${label} · Connected, can't answer: ${blockedWords(state.slice("blocked:".length))}`;
}

/**
 * The Team computers row line (fixes: these rows were reusing rowLine's
 * "Waiting for your approval", which told CC's Mac and CCPC that THEY were
 * waiting on Adon's own approval -- never true for a computer that is not
 * his). Names the owner, never says "your" or "you". The presence word
 * comes from the plain heartbeat (lib/devices/presence.ts machineState), not
 * computerAnswerState's claim-freshness rule -- a teammate's machine can be
 * genuinely online and simply not yet approved, and that is worth showing.
 *
 * machineState has THREE states, not two (Codex review, P2, 2026-10-12): a
 * heartbeat 150-600s old is 'idle', not 'offline' -- a sleeping laptop, a
 * dropped network, a restart in progress. Collapsing 'idle' into "Online"
 * read as a live, working computer when it was anything but; it now gets
 * its own word, matching lib/devices/presence.ts's own rule exactly.
 */
function teamRowLine(
  label: string,
  ownerName: string,
  state: ComputerAnswerState,
  claimStateAt: string | null,
  lastSeenAt: string | null,
  nowMs: number,
): string {
  if (state === "can_answer") return `${label} · Ready for department work, checked ${timeAgo(claimStateAt)}`;
  if (state === "busy") return `${label} · Finishing a reply`;
  if (state === "not_approved") {
    const heartbeat = machineState(lastSeenAt, nowMs);
    const presence = heartbeat === "offline" ? `Offline since ${timeAgo(lastSeenAt)}` : heartbeat === "idle" ? "Idle" : "Online";
    return `${label} · ${presence} · not yet approved by ${ownerName} for department work`;
  }
  if (state === "offline") return `${label} · Offline since ${timeAgo(lastSeenAt)}`;
  return `${label} · Connected, can't answer: ${blockedWords(state.slice("blocked:".length))}`;
}

export function YourComputersCard() {
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [machines, setMachines] = useState<MachineInventory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const [dr, cr] = await Promise.all([
        fetch("/api/devices").then((r) => r.json()),
        fetch("/api/bridge/cli-status").then((r) => r.json()).catch(() => ({ ok: false })),
      ]);
      if (dr.ok) setDevices(dr.devices as DeviceRow[]);
      else setError(dr.error || "load_failed");
      setMachines(cr.ok && Array.isArray(cr.machines) ? (cr.machines as MachineInventory[]) : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load_failed");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function approve(id: string) {
    setBusyId(id);
    setNotice(null);
    try {
      const r = await fetch(`/api/devices/${encodeURIComponent(id)}/approve`, { method: "POST" });
      const j = await r.json();
      if (!j.ok) {
        setNotice(
          j.error === "daemon_pairing_requires_agents_owner"
            ? "Only this workspace's computer owner can approve a shared computer like this one."
            : j.error === "not_your_computer"
              ? "This computer is already connected for someone else. They can disconnect it in Settings > Computers."
              : j.message || j.error || "Could not approve this computer. Try again.",
        );
      } else {
        await load();
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "approve_failed");
    } finally {
      setBusyId(null);
    }
  }

  // A first load that failed shows the error and a way to retry, never an
  // endless spinner (Codex review, O3b).
  if (devices === null && error) {
    return (
      <div className="text-sm flex items-center gap-3" role="alert">
        <span className="text-fg-dim">Couldn&apos;t load your computers just now.</span>
        <button onClick={load} className="text-fg-dim hover:text-accent text-xs inline-flex items-center gap-1">
          <RefreshCw className="w-3 h-3" /> Try again
        </button>
      </div>
    );
  }

  if (devices === null) {
    return (
      <div className="text-fg-dim text-sm flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> loading your computers…
      </div>
    );
  }

  const mine = devices.filter((d) => d.mine && !d.revoked_at);
  const theirs = devices.filter((d) => !d.mine && !d.revoked_at);
  const now = Date.now();

  const inventoryFor = (id: string): string[] => {
    const m = machines.find((x) => x.id === id);
    if (!m) return [];
    return (["claude", "codex", "gemini"] as CliProvider[]).filter((p) => m.data[p]?.installed).map((p) => departmentInventoryLine(p, m.data[p]));
  };

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-md border border-status-warm/40 bg-status-warm/10 p-3 text-sm text-status-warm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          <span className="font-mono">{error}</span>
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-bg-border bg-bg-elev/40 p-3 text-xs text-fg-muted">{notice}</div>
      )}
      <div className="flex items-center justify-end">
        <button onClick={load} className="text-fg-dim hover:text-accent text-xs inline-flex items-center gap-1" title="Refresh">
          <RefreshCw className="w-3 h-3" /> refresh
        </button>
      </div>
      {mine.length === 0 ? (
        <div className="text-fg-muted text-sm">No computers connected for you yet. Connect one below.</div>
      ) : (
        <ul className="divide-y divide-bg-border">
          {mine.map((d) => {
            const state = computerAnswerState(
              {
                claimEnabledAt: d.claim_enabled_at,
                claimStateAt: d.claim_state_at,
                claimBlockedReason: d.claim_blocked_reason,
                claimCapacity: d.claim_capacity,
              },
              now,
            );
            const label = d.label || "Unnamed computer";
            const fresh = state === "can_answer";
            return (
              <li key={d.id} className="py-3 flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <Monitor className={`w-4 h-4 mt-0.5 ${fresh ? "text-accent" : "text-fg-dim"}`} aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="text-sm text-fg">{rowLine(label, state, d.claim_state_at, d.last_seen_at)}</div>
                    {inventoryFor(d.id).length > 0 && (
                      <div className="text-[11px] text-fg-dim mt-1 space-y-0.5">
                        {inventoryFor(d.id).map((line) => (
                          <div key={line}>{line}</div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                {state === "not_approved" && (
                  <button
                    onClick={() => approve(d.id)}
                    disabled={busyId === d.id}
                    className="btn-primary text-xs inline-flex items-center gap-1 shrink-0"
                  >
                    {busyId === d.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                    Use this computer
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {theirs.length > 0 && (
        <details className="text-xs text-fg-dim">
          <summary className="cursor-pointer hover:text-fg-muted">Team computers ({theirs.length})</summary>
          <ul className="mt-2 divide-y divide-bg-border">
            {theirs.map((d) => {
              const state = computerAnswerState(
                {
                  claimEnabledAt: d.claim_enabled_at,
                  claimStateAt: d.claim_state_at,
                  claimBlockedReason: d.claim_blocked_reason,
                  claimCapacity: d.claim_capacity,
                },
                now,
              );
              const ownerName = d.owner_name || "a teammate";
              const label = d.label || "A teammate's computer";
              return (
                <li key={d.id} className="py-2 text-fg-muted">
                  {teamRowLine(label, ownerName, state, d.claim_state_at, d.last_seen_at, now)}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Exported for tests: the one state several of a person's computers reduce to. */
export { bestComputerAnswerState };
/** Exported for tests: the Team computers row line (D0 — never "your approval"). */
export { teamRowLine };

// ─────────────────────────────────────────────────────────────────────────
// ConnectYourComputerCard (DV1) — mint a connector code, for every signed-in
// person in the workspace, not only this workspace's computer owner.
//
// WHY A SEPARATE CARD FROM THE LIST ABOVE. YourComputersCard (and "Devices
// (advanced)" beside it) stay behind SettingsContent's VERIFIED-operator
// gate: that was a deliberate OASIS-only choice (O3b) pending J2's client
// installer, and this task is not J2 — it is giving every workspace member a
// way to use the connector program (J1) that O3a's server side has already
// supported since the 'connector' purpose/scope landed. So this card asks for
// nothing the gated list needs: it mints its own code, watches for the
// pairing the connector creates, and lets the person approve THAT pairing
// right here — the owner-of-that-computer rule (POST /api/devices/[id]/
// approve) already allows any person to approve a pairing they themselves
// hold, operator or not.
//
// Never the old full-install one-liner, never the private harness repo's
// name: this is the connector app's path, not the harness clone (DV0).
// ─────────────────────────────────────────────────────────────────────────

type ConnectorDeviceRow = {
  id: string;
  label: string | null;
  mine: boolean;
  revoked_at: string | null;
  created_at: string;
  claim_enabled_at: string | null;
};

type ConnectState =
  | { phase: "idle" }
  | { phase: "minting" }
  | { phase: "error"; message: string }
  /** The workspace does not let this person connect a computer (403): permanent, never "try again". */
  | { phase: "forbidden" }
  /** mintedAtMs identifies this code (browser clock); serverMintedAtMs is the server's mint time, the only baseline compared with server timestamps. */
  | { phase: "code"; code: string; expiresAt: string; mintedAtMs: number; serverMintedAtMs: number }
  | { phase: "expired" }
  | { phase: "found"; pairingId: string; label: string; approving: boolean; approveError: string | null }
  | { phase: "approved"; label: string };

/** Seconds left on a minted code's TTL, never negative. */
function secondsUntil(iso: string, nowMs: number): number {
  return Math.max(0, Math.floor((new Date(iso).getTime() - nowMs) / 1000));
}

function mmss(secondsLeft: number): string {
  const mm = Math.floor(secondsLeft / 60).toString().padStart(2, "0");
  const ss = (secondsLeft % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

export function ConnectYourComputerCard() {
  const [state, setState] = useState<ConnectState>({ phase: "idle" });
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [copied, setCopied] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  async function mint() {
    setState({ phase: "minting" });
    setCopied(false);
    try {
      const r = await fetch("/api/auth/pair-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ purpose: "connector" }),
      });
      // 403: this workspace only lets owners and admins connect a computer
      // (independent review, DV1). Say so; a retry can never succeed.
      if (r.status === 403) {
        setState({ phase: "forbidden" });
        return;
      }
      const j = await r.json();
      if (!j.ok || typeof j.code !== "string" || typeof j.expires_at !== "string") {
        setState({ phase: "error", message: j.error || `http_${r.status}` });
        return;
      }
      const ttl = typeof j.ttl_minutes === "number" ? j.ttl_minutes : 5;
      // The server's own mint time (its expiry minus the code's life), so a new
      // pairing's created_at is compared clock-to-clock on the server side: a
      // browser clock running ahead would otherwise hide a successful pairing
      // (CodeRabbit, PR #590).
      const serverMintedAtMs = new Date(j.expires_at).getTime() - ttl * 60_000;
      setState({ phase: "code", code: j.code, expiresAt: j.expires_at, mintedAtMs: Date.now(), serverMintedAtMs });
      setAnnouncement(`Connector code ${j.code}. Expires in ${ttl} minute${ttl === 1 ? "" : "s"}.`);
    } catch (e) {
      setState({ phase: "error", message: e instanceof Error ? e.message : "code_failed" });
    }
  }

  // The countdown, while a code is live.
  useEffect(() => {
    if (state.phase !== "code") return;
    const { expiresAt, mintedAtMs } = state;
    let announcedExpiry = false;
    const tick = () => {
      const left = secondsUntil(expiresAt, Date.now());
      setSecondsLeft(left);
      if (left === 0 && !announcedExpiry) {
        announcedExpiry = true;
        setAnnouncement("This code expired. Get a new one below.");
        setState((s) => (s.phase === "code" && s.mintedAtMs === mintedAtMs ? { phase: "expired" } : s));
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [state]);

  // Watch for the pairing the connector creates once someone pastes the
  // code in on the other computer — a new, unrevoked row of this person's
  // own (GET /api/devices already scopes "mine" to the signed-in user)
  // created after this code was minted.
  useEffect(() => {
    if (state.phase !== "code") return;
    const { serverMintedAtMs } = state;
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch("/api/devices");
        const j = await r.json();
        if (cancelled || !j.ok || !Array.isArray(j.devices)) return;
        const fresh = (j.devices as ConnectorDeviceRow[]).find(
          (d) => d.mine && !d.revoked_at && new Date(d.created_at).getTime() > serverMintedAtMs,
        );
        if (!fresh) return;
        const label = fresh.label || "Your computer";
        if (fresh.claim_enabled_at) {
          setAnnouncement(`${label} is connected.`);
          setState({ phase: "approved", label });
        } else {
          setAnnouncement(`${label} connected. Approve it to let it take department work.`);
          setState({ phase: "found", pairingId: fresh.id, label, approving: false, approveError: null });
        }
      } catch {
        // Transient — keep polling until the code's own countdown ends it.
      }
    };
    void poll();
    const t = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [state]);

  async function approvePairing() {
    if (state.phase !== "found") return;
    const { pairingId, label } = state;
    setState({ phase: "found", pairingId, label, approving: true, approveError: null });
    try {
      const r = await fetch(`/api/devices/${encodeURIComponent(pairingId)}/approve`, { method: "POST" });
      const j = await r.json();
      if (!j.ok) {
        setState({
          phase: "found",
          pairingId,
          label,
          approving: false,
          approveError: j.message || j.error || "Could not approve this computer. Try again.",
        });
        return;
      }
      setAnnouncement(`${label} is connected.`);
      setState({ phase: "approved", label });
    } catch (e) {
      setState({ phase: "found", pairingId, label, approving: false, approveError: e instanceof Error ? e.message : "approve_failed" });
    }
  }

  function handleCopy() {
    if (state.phase !== "code" || typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(state.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="space-y-3">
      {/* Announced once per change (mint, expiry, found, approved) — never on every tick of the clock below. */}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      <p className="text-sm text-fg-muted leading-relaxed max-w-xl">
        Connecting a computer runs through the OASIS connector app. Get a code below, then open the connector on that computer and paste it in.
      </p>
      {state.phase === "error" && (
        <div role="alert" className="rounded-md border border-status-warm/40 bg-status-warm/10 p-3 text-sm text-status-warm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" aria-hidden="true" />
          <span>Could not get a code just now. Try again.</span>
        </div>
      )}
      {state.phase === "forbidden" && (
        <div role="status" className="rounded-md border border-border p-3 text-sm text-fg-muted flex items-center gap-2">
          <AlertCircle className="w-4 h-4" aria-hidden="true" />
          <span>Only an owner or admin can connect a computer in this workspace. Ask one of them if you need yours connected.</span>
        </div>
      )}
      {(state.phase === "idle" || state.phase === "minting" || state.phase === "error") && (
        <button type="button" onClick={mint} disabled={state.phase === "minting"} className="btn-primary inline-flex items-center gap-2">
          {state.phase === "minting" ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Monitor className="w-4 h-4" aria-hidden="true" />}
          {state.phase === "minting" ? "Getting a code..." : state.phase === "error" ? "Try again" : "Get a connector code"}
        </button>
      )}
      {state.phase === "expired" && (
        <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-4 space-y-2">
          <div className="text-sm text-fg">This code expired.</div>
          <button type="button" onClick={mint} className="btn-primary inline-flex items-center gap-2">
            <Monitor className="w-4 h-4" aria-hidden="true" />
            Get a new code
          </button>
        </div>
      )}
      {state.phase === "code" && (
        <div className="rounded-lg border border-accent/40 bg-accent/5 p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="text-[11px] uppercase tracking-wider font-bold text-accent">Your connector code</div>
            <div className="text-[11px] text-fg-dim font-mono tabular-nums inline-flex items-center gap-1">
              <Clock className="w-3 h-3" aria-hidden="true" /> expires in {mmss(secondsLeft)}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-2xl font-black tracking-[0.2em] tabular-nums text-fg text-center bg-bg-deep rounded-md px-3 py-2.5 select-all">
              {state.code}
            </code>
            <button type="button" onClick={handleCopy} aria-live="polite" className="btn-secondary inline-flex items-center gap-1 shrink-0">
              {copied ? <Check className="w-3 h-3 text-status-engaged" aria-hidden="true" /> : <Copy className="w-3 h-3" aria-hidden="true" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <ol className="text-xs text-fg-muted leading-relaxed list-decimal list-inside space-y-1">
            <li>On the computer you want to connect, open the OASIS connector and paste this code.</li>
            <li>Confirm the workspace and account it shows.</li>
            <li>Come back here and click Approve on that computer.</li>
          </ol>
          <button type="button" onClick={mint} className="text-[11px] text-fg-dim hover:text-fg-muted underline">
            Get a new code
          </button>
        </div>
      )}
      {state.phase === "found" && (
        <div className="rounded-lg border border-accent/40 bg-accent/5 p-4 space-y-3">
          <div className="flex items-start gap-3">
            <Monitor className="w-4 h-4 mt-0.5 text-accent" aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-sm text-fg">{state.label} connected.</div>
              <div className="text-xs text-fg-muted mt-0.5">Waiting for your approval before it can take department work.</div>
            </div>
          </div>
          {state.approveError && (
            <div role="alert" className="text-xs text-status-warm">
              {state.approveError}
            </div>
          )}
          <button type="button" onClick={approvePairing} disabled={state.approving} className="btn-primary inline-flex items-center gap-2">
            {state.approving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Check className="w-4 h-4" aria-hidden="true" />}
            Approve
          </button>
        </div>
      )}
      {state.phase === "approved" && (
        <div className="rounded-lg border border-status-engaged/40 bg-status-engaged/10 p-4 flex items-start gap-3">
          <Check className="w-5 h-5 text-status-engaged shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <div className="font-bold text-fg">{state.label} is connected.</div>
            <div className="text-sm text-fg-muted mt-1">
              It can take department work once it is online.{" "}
              <button type="button" onClick={() => setState({ phase: "idle" })} className="underline hover:text-fg">
                Connect another computer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
