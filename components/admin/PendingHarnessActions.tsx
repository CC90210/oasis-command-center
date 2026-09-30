"use client";

/**
 * PendingHarnessActions — the changes a Coding harness reply proposed, waiting
 * for the operator (2026-09-30).
 *
 * /api/bridge/chat writes nothing when a reply ends. Each <dashboard-action>
 * marker arrives as an `action_pending` frame (lib/admin/bridge-dashboard-
 * actions.ts) and is drawn here with exactly what it would write. Apply asks
 * once more ("Write this to your workspace?"); Confirm posts the signed
 * proposal to /api/bridge/actions, and the result joins the applied/rejected
 * pills the widget already shows. Dismiss drops it; nothing was written.
 */

import { useState } from "react";

export const HARNESS_ACTIONS_ROUTE = "/api/bridge/actions";

export type PendingHarnessAction = {
  uid: string;
  agent: string;
  type: string;
  payload: Record<string, unknown>;
  exp: number;
  token: string;
};

export type HarnessActionResult = { ok: boolean; type: string; summary?: string; error?: string };

/** PURE. The proposal from one `action_pending` frame, or null when the frame is not one. */
export function pendingFromFrame(parsed: Record<string, unknown>, agent: string, uid: string): PendingHarnessAction | null {
  const { type, payload, exp, token } = parsed;
  if (typeof type !== "string" || !type) return null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (typeof exp !== "number" || typeof token !== "string") return null;
  return { uid, agent, type, payload: payload as Record<string, unknown>, exp, token };
}

/** PURE. What the proposal would write, short enough for a pill. */
export function describePayload(payload: Record<string, unknown>, max = 280): string {
  const text = JSON.stringify(payload);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Post one confirmed proposal. Never throws: a failure is a rejected result that says why. */
export async function postHarnessAction(
  p: PendingHarnessAction,
  fetchImpl: typeof fetch = fetch,
): Promise<HarnessActionResult> {
  let res: Response;
  try {
    res = await fetchImpl(HARNESS_ACTIONS_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: p.agent, type: p.type, payload: p.payload, exp: p.exp, token: p.token }),
    });
  } catch (e) {
    console.error("[harness_action] post failed", e);
    return { ok: false, type: p.type, error: "Couldn't reach the Command Center. Nothing was written." };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch (e) {
    console.error("[harness_action] unreadable answer", res.status, e);
  }
  const b = body as Partial<HarnessActionResult> | null;
  if (b && typeof b.ok === "boolean" && typeof b.type === "string") {
    if (!b.ok && res.status === 410) return { ok: false, type: b.type, error: "This proposal expired. Nothing was written; ask the harness again." };
    return { ok: b.ok, type: b.type, summary: b.summary, error: b.error };
  }
  if (res.status === 401) return { ok: false, type: p.type, error: "You're signed out. Nothing was written." };
  return { ok: false, type: p.type, error: `The Command Center answered ${res.status}. Nothing was written.` };
}

export function PendingHarnessActions({
  items,
  onResolved,
  onDismiss,
}: {
  items: PendingHarnessAction[];
  onResolved: (uid: string, result: HarnessActionResult) => void;
  onDismiss: (uid: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  if (items.length === 0) return null;

  async function confirm(p: PendingHarnessAction) {
    setApplying(p.uid);
    const result = await postHarnessAction(p);
    setApplying(null);
    setConfirming(null);
    onResolved(p.uid, result);
  }

  return (
    <div className="space-y-1.5" aria-label="Changes waiting for you">
      {items.map((p) => {
        const expired = Date.now() > p.exp;
        const busy = applying === p.uid;
        return (
          <div key={p.uid} className="rounded-md border border-hairline bg-bg-panel px-3 py-2 text-xs">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-fg-muted">Proposed change</span>
              <span className="font-mono text-fg">{p.type}</span>
            </div>
            <p className="mt-0.5 text-fg-muted">
              {expired ? "This proposal expired. Nothing was written; ask the harness again." : "Nothing is written until you confirm."}
            </p>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-fg-dim">{describePayload(p.payload)}</pre>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {confirming === p.uid && !expired ? (
                <>
                  <span className="text-fg">Write this to your workspace?</span>
                  <button type="button" className="btn-primary text-xs" disabled={busy} onClick={() => void confirm(p)}>
                    {busy ? "Writing..." : "Confirm"}
                  </button>
                  <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  {!expired && (
                    <button type="button" className="btn-secondary text-xs" onClick={() => setConfirming(p.uid)}>
                      Apply
                    </button>
                  )}
                  <button type="button" className="text-fg-muted hover:text-fg text-xs underline" onClick={() => onDismiss(p.uid)}>
                    Dismiss
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
