/**
 * lenders/shop-out-outcome.ts — one place that decides whether a shop-out
 * dispatch actually put mail in front of a lender, and writes that verdict
 * somewhere durable.
 *
 * WHY THIS EXISTS
 * ---------------
 * Shopping out was physically dead from 2026-08-06 to 2026-08-11 and nobody
 * could tell. The dispatch is a chain — route → /api/bridge/exec-tool → VPS
 * bridge → send_gateway → SMTP — and when a link broke, three things happened
 * at once:
 *
 *   1. triggerPhysicalSend() returned {status:"error"}, and the route returned
 *      HTTP 200 {ok:true} anyway.
 *   2. The UI had no branch for that status, so it rendered a GREEN
 *      "Queued 6 lender threads. Sending now" over a total failure.
 *   3. Nothing wrote the reason to the database, so application_lender_threads
 *      showed status='pending' with last_error NULL — indistinguishable from a
 *      send that was still in flight.
 *
 * On 2026-08-11 six lender packages sat in exactly that state: queued, never
 * sent, no error, green screen. Five days of outage produced zero recorded
 * errors, which is why each round of fixes looked like it worked.
 *
 * The rule this module enforces: a dispatch failure is written to the row
 * BEFORE the response is built. The database — not the HTTP response, and
 * certainly not the toast — is the record of what happened, because the
 * database is the only one of the three that a health check can read at 3am.
 */

import { getServiceSupabase } from "@/lib/supabase-server";

export type PhysicalSendResult = {
  status: "sent" | "partial" | "error" | "skipped";
  sent_count?: number;
  failed_count?: number;
  total_pending?: number;
  message?: string;
};

/**
 * Did this dispatch fail to deliver anything?
 *
 * "error" is a failure. "partial" is NOT — some lenders got the package, and
 * the per-thread rows carry their own status, so treating it as a whole-batch
 * failure would hide the sends that did land. "skipped" is not a failure
 * either: it means nothing was queued to send (every lender blocked), which
 * the `blocked` count already reports honestly.
 */
export function physicalSendFailed(ps: PhysicalSendResult | null | undefined): boolean {
  return ps?.status === "error";
}

/**
 * A short, operator-readable reason for a dispatch failure.
 *
 * Prefixed with `dispatch_failed:` so it is greppable and so the stuck-thread
 * health check can distinguish "the send path broke" from a lender-specific
 * error like "missing lender contact email" written at queue time.
 */
export function dispatchFailureReason(ps: PhysicalSendResult): string {
  const detail = ps.message?.trim() || "no reason reported by the dispatch chain";
  return `dispatch_failed: ${detail}`.slice(0, 500);
}

/**
 * Stamp a dispatch failure onto the threads that are still sitting at pending.
 *
 * Scoped by tenant AND application AND status='pending' so it can never touch
 * a thread that already sent, and never crosses a tenant boundary. Threads
 * stay at 'pending' rather than moving to 'error': the operator's Retry and
 * Retry-all actions both select pending rows, and moving them out of that
 * state would strand the deal in a status nothing re-drives.
 *
 * Best-effort by design — this runs on a path that has ALREADY failed, and
 * throwing here would replace a useful error message with a stack trace. But
 * it returns what it wrote, and the caller logs a miss, so a silent no-op
 * cannot masquerade as a successful record.
 */
export async function recordDispatchFailure(input: {
  tenant_id: string;
  application_id: string;
  reason: string;
}): Promise<{ ok: boolean; stamped: number; error?: string }> {
  try {
    const db = getServiceSupabase();
    const res = await db
      .from("application_lender_threads")
      .update({
        last_error: input.reason,
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", input.tenant_id)
      .eq("application_id", input.application_id)
      .eq("status", "pending")
      .select("id");

    if (res.error) {
      return { ok: false, stamped: 0, error: res.error.message };
    }
    return { ok: true, stamped: Array.isArray(res.data) ? res.data.length : 0 };
  } catch (e) {
    return {
      ok: false,
      stamped: 0,
      error: e instanceof Error ? e.message : "unknown error stamping dispatch failure",
    };
  }
}
