import "server-only";
/**
 * Nudge storage — the Turso replacement for Supabase Realtime broadcast.
 *
 * The live-refresh feature never needed a message bus. The payload is empty;
 * the signal is only ever "something in this scope changed, call
 * router.refresh()". So instead of a persistent socket, a scope gets a version
 * token that the sender bumps and the client polls.
 *
 * Trade-off, stated plainly: a broadcast arrives in ~100ms, a poll arrives
 * within the poll interval. For "the deal you were just reassigned appears in
 * your board", seconds are fine — and it removes a whole hosted service from
 * the cancellation path.
 *
 * Best-effort in exactly the same way the broadcast was: a failure here must
 * NEVER fail the write that triggered it. A missed nudge costs a stale view
 * until the next navigation; a thrown error costs the user their write.
 */
import { getServiceSupabase } from "@/lib/supabase-server";

export function nudgePollingActive(): boolean {
  return process.env.EMPIRE_DATA_BACKEND === "turso_cloud";
}

/** Bump the version token for each scope. Never throws. */
export async function bumpScopes(scopes: string[]): Promise<void> {
  const unique = Array.from(new Set(scopes.filter((s) => s && s.trim()))).map((s) =>
    s.trim().toLowerCase(),
  );
  if (!unique.length) return;
  try {
    const db = getServiceSupabase();
    const now = new Date().toISOString();
    await Promise.all(
      unique.map((scope) =>
        db
          .from("_realtime_nudges")
          .upsert({ scope, bumped_at: now }, { onConflict: "scope" })
          .then(() => undefined),
      ),
    );
  } catch {
    /* best-effort — a nudge failure must never fail the triggering write */
  }
}

/**
 * Current token for a scope. Returns "" when the scope has never been bumped,
 * which the client treats as "nothing yet" rather than as a change — otherwise
 * every first poll would trigger a spurious refresh.
 */
export async function readScope(scope: string): Promise<string> {
  try {
    const db = getServiceSupabase();
    const { data } = await db
      .from("_realtime_nudges")
      .select("bumped_at")
      .eq("scope", scope.trim().toLowerCase())
      .maybeSingle();
    return (data as { bumped_at?: string } | null)?.bumped_at ?? "";
  } catch {
    return "";
  }
}
