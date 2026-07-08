/**
 * conversations-channel.ts — shared Realtime channel constants for the
 * Conversations inbox live-refresh nudge (Phase 3, plan §7). Cloned from
 * lib/realtime/board-channel.ts. Kept separate from conversations-nudge.ts
 * (which is `server-only`) so the CLIENT subscriber
 * (components/conversations/ConversationsLiveRefresh) can import these
 * without pulling the server DB layer into the browser bundle.
 *
 * Per-TENANT (not per-user, unlike the board channel) — the inbox is a
 * shared team surface, so any team member's send/receive should refresh
 * every other team member's open inbox.
 */

export const CONVERSATION_CHANGED_EVENT = "conversation_changed";

/** Channel name for a tenant's conversations feed. */
export function conversationsChannel(tenantId: string): string {
  return `conversations:${tenantId.trim().toLowerCase()}`;
}
