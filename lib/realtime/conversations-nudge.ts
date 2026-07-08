import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { CONVERSATION_CHANGED_EVENT, conversationsChannel } from "@/lib/realtime/conversations-channel";

/**
 * conversations-nudge.ts — live "this tenant's inbox changed" push
 * (Phase 3, plan §7). Cloned from lib/realtime/board-nudge.ts.
 *
 * Call after any write that changes what the Conversations inbox should
 * show: a new lead_interactions row (send or inbound webhook) or a
 * conversation_threads workflow-ops PATCH (assign/status/snooze/read).
 * The client (components/conversations/ConversationsLiveRefresh) subscribes
 * to the tenant's channel and calls router.refresh() on receipt, so a
 * second browser sees the change within ~1s — no manual reload.
 *
 * Why a broadcast (not Postgres-changes Realtime): the payload carries NO
 * message content — just a "refresh" signal — so it needs no row-level
 * security on lead_interactions/conversation_threads and can't leak one
 * tenant's messages to another.
 *
 * Best-effort: a Realtime outage must NEVER fail the write that triggered
 * it, so every path is wrapped and swallowed. The next navigation/refresh
 * still shows correct (server-scoped) state regardless. Callers should
 * still `await` this (not fire-and-forget) before returning their response —
 * Vercel serverless functions don't guarantee background work continues once
 * the response has been sent, so an un-awaited broadcast can simply never
 * fire. The added latency is one Realtime round-trip (~tens of ms).
 */
export async function nudgeConversations(tenantId: string | null | undefined): Promise<void> {
  const id = typeof tenantId === "string" ? tenantId.trim() : "";
  if (!id) return;
  try {
    const sb = getServiceSupabase();
    const channel = sb.channel(conversationsChannel(id), { config: { broadcast: { ack: false } } });
    try {
      await channel.send({ type: "broadcast", event: CONVERSATION_CHANGED_EVENT, payload: {} });
    } finally {
      await sb.removeChannel(channel).catch(() => {});
    }
  } catch {
    /* best-effort: Realtime down must never fail the triggering write */
  }
}
