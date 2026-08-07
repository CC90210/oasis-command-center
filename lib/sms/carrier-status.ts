/**
 * lib/sms/carrier-status.ts — the pure decision layer for SMS delivery truth.
 *
 * WHY THIS EXISTS. Between 2026-07-27 and 2026-08-07 every SMS sent through
 * TextTorrent's API was rejected by the carrier and NONE of it was visible.
 * 51 consecutive sends, zero delivered. The send path returned HTTP 201 each
 * time, the drip row was written 'sent', and the merchant received nothing.
 *
 * The 201 is the trap. It means TextTorrent accepted the REQUEST. The carrier
 * (SignalHouse) decides delivery afterwards and reports it on the message
 * object as `api_send_status`, with a null `msg_sid` on failure. Nothing in
 * this codebase had ever read that field, so a dead channel and a healthy one
 * produced identical rows.
 *
 * Measured over 643 outbound messages on 2026-08-07:
 *
 *   platform=api  (this codebase)          113 sent,  10 delivered,  98 failed
 *   platform=web/app/ext (a rep typing)    530 sent, 419 delivered,   0 failed
 *
 * Same numbers, same merchants, same days. So the failure is the API route,
 * not the copy, the destination, or the sending number.
 *
 * Pure and free of "server-only" so the rules that decide whether we keep
 * spending credits are directly testable. All I/O lives in delivery-receipts.ts
 * and send-breaker.ts.
 */

import { createHash } from "node:crypto";

/** What the carrier ultimately did with a message. */
export type CarrierStatus = "delivered" | "failed" | "pending" | "unknown";

/**
 * Fold TextTorrent's status vocabulary onto ours.
 *
 * LOAD-BEARING: the API returns BOTH casings for the same outcome — we have
 * observed "Failed" and "failed", "delivered" and "DELIVERED", in the same
 * account on the same day. A naive `=== "failed"` silently misclassifies a
 * large slice of the fleet as healthy, which is the same class of bug this
 * whole module exists to catch. Always compare through here.
 */
export function normalizeCarrierStatus(raw: unknown): CarrierStatus {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (s.startsWith("deliver")) return "delivered";
  if (s.startsWith("fail")) return "failed";
  if (s.startsWith("pend") || s.startsWith("queue") || s.startsWith("sent")) return "pending";
  // "success" appears on INBOUND rows (it describes receipt, not delivery) and
  // must never be read as an outbound delivery confirmation.
  return "unknown";
}

/** A verdict we will not revisit. `pending` and `unknown` stay open. */
export function isTerminal(status: CarrierStatus): boolean {
  return status === "delivered" || status === "failed";
}

/**
 * TextTorrent timestamps arrive as "2026-08-07 13:04:12" with no zone marker.
 * They are UTC — verified by matching send timestamps we generated ourselves
 * against the values the API echoed back. `new Date("2026-08-07 13:04:12")`
 * parses as LOCAL time, which on a machine west of UTC shifts every message
 * into the future and breaks the send/receipt match by hours.
 */
export function parseTtTimestamp(raw: unknown): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export type ThreadMessage = {
  id?: string | number;
  direction?: string;
  platform?: string;
  message?: string;
  api_send_status?: unknown;
  msg_sid?: string | null;
  segment?: number | null;
  credit?: number | null;
  created_at?: string;
};

export type ReceiptFacts = {
  status: CarrierStatus;
  msgSid: string | null;
  segments: number | null;
  credits: number | null;
  messageId: string | null;
};

/**
 * Fingerprint a message body.
 *
 * Receipts store this rather than the copy itself. TextTorrent does not return
 * a message_id on send (verified live 2026-08-07: successful 201 responses carry
 * no id), so the only way to find our message later is to look for it in the
 * thread — and a hash identifies it exactly without duplicating merchant-facing
 * text into a second table.
 */
export function hashBody(body: string): string {
  return createHash("sha256").update(body.trim(), "utf8").digest("hex");
}

/**
 * Find OUR message inside a thread we sent on.
 *
 * Matched on body fingerprint first, because a rep can be typing in the same
 * thread at the same moment and their message must never be mistaken for the
 * drip's — theirs delivers, ours does not, and crediting theirs to us would
 * report a dead channel as healthy. The time window only breaks ties between
 * repeat sends of identical copy, a real case since a retried step re-sends the
 * same rendered text.
 */
export function matchThreadMessage(
  messages: ThreadMessage[],
  target: { bodyHash: string; sentAtMs: number; windowMs?: number },
): ThreadMessage | null {
  const windowMs = target.windowMs ?? 30 * 60_000;
  let best: ThreadMessage | null = null;
  let bestDelta = Infinity;
  for (const m of messages) {
    if (String(m.direction ?? "").toLowerCase() !== "outbound") continue;
    if (hashBody(String(m.message ?? "")) !== target.bodyHash) continue;
    const at = parseTtTimestamp(m.created_at);
    // A body match with an unparseable timestamp is still our message; take it
    // only if nothing better turns up.
    const delta = at === null ? windowMs : Math.abs(at - target.sentAtMs);
    if (delta > windowMs) continue;
    if (delta < bestDelta) {
      best = m;
      bestDelta = delta;
    }
  }
  return best;
}

/** Pull the carrier facts off a matched message. */
export function readReceiptFacts(m: ThreadMessage): ReceiptFacts {
  const sid = typeof m.msg_sid === "string" && m.msg_sid.trim() ? m.msg_sid.trim() : null;
  const status = normalizeCarrierStatus(m.api_send_status);
  return {
    status,
    msgSid: sid,
    segments: typeof m.segment === "number" ? m.segment : null,
    credits: typeof m.credit === "number" ? m.credit : null,
    messageId: m.id == null ? null : String(m.id),
  };
}

export type ReceiptSample = { status: CarrierStatus; at: number };

export type BreakerOptions = {
  /** Halt after this many consecutive failures, newest first. The real outage
   *  ran to 51; 10 is unambiguous and still cheap. */
  consecutiveFailures?: number;
  /** Below this many terminal receipts, the ratio rule is not trusted. */
  minSample?: number;
  /** Halt when the failure ratio over the sample reaches this. */
  failRatio?: number;
};

export type BreakerVerdict = {
  halt: boolean;
  reason: string;
  consecutiveFailures: number;
  failRatio: number;
  sample: number;
};

/**
 * Should we keep sending?
 *
 * FAIL CLOSED on an unreadable history (`null`), per the standing guard rule:
 * a breaker that cannot see is not a breaker. The cost of a false halt is low
 * because a halted step RESCHEDULES rather than failing, so nothing is lost but
 * time; the cost of a false green is ten days of credits spent into a void.
 *
 * An EMPTY history is not the same thing and must not halt. A fresh deploy, or
 * a tenant that has never sent, legitimately has no receipts, and halting there
 * would mean the channel could never start.
 */
export function breakerVerdict(
  recent: ReceiptSample[] | null,
  opts: BreakerOptions = {},
): BreakerVerdict {
  const consecutiveLimit = opts.consecutiveFailures ?? 10;
  const minSample = opts.minSample ?? 20;
  const failRatioLimit = opts.failRatio ?? 0.8;

  if (recent === null) {
    return {
      halt: true,
      reason: "delivery history unreadable - failing closed rather than sending blind",
      consecutiveFailures: 0,
      failRatio: 0,
      sample: 0,
    };
  }

  const terminal = recent
    .filter((r) => isTerminal(r.status))
    .slice()
    .sort((a, b) => b.at - a.at);

  if (terminal.length === 0) {
    return { halt: false, reason: "no terminal receipts yet", consecutiveFailures: 0, failRatio: 0, sample: 0 };
  }

  let consecutive = 0;
  for (const r of terminal) {
    if (r.status !== "failed") break;
    consecutive++;
  }
  const failed = terminal.filter((r) => r.status === "failed").length;
  const ratio = failed / terminal.length;

  if (consecutive >= consecutiveLimit) {
    return {
      halt: true,
      reason: `${consecutive} consecutive carrier failures - the send route is not delivering`,
      consecutiveFailures: consecutive,
      failRatio: ratio,
      sample: terminal.length,
    };
  }
  if (terminal.length >= minSample && ratio >= failRatioLimit) {
    return {
      halt: true,
      reason: `${Math.round(ratio * 100)}% of the last ${terminal.length} sends failed at the carrier`,
      consecutiveFailures: consecutive,
      failRatio: ratio,
      sample: terminal.length,
    };
  }
  return {
    halt: false,
    reason: `${terminal.length - failed}/${terminal.length} delivered`,
    consecutiveFailures: consecutive,
    failRatio: ratio,
    sample: terminal.length,
  };
}

/** Delivery rate over terminal receipts, or null when there is nothing to judge. */
export function deliveryRate(recent: ReceiptSample[]): number | null {
  const terminal = recent.filter((r) => isTerminal(r.status));
  if (terminal.length === 0) return null;
  return terminal.filter((r) => r.status === "delivered").length / terminal.length;
}
