/**
 * StatusPill — the department's state in its header: Working, Needs you (n),
 * Not connected, Not working, or Couldn't check. It names the DEPARTMENT's
 * state, never an agent's.
 *
 *   working        the channel can answer and nothing is waiting on a person
 *   needs_you      something real is waiting (a breached ticket, a failed
 *                  routine); red, like every needs-you counter in the OS
 *   not_connected  the channel cannot answer yet (no agent for this
 *                  workspace, no AI provider, no agent settings)
 *   not_working    a key is connected, but the channel's last turn failed:
 *                  the provider refused it (billing, key) or it broke off.
 *                  Says why, in the words the channel used for it
 *                  (lib/os/channel/outcome.ts), until a turn succeeds again
 *   unknown        nothing counted is waiting, but a count behind the total
 *                  could not be read (an approvals read failed), or the last
 *                  turn's record could not be read, so "nothing waiting" or
 *                  "answering" is not known and Working would be a guess
 *
 * A dot, not a glow: colour carries the state and the words carry it again
 * for anyone who cannot see the colour.
 */

import { floorCount } from "@/lib/os/count";
import { failureCopy } from "@/lib/os/channel/outcome";
import type { LastTurn } from "./channel";

export type DepartmentStatus =
  | { kind: "working" }
  | { kind: "needs_you"; count: number; capped: boolean }
  | { kind: "not_connected" }
  | { kind: "not_working"; reason: string }
  | { kind: "unknown" };

/**
 * `capped`: the total is a floor — at least one item behind it came from a
 * read that hit its ceiling, or from a read that failed — so it prints as
 * "2+" (lib/os/count.ts); the header must not print "2" over a line that says
 * "2+" (CodeRabbit #469). A floor of 0 says nothing is known to be waiting,
 * which is not the same as nothing waiting: that is `unknown`, never Working.
 */
export function statusFor(channelReady: boolean, needsYou: number, capped = false): DepartmentStatus {
  if (!channelReady) return { kind: "not_connected" };
  if (needsYou > 0) return { kind: "needs_you", count: needsYou, capped };
  if (capped) return { kind: "unknown" };
  return { kind: "working" };
}

/**
 * The channel's last turn, applied over the counts. A channel whose last turn
 * failed is Not working whatever is waiting: the owner's first job is the
 * account, and "Needs you (2)" over a channel that cannot answer hides it. An
 * unreadable record turns Working into Couldn't check; it never turns a real
 * count or Not connected into a guess.
 */
export function withLastTurn(status: DepartmentStatus, lastTurn: LastTurn | null): DepartmentStatus {
  if (!lastTurn || status.kind === "not_connected") return status;
  if (lastTurn.kind === "failed") {
    return { kind: "not_working", reason: failureCopy(lastTurn.code, { canManageAi: false }).short };
  }
  if (lastTurn.kind === "unknown" && status.kind === "working") return { kind: "unknown" };
  return status;
}

export function StatusPill({ status }: { status: DepartmentStatus }) {
  if (status.kind === "needs_you") {
    return (
      <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-unread px-2.5 text-xs font-semibold text-white">
        Needs you
        <span className="tabular-nums">{floorCount(status.count, status.capped)}</span>
      </span>
    );
  }
  if (status.kind === "not_working") {
    return (
      <span className="inline-flex min-h-7 max-w-full items-center gap-2 rounded-full border border-status-hot/40 px-2.5 py-1 text-xs font-medium text-status-hot">
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-hot" />
        <span>Not working: {status.reason}</span>
      </span>
    );
  }
  const working = status.kind === "working";
  return (
    <span className="inline-flex h-7 items-center gap-2 rounded-full border border-hairline px-2.5 text-xs font-medium text-fg-muted">
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${working ? "bg-status-engaged" : "border border-fg-dim"}`}
      />
      {working ? "Working" : status.kind === "unknown" ? "Couldn’t check" : "Not connected"}
    </span>
  );
}
