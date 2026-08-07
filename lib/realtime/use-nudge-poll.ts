"use client";
/**
 * Poll for a scope's version token and fire when it changes.
 *
 * The Turso-mode replacement for Supabase Realtime broadcast. Returns false
 * when polling is not active (Supabase Realtime still the transport), so the
 * caller keeps its existing channel subscription and the two never run at once.
 *
 * Deliberate behaviours:
 *  - The FIRST response only records the baseline. Treating it as a change
 *    would make every mount trigger a refresh.
 *  - Polling stops while the tab is hidden and resumes (with an immediate
 *    check) on focus. A background tab refreshing a server component every few
 *    seconds is pure cost to both the user and the database.
 *  - Failures are silent and non-escalating: this is a convenience nudge, and
 *    the next navigation shows correct state regardless. It must never surface
 *    an error to someone who is just looking at their board.
 */
import { useEffect, useRef, useState } from "react";

const DEFAULT_INTERVAL_MS = 8000;

export function useNudgePoll(
    kind: "board" | "conversations",
    onChange: () => void,
    intervalMs: number = DEFAULT_INTERVAL_MS,
): boolean {
    const [polling, setPolling] = useState(false);
    const lastToken = useRef<string | null>(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        async function tick() {
            if (cancelled) return;
            try {
                const r = await fetch(`/api/realtime/nudge?kind=${kind}`, {
                    cache: "no-store",
                });
                if (r.ok) {
                    const j = (await r.json()) as { polling?: boolean; token?: string };
                    if (cancelled) return;
                    setPolling(Boolean(j.polling));
                    if (!j.polling) return; // Supabase Realtime is handling it
                    const token = j.token ?? "";
                    if (lastToken.current === null) {
                        lastToken.current = token; // baseline, not a change
                    } else if (token && token !== lastToken.current) {
                        lastToken.current = token;
                        onChangeRef.current();
                    }
                }
            } catch {
                /* convenience nudge — never surface an error for this */
            }
            if (!cancelled && document.visibilityState === "visible") {
                timer = setTimeout(tick, intervalMs);
            }
        }

        function onVisibility() {
            if (document.visibilityState === "visible") {
                if (timer) clearTimeout(timer);
                tick(); // catch up immediately on focus
            } else if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        }

        tick();
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [kind, intervalMs]);

    return polling;
}
