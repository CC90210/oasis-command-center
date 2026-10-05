/**
 * components/os/approvals/outcome.ts — the one line a card shows once an
 * approval is no longer waiting: "Sent ✓ 10:42 AM", "Failed: the recipient
 * has opted out", "Dry run ✓ — nothing was sent".
 *
 * PURE (a formatter is passed in), so tests pin every wording.
 *
 * NEVER CLAIMS SUCCESS ON ITS OWN. Every word below comes from the row's own
 * status and the executor's recorded `outcome`. An approved row the executor
 * has not finished says so; an `executing` row that has gone quiet says the
 * result is unknown and to check before approving it again; an `executed`
 * row with no readable outcome says exactly that, not "Sent".
 */
import type { ApprovalView } from "@/lib/os/approvals/rules";

export type OutcomeTone = "ok" | "info" | "warn" | "fail";
export type Outcome = { tone: OutcomeTone; text: string; detail: string | null };

/** After this long in `executing` with no result, the card stops saying "in progress". */
export const EXECUTING_STALE_MS = 2 * 60_000;

type OutcomeInput = Pick<
  ApprovalView,
  | "status"
  | "action_kind"
  | "decided_at"
  | "decided_by_name"
  | "decision_note"
  | "executing_at"
  | "executed_at"
  | "execution_result"
  | "expires_at"
  | "updated_at"
>;

export function describeOutcome(a: OutcomeInput, fmt: (iso: string) => string, nowMs: number): Outcome | null {
  const by = a.decided_by_name ? ` by ${a.decided_by_name}` : "";
  const at = (iso: string | null) => (iso ? ` ${fmt(iso)}` : "");
  switch (a.status) {
    case "pending":
      return null;
    case "approved":
      return { tone: "info", text: `Approved${at(a.decided_at)}${by}`, detail: "Waiting to be carried out." };
    case "executing": {
      const started = a.executing_at ? Date.parse(a.executing_at) : NaN;
      if (Number.isFinite(started) && nowMs - started > EXECUTING_STALE_MS) {
        return {
          tone: "warn",
          text: `No result recorded since${at(a.executing_at)}`,
          detail: "It may have gone out. Check before approving a new version.",
        };
      }
      return { tone: "info", text: `Carrying it out…${a.executing_at ? ` started${at(a.executing_at)}` : ""}`, detail: null };
    }
    case "executed": {
      const r = a.execution_result;
      if (r?.outcome === "sent") return { tone: "ok", text: `Sent ✓${at(a.executed_at)}`, detail: by ? `Approved${by}` : null };
      if (r?.outcome === "dry_run") {
        return {
          tone: "warn",
          text: `Dry run ✓${at(a.executed_at)}`,
          detail: "Nothing was sent: live sending is off on this deployment.",
        };
      }
      if (r?.outcome === "queued") {
        return {
          tone: "ok",
          text: `Queued to publish ✓${at(a.executed_at)}`,
          detail: "The publisher posts it on its next run.",
        };
      }
      return { tone: "warn", text: `Carried out${at(a.executed_at)}`, detail: "No outcome was recorded for it." };
    }
    case "failed": {
      const r = a.execution_result;
      const message = r?.outcome === "failed" ? r.message : "No reason was recorded.";
      return { tone: "fail", text: `Failed: ${message}`, detail: a.executed_at ? fmt(a.executed_at) : null };
    }
    case "sent_back":
      return { tone: "info", text: `Sent back${at(a.decided_at)}${by}`, detail: a.decision_note };
    case "expired":
      return { tone: "warn", text: `Expired${at(a.expires_at)}`, detail: "Nobody decided in time, so nothing was done." };
    case "cancelled":
      return { tone: "info", text: `Withdrawn${at(a.updated_at)}`, detail: "A newer version replaced it." };
    default: {
      const unhandled: never = a.status;
      return { tone: "warn", text: `Unknown state: ${String(unhandled)}`, detail: null };
    }
  }
}

/**
 * Which copy of an approval a card shows: the one its own click got back, or
 * the one a later server render brought (router.refresh — the Feed refreshes
 * every 30 s). The newer wins, so a refresh shows a teammate's comment or the
 * executor's result, and a refresh that started before a click returned
 * cannot roll the card back. Every transition moves updated_at; a comment
 * moves only the comment list. A tie goes to the server's copy, which also
 * carries what time alone changes (a pending card that has expired).
 */
export function newerApproval<T extends Pick<ApprovalView, "updated_at" | "comments">>(shown: T, incoming: T): T {
  if (incoming.updated_at !== shown.updated_at) return incoming.updated_at > shown.updated_at ? incoming : shown;
  return incoming.comments.length >= shown.comments.length ? incoming : shown;
}

/** Who asked, in words: "AI teammate", "Routine", "Teammate". */
export function requesterLabel(type: ApprovalView["requested_by_type"]): string {
  return type === "agent" ? "AI teammate" : type === "routine" ? "Routine" : "Teammate";
}
