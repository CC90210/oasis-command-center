"use client";

/**
 * ConversationsLiveRefresh — live "this tenant's inbox changed" subscriber
 * (Phase 3, plan §7). Cloned from components/leads/BoardLiveRefresh.tsx.
 *
 * Subscribes to the tenant's Realtime channel (conversations:<tenantId>)
 * and calls router.refresh() (debounced 600ms) when a conversation_changed
 * broadcast arrives — so a teammate's send, an inbound webhook, or a
 * workflow-ops PATCH (assign/status/snooze/read) shows up within seconds in
 * every open inbox, no manual reload.
 *
 * The broadcast carries NO message content (just a refresh signal), so this
 * needs no table RLS and can't leak. Degrades silently to no-live-updates
 * when the public Supabase env isn't configured (the next navigation still
 * shows correct state) — same fail-silent contract as BoardLiveRefresh.
 *
 * Mounted unconditionally on the conversations page (not gated behind
 * CONVERSATIONS_SPINE) — a fresh message refreshing the read-time-grouped
 * list is useful with or without the spine; only the filter/status/unread/
 * assign UI is spine-gated.
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import { CONVERSATION_CHANGED_EVENT, conversationsChannel } from "@/lib/realtime/conversations-channel";

// Module-level singleton so multiple mounts reuse one WebSocket instead of
// opening duplicates (mirrors BoardLiveRefresh).
let cached: SupabaseClient | null = null;
function client(): SupabaseClient | null {
  if (cached) return cached;
  try {
    cached = getBrowserSupabase();
    return cached;
  } catch {
    return null; // env not configured -> no live updates, not a crash
  }
}

export function ConversationsLiveRefresh({ tenantId }: { tenantId: string | null }) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!tenantId) return;
    const sb = client();
    if (!sb) return;
    const channel = sb
      .channel(conversationsChannel(tenantId))
      .on("broadcast", { event: CONVERSATION_CHANGED_EVENT }, () => {
        // Debounce: a burst of changes (e.g. a blast or bulk workflow-ops
        // update) -> one refresh.
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => router.refresh(), 600);
      })
      .subscribe();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      sb.removeChannel(channel);
    };
  }, [tenantId, router]);

  return null;
}
