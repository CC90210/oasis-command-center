/**
 * lib/devices/presence.ts - the one rule for whether a paired computer is
 * online, idle or offline, for every screen and check that says so: Settings
 * > Devices, Operations, System health and the coding header (lib/admin/
 * attention.ts), the chat's bridge check (lib/queries.ts), Background workers
 * and the worker-status check.
 *
 * They used four rules (5 minutes; 90 seconds then 5 minutes; 2 minutes), so
 * one computer read "online" on one page and "offline" on the next (PR #553,
 * "Not in this change"; plan track devices-online-rule).
 *
 * The bridge checks in every HEARTBEAT_S seconds (bravo_cli: /api/bridge/ping).
 *   online   a check-in inside ONLINE_MS: two and a half heartbeats, so one
 *            late or lost ping does not flip it
 *   idle     inside IDLE_MS: a laptop asleep, a restart, a dropped network
 *   offline  older, or never
 *
 * PURE AND CLIENT-SAFE: Settings > Devices draws its rows in the browser.
 */
import { runtimeStatusWords } from "@/lib/bridge-cli-status";

export const HEARTBEAT_S = 60;
export const ONLINE_MS = 150_000;
export const IDLE_MS = 600_000;

export type MachineState = "online" | "idle" | "offline";

/** A computer's state from its last check-in (bridge_pairings.last_seen_at). */
export function machineState(lastSeenAt: string | null | undefined, nowMs: number): MachineState {
  const t = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  if (!Number.isFinite(t)) return "offline";
  const age = nowMs - t;
  if (age < ONLINE_MS) return "online";
  if (age < IDLE_MS) return "idle";
  return "offline";
}

/** Online by the one rule (an idle computer is not online). */
export function isOnline(lastSeenAt: string | null | undefined, nowMs: number): boolean {
  return machineState(lastSeenAt, nowMs) === "online";
}

/**
 * When a computer was last seen, as the device screens say it: "12 s ago", "4 min ago", a time today, or a
 * day and time before today. It lived in components/settings/YourComputersCard.tsx (which still exports
 * it); it is here so presenceWords owns the date in "Offline since".
 */
export function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s ago`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)} min ago`;
  // Older than an hour: a bare "5:20 AM" could be yesterday's, last week's or
  // last month's. Say which day when it is not today.
  const at = new Date(iso);
  if (at.toDateString() === new Date().toDateString()) {
    return at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return at.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Every presence a screen shows for a computer: machineState's three, and busy (every slot has a run in it). */
export type PresenceState = MachineState | "busy";

/**
 * ONE set of words for a computer's presence, for every screen that shows it: Settings > AI brain's
 * computer cards (AgentEnginePanel), Team computers rows (YourComputersCard teamRowLine) and Devices
 * (advanced) (DevicesEditor). An audit (CC 2026-10-16) found one state written three ways: "Online" typed
 * on two screens, machineState's raw lowercase word as a badge on the third. Each screen still decides
 * which state its computer is in by its own rule; this only names the state. Busy and Offline are AI
 * brain's words (lib/bridge-cli-status.ts), so a computer and its apps say the same thing.
 */
export function presenceWords(state: PresenceState, lastSeenAt?: string | null): string {
  if (state === "online") return "Online";
  if (state === "idle") return "Idle";
  if (state === "busy") return runtimeStatusWords("busy");
  // "since never" said nothing true: a computer never seen is just Offline.
  return lastSeenAt ? `${runtimeStatusWords("offline")} since ${timeAgo(lastSeenAt)}` : runtimeStatusWords("offline");
}

/**
 * computerAnswerState (O3b) - whether ONE paired computer can take department
 * work right now, for every screen that says so (Settings > Computers, the
 * department composer banner, Automations' "Runs on" line, /health). A
 * HEARTBEAT (bridge_pairings.last_seen_at / the ping every HEARTBEAT_S) is
 * never enough on its own: a computer that pings but has not called the claim
 * route (O4) recently may be asleep, stuck, or running an old build that
 * cannot claim at all. The gate below reads ONLY the claim columns
 * (bravo__212_pairing_scope_claim.sql): claim_enabled_at (the owner's
 * approval), claim_state_at (the last claim call, O4's own freshness clock),
 * claim_blocked_reason, and claim_capacity.
 *
 *   'can_answer'    approved, claimed inside CLAIM_FRESH_MS, no blocked
 *                   reason, capacity above 0.
 *   'busy'          the same, but capacity is 0 (every slot has a run in it).
 *   'blocked:<r>'   the computer itself reported it cannot answer right now
 *                   (signed out, over its plan limit, an unsafe profile, ...),
 *                   as of its last FRESH claim call.
 *   'offline'       approved, but no claim call inside CLAIM_FRESH_MS. This is
 *                   the state a heartbeat-only computer sits in forever: a
 *                   ping is not a claim, so it can never read 'can_answer'.
 *   'not_approved'  no claim_enabled_at: the owner has not approved this
 *                   computer for work yet (or it is a signup_secret pairing,
 *                   which can never be approved).
 *
 * PURE AND CLIENT-SAFE, like the rest of this module: Settings > Computers
 * computes this in the browser from what GET /api/devices already returns.
 */
export const CLAIM_FRESH_MS = 90_000;

export type ComputerAnswerState = "can_answer" | "busy" | `blocked:${string}` | "offline" | "not_approved";

export type ComputerClaimFacts = {
  claimEnabledAt: string | null | undefined;
  claimStateAt: string | null | undefined;
  claimBlockedReason: string | null | undefined;
  claimCapacity: number | null | undefined;
};

export function computerAnswerState(facts: ComputerClaimFacts, nowMs: number): ComputerAnswerState {
  if (!facts.claimEnabledAt) return "not_approved";
  const claimedAt = facts.claimStateAt ? Date.parse(facts.claimStateAt) : NaN;
  const claimFresh = Number.isFinite(claimedAt) && nowMs - claimedAt < CLAIM_FRESH_MS;
  if (!claimFresh) return "offline";
  const reason = (facts.claimBlockedReason || "").trim();
  if (reason) return `blocked:${reason}`;
  const capacity = typeof facts.claimCapacity === "number" && Number.isFinite(facts.claimCapacity) ? facts.claimCapacity : 0;
  return capacity > 0 ? "can_answer" : "busy";
}

/**
 * One state for several of a person's own computers: the best one answers for
 * all of them (a person with two computers is never refused because the OTHER
 * one is offline). Order: can_answer beats busy beats a blocked reason beats
 * offline beats not_approved. Empty input is 'not_approved' (nothing to connect to).
 */
export function bestComputerAnswerState(states: readonly ComputerAnswerState[]): ComputerAnswerState {
  const rank = (s: ComputerAnswerState): number =>
    s === "can_answer" ? 0 : s === "busy" ? 1 : s.startsWith("blocked:") ? 2 : s === "offline" ? 3 : 4;
  let best: ComputerAnswerState = "not_approved";
  let bestRank = 4;
  for (const s of states) {
    const r = rank(s);
    if (r < bestRank) {
      bestRank = r;
      best = s;
    }
  }
  return best;
}

/**
 * PURE. The refusal code for a person whose EFFECTIVE engine is their own
 * paired computer (lib/os/runs/session.ts), from that person's own pairings
 * (lib/queries.ts getOwnComputers). NO KEY FALLBACK (Adon, 2026-10-11):
 * every return is a refusal code, never null/undefined for "proceed" --
 * 'can_answer' refuses too, honestly, until O4's pull dispatch exists to
 * actually run a turn on a person's own computer. Letting a run through here
 * would either hang waiting for a claim that never comes, or silently
 * answer on whatever the WORKSPACE engine happens to be -- exactly the
 * fallback this rule exists to prevent.
 */
export function personComputerRefusal(computers: ReadonlyArray<ComputerClaimFacts>, now: number): string {
  if (computers.length === 0) return "computer_not_connected";
  const state = bestComputerAnswerState(computers.map((c) => computerAnswerState(c, now)));
  if (state === "not_approved") return "computer_not_approved";
  if (state === "offline") return "computer_offline";
  if (state === "busy") return "computer_busy";
  if (state.startsWith("blocked:")) return "computer_blocked";
  // state === "can_answer": real dispatch to a person's own computer is O4's.
  return "computer_dispatch_not_ready";
}

/**
 * Plain words for one state, used by every screen that renders it. Pass
 * `ownerName` when `label` is NOT the viewer's own computer (a teammate's
 * row): the sentence then names that person instead of saying "your" to
 * someone it is not true for. Omit it for the viewer's own computer, where
 * "your approval" is correct.
 */
export function computerAnswerSentence(state: ComputerAnswerState, label: string, ownerName?: string | null): string {
  if (state === "can_answer") return `${label} is ready for department work.`;
  if (state === "busy") return `${label} is finishing another reply. Yours is next.`;
  if (state === "not_approved") {
    return ownerName
      ? `${label} connected. Not yet approved by ${ownerName} for department work.`
      : `${label} connected. Waiting for your approval.`;
  }
  if (state === "offline") return `${label} is offline.`;
  return `${label} connected, can't answer: ${state.slice("blocked:".length)}.`;
}
