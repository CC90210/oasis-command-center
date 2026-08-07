"use client";

/**
 * BoardLiveRefresh — live "your board changed" subscriber (2026-06-22).
 *
 * Subscribes to the current user's personal Realtime channel (board:<id>) and
 * calls router.refresh() (debounced) when a board-changed broadcast arrives —
 * so a reassignment / collaborator change shows up in this rep's pipeline within
 * seconds, no manual reload. The server re-renders their already-scoped board.
 *
 * The broadcast carries NO lead data (just a refresh signal), so this needs no
 * table RLS and can't leak. Degrades silently to no-live-updates when the public
 * Supabase env isn't configured (the next navigation still shows correct state).
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import { BOARD_CHANGED_EVENT, boardChannel } from "@/lib/realtime/board-channel";
import { useNudgePoll } from "@/lib/realtime/use-nudge-poll";

// Module-level singleton so multiple mounts (dashboard ↔ pipeline navigation)
// reuse one WebSocket instead of opening duplicates.
let cached: SupabaseClient | null = null;
function client(): SupabaseClient | null {
  if (cached) return cached;
  try {
    cached = getBrowserSupabase();
    return cached;
  } catch {
    return null; // env not configured → no live updates, not a crash
  }
}

export function BoardLiveRefresh({ userId }: { userId: string | null }) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Turso mode: Supabase Realtime is gone, so the same nudge arrives by polling
  // a version token. Returns true only when the server says polling is active,
  // so the two transports never both run.
  const polling = useNudgePoll("board", () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => router.refresh(), 600);
  });

  useEffect(() => {
    if (!userId || polling) return;
    const sb = client();
    if (!sb) return;
    const channel = sb
      .channel(boardChannel(userId))
      .on("broadcast", { event: BOARD_CHANGED_EVENT }, () => {
        // Debounce: a burst of changes (e.g. bulk reassign) → one refresh.
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => router.refresh(), 600);
      })
      .subscribe();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      sb.removeChannel(channel);
    };
  }, [userId, router, polling]);

  return null;
}
