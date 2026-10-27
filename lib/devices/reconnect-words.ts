/**
 * lib/devices/reconnect-words.ts - what Refresh in Settings > Devices says
 * while it reconnects your offline computers, and after (CC, 2026-10-27).
 *
 * Pure: the card (components/settings/YourComputersCard.tsx) and its test
 * (tests/device-reconnect.test.ts) read the same words. The request, and the
 * check-in reply that carries it to a computer, are lib/devices/reconnect.ts.
 */
import { computerAnswerState, machineState } from "@/lib/devices/presence";

/**
 * How long Refresh watches for a computer it asked to reconnect: its bridge
 * checks in about once a minute, then starts fresh and claims again.
 */
export const RECONNECT_WATCH_MS = 150_000;

/** The facts of one GET /api/devices row these words read. */
export type ReconnectRow = {
  id: string;
  label: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
  claim_enabled_at: string | null;
  claim_state_at: string | null;
  claim_blocked_reason: string | null;
  claim_capacity: number | null;
};

/** Whether a computer reads Offline: approved, but no claim in the last 90 seconds. */
export function readsOffline(d: ReconnectRow, nowMs: number): boolean {
  const facts = {
    claimEnabledAt: d.claim_enabled_at,
    claimStateAt: d.claim_state_at,
    claimBlockedReason: d.claim_blocked_reason,
    claimCapacity: d.claim_capacity,
  };
  return computerAnswerState(facts, nowMs) === "offline";
}

/** "your Mac", "CCPC and your Mac": computers, in words. */
export function namesSentence(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "your computer";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Where the computers Refresh asked stand, by name. */
export type ReconnectOutcome = {
  /** Read anything but Offline again. */
  back: string[];
  /** Still Offline but checking in: the bridge runs, and its check-in tells it to start fresh. */
  checkingIn: string[];
  /** Still Offline and not checking in: asleep, switched off, or without internet. */
  quiet: string[];
};

/**
 * Where each computer asked stands now. Checking in is the heartbeat rule
 * (machineState "online": a check-in within ONLINE_MS, on the server's
 * clock), so Refresh never waits on a computer that is switched off. A
 * computer disconnected meanwhile is left out: it is gone from the list.
 */
export function reconnectOutcome(askedIds: readonly string[], rows: readonly ReconnectRow[], nowMs: number): ReconnectOutcome {
  const outcome: ReconnectOutcome = { back: [], checkingIn: [], quiet: [] };
  for (const id of askedIds) {
    const d = rows.find((row) => row.id === id);
    if (!d || d.revoked_at) continue;
    const name = d.label || "your computer";
    if (!readsOffline(d, nowMs)) outcome.back.push(name);
    else if (machineState(d.last_seen_at, nowMs) === "online") outcome.checkingIn.push(name);
    else outcome.quiet.push(name);
  }
  return outcome;
}

/** Whether Refresh still has a computer to watch for: one checking in that has not reconnected. */
export function reconnectWaiting(outcome: ReconnectOutcome): boolean {
  return outcome.checkingIn.length > 0;
}

/**
 * The line beside Refresh. While it watches (`done` false): who reconnected,
 * and who is being asked. Once every computer is back or RECONNECT_WATCH_MS
 * passes: one still checking in that has not reconnected should be restarted;
 * one not checking in should be woken, at any point.
 */
export function reconnectWords(outcome: ReconnectOutcome, done: boolean): string {
  const parts: string[] = [];
  if (outcome.back.length) parts.push(`${namesSentence(outcome.back)} reconnected.`);
  const { checkingIn, quiet } = outcome;
  if (checkingIn.length && !done) {
    parts.push(`Asking ${namesSentence(checkingIn)} to reconnect. A computer checks in about once a minute.`);
  } else if (checkingIn.length) {
    parts.push(
      checkingIn.length === 1
        ? `${checkingIn[0]} is checking in but hasn't reconnected. If it still reads Offline in a few minutes, restart that computer.`
        : `${namesSentence(checkingIn)} are checking in but haven't reconnected. If they still read Offline in a few minutes, restart those computers.`,
    );
  }
  if (quiet.length) {
    parts.push(
      quiet.length === 1
        ? `${quiet[0]} isn't checking in. If it's asleep or switched off, wake it: it reconnects by itself within a minute.`
        : `${namesSentence(quiet)} aren't checking in. If they're asleep or switched off, wake them: they reconnect by themselves within a minute.`,
    );
  }
  return parts.join(" ");
}
