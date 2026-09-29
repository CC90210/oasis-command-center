/**
 * StatusPill — the department's state in its header: Working, Needs you (n),
 * or Not connected. It names the DEPARTMENT's state, never an agent's.
 *
 *   working        the channel can answer and nothing is waiting on a person
 *   needs_you      something real is waiting (a breached ticket, a failed
 *                  routine); red, like every needs-you counter in the OS
 *   not_connected  the channel cannot answer yet (no agent for this
 *                  workspace, no AI provider, no agent settings)
 *
 * A dot, not a glow: colour carries the state and the words carry it again
 * for anyone who cannot see the colour.
 */

import { floorCount } from "@/lib/os/count";

export type DepartmentStatus =
  | { kind: "working" }
  | { kind: "needs_you"; count: number; capped: boolean }
  | { kind: "not_connected" };

/**
 * `capped`: at least one item behind the total came from a read that hit its
 * ceiling, so the total is a floor and prints as "2+" (lib/os/count.ts) — the
 * header must not print "2" over a line that says "2+" (CodeRabbit #469).
 */
export function statusFor(channelReady: boolean, needsYou: number, capped = false): DepartmentStatus {
  if (!channelReady) return { kind: "not_connected" };
  if (needsYou > 0) return { kind: "needs_you", count: needsYou, capped };
  return { kind: "working" };
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
  const working = status.kind === "working";
  return (
    <span className="inline-flex h-7 items-center gap-2 rounded-full border border-hairline px-2.5 text-xs font-medium text-fg-muted">
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${working ? "bg-status-engaged" : "border border-fg-dim"}`}
      />
      {working ? "Working" : "Not connected"}
    </span>
  );
}
