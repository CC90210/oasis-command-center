/**
 * lib/drips/rep-line-core.ts — which of a rep's OWN numbers does this lead get?
 *
 * Pure, no I/O, no "server-only", because this decides which line a real
 * merchant sees and that is exactly the sort of rule that should be testable
 * without a server runtime. The lookups live in rep-sms-identity.ts.
 *
 * TWO RULES, and the second is the one that is easy to get wrong.
 *
 *   1. ROTATE NEW CONVERSATIONS across the rep's pool. Numbers get burned by
 *      volume, so spreading load is the point of holding several.
 *
 *   2. NEVER MOVE A CONVERSATION ALREADY UNDER WAY. TextTorrent binds a chat to
 *      (contact, from_number). Sending the next message from a different line
 *      does not continue the thread — it starts a second one. The merchant sees
 *      a stranger answering a conversation they were already having, and our
 *      reply matching splits across two chats.
 *
 *      A hash over the current pool is NOT stability. It is stable only while
 *      the pool is, and the pool changes roughly weekly as numbers are bought
 *      and burned (Adon, 2026-08-13) — every change re-shuffles the modulo and
 *      silently moves live conversations. Continuity has to come from what we
 *      actually sent before, not from recomputing a guess.
 *
 * An empty pool returns NO LINE. It never falls back to another rep's number:
 * each TextTorrent account is separately registered with the carrier, so
 * borrowing a line breaks the sender identity the merchant knows, puts the
 * reply in an inbox that rep cannot see, and piles every rep's volume onto one
 * number — which is how numbers get burned in the first place.
 */

export type LinePick = {
  /** The number to send from, or null when this rep has none of their own. */
  line: string | null;
  reason: "sticky" | "rotated" | "no_line";
};

/** Stable hash so a given new lead lands on the same line each time the pool is
 *  unchanged. Same algorithm the engine has always used for this. */
function hashPick(pool: string[], leadId: string): string {
  if (pool.length === 1) return pool[0];
  let h = 0;
  for (let i = 0; i < leadId.length; i++) h = (h * 31 + leadId.charCodeAt(i)) >>> 0;
  return pool[h % pool.length];
}

export function chooseLine(args: {
  /** The rep's OWN active numbers. Never another rep's. */
  pool: string[];
  leadId: string;
  /** The line we already texted this lead from, if any. */
  sticky: string | null;
}): LinePick {
  const pool = (args.pool || []).filter(Boolean);
  if (pool.length === 0) return { line: null, reason: "no_line" };

  // Only honour the remembered line if the rep STILL holds it. A burned or
  // released number cannot carry the thread anyway, so continuing to aim at it
  // would just fail every time.
  if (args.sticky && pool.includes(args.sticky)) {
    return { line: args.sticky, reason: "sticky" };
  }
  return { line: hashPick(pool, args.leadId), reason: "rotated" };
}
