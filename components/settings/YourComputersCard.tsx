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
import { AlertCircle, Check, Loader2, Monitor, RefreshCw } from "lucide-react";
import {
  bestComputerAnswerState,
  computerAnswerState,
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
};

type MachineInventory = { id: string | null; label: string | null; data: Record<CliProvider, CliStatusInfo> };

const BLOCKED_REASON_WORDS: Record<string, string> = {
  subscription_auth_failure: "Claude Code is signed out",
  subscription_limit: "your Claude plan's usage limit was reached",
  department_profile_unsupported: "its department profile is out of date",
  department_profile_unsafe: "its department profile failed a safety check",
  cli_not_found: "Claude Code isn't installed there anymore",
  claude_account_changed: "it signed in to a different Claude account; approve it again",
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
              return (
                <li key={d.id} className="py-2 text-fg-muted">
                  {rowLine(d.label || "Unnamed computer", state, d.claim_state_at, d.last_seen_at)}
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
