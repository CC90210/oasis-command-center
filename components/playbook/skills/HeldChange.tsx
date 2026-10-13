"use client";
/**
 * One held change (JARVIS plan 3, spec section 6 "Held-change review"): what it is, who made it,
 * which computer it is for, how many prompts got worse and better, per-kind-of-work totals worst
 * first, and Reject / Edit change / Accept anyway. Accept anyway stays off until the proof prompts
 * are uploaded (plan 4), because the spec makes proof mandatory before anything held goes live.
 */
import { useMemo, useState } from "react";
import { actionErrorMessage, labelNames, markEdited, opText, shortDate, toggleOp, totalsRows, type ChangeRow, type Library } from "@/lib/skills/view";
import { api } from "./actions";
import { Btn, focusRing } from "./ui";

/**
 * Fix round 1 (task 9) #4: the exact string Save sends, pulled out of the Save button's onClick
 * so a test can pin that the real Save path goes through `markEdited` (never an inline
 * `` `${description} (edited)` `` that would double the marker on a second edit) even though the
 * static render harness has no way to click the button and observe what gets sent.
 */
export function editedDescription(change: ChangeRow): string {
  return markEdited(change.description);
}

export function HeldChange({ change, lib, computerId, computerName, proofReady = false, onDone }: {
  change: ChangeRow; lib: Library; computerId: string; computerName: string; proofReady?: boolean; onDone: (message: string) => void;
}) {
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [keep, setKeep] = useState<boolean[]>(() => change.ops.map(() => true));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = useMemo(() => labelNames(lib), [lib]);
  const rows = totalsRows(change, lib);
  const proofId = `proof-${change.change_id}`;
  const editReasonId = `edit-reason-${change.change_id}`;
  const kept = change.ops.filter((_, i) => keep[i]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      // Fix round 1 (task 9) #5: a successful Reject or Edit returns to view mode - never leaves
      // the edit form open with its controls re-enabled on a change that already moved on.
      setMode("view");
      setKeep(change.ops.map(() => true));
      onDone(done);
    } catch (e) {
      setError(`${actionErrorMessage(e as { status?: number; code?: string })} Nothing changed.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article aria-labelledby={`held-${change.change_id}`} className="space-y-4 rounded-xl border border-hairline bg-bg-panel p-4">
      <header className="space-y-1">
        <h4 id={`held-${change.change_id}`} className="text-sm font-semibold text-fg">{change.description}</h4>
        <p className="text-xs text-fg-dim">By {change.author} · held {shortDate(change.updated_at)} · for {computerName}</p>
        <p className="text-sm tabular-nums">
          <span className="text-status-hot">{change.worse} got worse</span>
          <span className="text-fg-dim"> · </span>
          <span className="text-status-engaged">{change.better} got better</span>
        </p>
        {change.reason && <p className="text-xs text-fg-muted">{change.reason}</p>}
      </header>

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Prompts routed right, before and after this change, per kind of work</caption>
            <thead>
              <tr className="text-xs text-fg-dim">
                <th scope="col" className="py-1.5 pr-3 text-left font-medium">Kind of work</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">Prompts</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">Before</th>
                <th scope="col" className="py-1.5 text-right font-medium">After</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {rows.map((r) => (
                <tr key={r.id} className="h-9">
                  <th scope="row" className="pr-3 text-left font-normal text-fg">{r.name}</th>
                  <td className="pr-3 text-right tabular-nums text-fg-muted">{r.n}</td>
                  <td className="pr-3 text-right tabular-nums text-fg-muted">{r.before}</td>
                  <td className={`text-right tabular-nums ${r.delta < 0 ? "text-status-hot" : r.delta > 0 ? "text-status-engaged" : "text-fg-muted"}`}>{r.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!proofReady && (
        <p id={proofId} className="text-xs text-fg-dim">The prompts behind these numbers are not uploaded yet, so Accept anyway stays off until they are.</p>
      )}

      {mode === "edit" ? (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium text-fg-dim">Keep these parts of the change</legend>
          {change.ops.map((op, i) => (
            <label key={i} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 text-sm text-fg hover:bg-bg-hover">
              <input type="checkbox" checked={keep[i]} onChange={() => setKeep(toggleOp(change.ops, keep, i))}
                className={`h-4 w-4 accent-[rgb(var(--c-accent))] ${focusRing}`} />
              {opText(op, names)}
            </label>
          ))}
          <div className="flex flex-wrap gap-2 pt-2">
            <Btn variant="primary" disabled={busy || kept.length === 0}
              onClick={() => run(() => api.revise(change.change_id, computerId, editedDescription(change), kept), "Edited. The new version goes to tonight's check.")}>
              {kept.length === 0 ? "Keep at least one part" : "Send the edited change to tonight's check"}
            </Btn>
            <Btn variant="ghost" disabled={busy} onClick={() => { setMode("view"); setKeep(change.ops.map(() => true)); }}>Cancel</Btn>
          </div>
        </fieldset>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Btn variant="danger" disabled={busy} onClick={() => run(() => api.decide(change.change_id, computerId, "reject"), "Rejected. It will not go live.")}>Reject</Btn>
          <Btn disabled={busy || change.ops.length === 0} aria-describedby={change.ops.length === 0 ? editReasonId : undefined} onClick={() => setMode("edit")}>Edit change</Btn>
          <Btn variant="primary" disabled={busy || !proofReady} aria-describedby={proofReady ? undefined : proofId}
            onClick={() => run(() => api.decide(change.change_id, computerId, "accept-anyway"), "Accepted. It goes live after tonight's check.")}>
            Accept anyway
          </Btn>
        </div>
      )}
      {change.ops.length === 0 && mode === "view" && (
        <p id={editReasonId} className="text-xs text-fg-dim">This change has nothing to edit.</p>
      )}
      {/* Fix round 1 (task 9) #7: always rendered (not mounted only while busy), so an assistive
          technology's live-region announcement is reliable - some screen readers miss a region
          that only appears at the moment it has something to say. */}
      <p role="status" className="text-xs text-fg-dim">{busy ? "Sending." : ""}</p>
      {error && <p role="alert" className="text-sm text-status-hot">{error}</p>}
    </article>
  );
}
