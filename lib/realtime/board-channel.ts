/**
 * board-channel.ts — shared Realtime channel constants for the per-user board
 * live-refresh nudge. Kept separate from board-nudge.ts (which is `server-only`)
 * so the CLIENT subscriber (components/leads/BoardLiveRefresh) can import these
 * without pulling the server DB layer into the browser bundle.
 */

export const BOARD_CHANGED_EVENT = "board_changed";

/** Channel name for a user's personal board feed (lowercased auth_user_id). */
export function boardChannel(userId: string): string {
  return `board:${userId.trim().toLowerCase()}`;
}
