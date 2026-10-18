/**
 * lib/meet/tabs.ts - one tab per browser in an Oasis Meet room. No React; the room's controller uses it
 * (lib/meet/room-client.ts join and leave).
 *
 * Two tabs of one browser share the room's cookie, so they are one participant: each one's reconnect would cut the
 * other's media, both would record the room, and a Leave from either would end the other's place. So a tab holds the
 * room while it is in the call, and a second tab is told the meeting is open in another tab. "Join here instead" asks
 * that tab to hand the room over; it ends as `moved`, telling the room nothing, and this tab carries on as the same
 * participant.
 *
 * The browser's own tools do it: a Web Lock per room, which the browser also lets go of when a tab closes or crashes,
 * and a BroadcastChannel to ask for it. A browser without Web Locks holds every tab in the room, as before.
 */

/** What the room's controller needs: tests pass their own, or the real one on Node's Web Locks. */
export type MeetTabs = {
  /** Hold the room for this tab, or null when another tab of this browser holds it. */
  hold(): Promise<{ release(): void } | null>;
  /** Ask the tab that holds the room to hand it over, then hold it; null when it never lets go. */
  take(): Promise<{ release(): void } | null>;
  /** Listen for another tab asking for the room; returns what stops listening. */
  onAskedFor(listener: () => void): () => void;
};

/**
 * A request this old or more is stale: the tab it reached was frozen meanwhile (a phone's background tab), and the
 * one that asked has given up. It is ignored, so a call is never ended for a hand-over nobody is waiting for.
 */
export const TAB_ASK_FRESH_MS = 3_000;

/**
 * How long "Join here instead" waits for the other tab to hand the room over: past TAB_ASK_FRESH_MS plus a join's
 * own deadline (lib/meet/room-client.ts REQUEST_TIMEOUT_MS). A tab asked while its join is on its way hands over once
 * that join has answered, and this side must still be waiting then, or neither tab would be in the call.
 */
export const TAB_HANDOVER_MS = 25_000;

const HAND_OVER = "hand-over";
type HandOverRequest = { type: typeof HAND_OVER; at: number };

export function browserTabs(code: string, handoverMs: number = TAB_HANDOVER_MS): MeetTabs {
  const name = `oasis-meet:${code}`;
  const NOT_GUARDED = { release() {} };
  const lockManager = () => (typeof navigator !== "undefined" ? navigator.locks : undefined);
  const request = (options: LockOptions) =>
    new Promise<{ release(): void } | null>((resolve) => {
      const locks = lockManager();
      if (!locks) return resolve(NOT_GUARDED);
      locks
        .request(name, options, (lock) => {
          if (!lock) return resolve(null);
          // The lock is held for as long as this promise is pending: until release().
          return new Promise<void>((done) => resolve({ release: () => done() }));
        })
        // Given up waiting (take's deadline), or locks refused outright: a wait gets nothing; a hold goes unguarded.
        .catch(() => resolve(options.signal ? null : NOT_GUARDED));
    });
  return {
    hold: () => request({ ifAvailable: true }),
    async take() {
      if (!lockManager()) return NOT_GUARDED;
      // Without a channel to ask on, the wait still counts: the other tab may be closed meanwhile.
      if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel(name);
        // Both tabs are one browser, on one clock: the time it was asked says when the request has gone stale.
        const ask: HandOverRequest = { type: HAND_OVER, at: Date.now() };
        channel.postMessage(ask);
        channel.close();
      }
      const giveUp = new AbortController();
      const timer = setTimeout(() => giveUp.abort(), handoverMs);
      try {
        return await request({ signal: giveUp.signal });
      } finally {
        clearTimeout(timer);
      }
    },
    onAskedFor(listener) {
      if (typeof BroadcastChannel === "undefined") return () => undefined;
      const channel = new BroadcastChannel(name);
      channel.onmessage = (event: MessageEvent) => {
        const ask = event.data as Partial<HandOverRequest> | null;
        if (ask?.type === HAND_OVER && typeof ask.at === "number" && Date.now() - ask.at <= TAB_ASK_FRESH_MS) listener();
      };
      return () => channel.close();
    },
  };
}
