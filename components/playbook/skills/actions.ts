"use client";
/**
 * Skills tab actions (JARVIS plan 3): thin fetch helpers over the founder-only /api/skills routes
 * (same-origin, so the session cookie and the CSRF origin check both apply), and the 6-second
 * Undo queue. A queued edit is held in the browser; nothing is sent until the window closes,
 * a newer edit arrives, or the page is left (keepalive), whichever is first. Sent exactly once.
 */
import type { Op } from "@/lib/skills/contract";
import type { NewChange } from "@/lib/skills/view";

export class ActionError extends Error {}

async function post(url: string, body: unknown, keepalive = false): Promise<Record<string, unknown>> {
  const r = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive, credentials: "same-origin",
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new ActionError(String(j.message ?? j.error ?? `the server answered ${r.status}`));
  return j;
}

export const api = {
  queue: (change: NewChange, keepalive = false) => post("/api/skills/changes", change, keepalive),
  decide: (changeId: string, computerId: string, decision: "reject" | "accept-anyway") =>
    post(`/api/skills/changes/${encodeURIComponent(changeId)}/decision`, { computer_id: computerId, decision }),
  revise: (changeId: string, computerId: string, description: string, ops: Op[]) =>
    post(`/api/skills/changes/${encodeURIComponent(changeId)}/revise`, { computer_id: computerId, description, ops }),
  rebuild: (computerId: string) => post("/api/skills/rebuild", { computer_id: computerId }),
};

export type QueueState = { kind: "pending" | "sending" | "sent" | "undone" | "error"; description: string; message?: string };
type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };

export function createPendingQueue(o: {
  send: (change: NewChange, keepalive: boolean) => Promise<void>;
  onState: (s: QueueState) => void;
  delayMs?: number;
  timers?: Timers;
}) {
  const timers: Timers = o.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  type Pending = { description: string; change: NewChange; handle: unknown };
  let current: Pending | null = null;

  const fire = async (keepalive: boolean) => {
    if (!current) return;
    const { description, change, handle } = current;
    current = null;
    timers.clear(handle);
    o.onState({ kind: "sending", description });
    let staleMessage: string | undefined;
    try {
      await o.send(change, keepalive);
      o.onState({ kind: "sent", description });
    } catch (e) {
      staleMessage = (e as Error).message;
      o.onState({ kind: "error", description, message: staleMessage });
    }
    // Ruling C4: if a newer edit arrived while this one was in flight, `current` now points at
    // it. Re-announce ITS Undo toast (never leave "sent"/"error" for the OLD edit as the last
    // word on the newer one), carrying the stale failure text as `message` so the newer toast can
    // still say "Nothing changed" about the edit that just failed to send.
    // (The explicit cast widens `current` back to its declared union: TS narrows it to `null`
    // across this `await` because nothing inside THIS function's visible text reassigns it, even
    // though `add()` genuinely can while this send is in flight.)
    const pending = current as Pending | null;
    if (pending) {
      o.onState({ kind: "pending", description: pending.description, ...(staleMessage ? { message: staleMessage } : {}) });
    }
  };

  return {
    add(description: string, change: NewChange) {
      if (current) void fire(false);
      current = { description, change, handle: timers.set(() => void fire(false), o.delayMs ?? 6000) };
      o.onState({ kind: "pending", description });
    },
    undo(): boolean {
      if (!current) return false;
      timers.clear(current.handle);
      const { description } = current;
      current = null;
      o.onState({ kind: "undone", description });
      return true;
    },
    flush() {
      void fire(true);
    },
  };
}
