import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { BOARD_CHANGED_EVENT, boardChannel } from "@/lib/realtime/board-channel";
import { bumpScopes, nudgePollingActive } from "@/lib/realtime/nudge-store";

/**
 * board-nudge.ts — live "your board changed" push (2026-06-22).
 *
 * When a lead/application/funded-deal is reassigned, shared, or created, we
 * broadcast a lightweight nudge to each affected user's personal Realtime
 * channel (`board:<auth_user_id>`). The client (components/leads/
 * BoardLiveRefresh) subscribes to its own channel and calls router.refresh()
 * on receipt, so the reassigned deal appears/disappears within seconds — no
 * manual reload.
 *
 * Why a broadcast (not Postgres-changes Realtime): the payload carries NO lead
 * data — just a "refresh" signal — so it needs no row-level security on
 * tenant_records and can't leak one rep's deals to another. (Full RLS is a
 * separate planned hardening phase.)
 *
 * Best-effort: a Realtime outage must NEVER fail the write that triggered it,
 * so every path is wrapped and swallowed. The next navigation/refresh still
 * shows correct (server-scoped) state regardless.
 */

/**
 * Broadcast a board-changed nudge to each distinct, non-null user id. Server-
 * side `channel.send()` POSTs to the Realtime broadcast endpoint (no persistent
 * subscription needed). Deduped + lowercased; empties skipped.
 */
export async function nudgeBoards(
  userIds: Array<string | null | undefined>,
): Promise<void> {
  const ids = Array.from(
    new Set(
      userIds
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim().toLowerCase()),
    ),
  );
  if (ids.length === 0) return;
  // Turso mode: no Realtime service, so bump the version tokens the clients
  // poll. Returns rather than falling through — sending to a Supabase channel
  // that no longer exists is a silent no-op that looks like success.
  if (nudgePollingActive()) {
    await bumpScopes(ids.map((id) => `board:${id}`));
    return;
  }
  try {
    const sb = getServiceSupabase();
    await Promise.all(
      ids.map(async (id) => {
        const channel = sb.channel(boardChannel(id), { config: { broadcast: { ack: false } } });
        try {
          await channel.send({ type: "broadcast", event: BOARD_CHANGED_EVENT, payload: {} });
        } finally {
          await sb.removeChannel(channel).catch(() => {});
        }
      }),
    );
  } catch {
    /* best-effort: Realtime down must never fail the triggering write */
  }
}
