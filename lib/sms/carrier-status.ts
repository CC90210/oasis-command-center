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
 * object as `api_send_status`. Nothing in this codebase had ever read that
 * field, so a dead channel and a healthy one produced identical rows.
 *
 * `api_send_status` is the ONLY field that decides. A refused message may or
 * may not carry a `msg_sid` — both were observed on 2026-08-07 — so treating a
 * present sid as proof of arrival would reintroduce the same false green.
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
import { AI_WIRE_REP_KEY, AI_WIRE_SERVICE } from "@/lib/drips/ai-wire-core";

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
 * Parse a TextTorrent timestamp into a COMPARABLE instant — usable for ordering
 * messages against each other, and for nothing else.
 *
 * DO NOT COMPARE THIS TO OUR OWN CLOCK. TextTorrent returns
 * "2026-08-08 22:53:17" with no zone marker, and it is NOT UTC: a send we made
 * at 2026-08-09T02:53:18Z came back stamped 22:53:17, exactly four hours behind,
 * i.e. US Eastern. An earlier version of this file asserted "they are UTC,
 * verified" and matched sends to receipts inside a 30-minute window. That
 * combination matched NOTHING: every receipt would have aged out as 'unknown'
 * and the breaker would never have seen a single carrier verdict. The
 * subsystem built to end silent failure would have failed silently.
 *
 * Which is why matching no longer depends on absolute time at all — see
 * matchThreadMessage. Relative ORDER survives any fixed offset; absolute
 * instants do not, and a DST shift would move the offset underneath us anyway.
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
  /** "api" is us. "web"/"app"/"ext" is a human in TextTorrent's own UI. */
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
 * Constrained to platform="api" — the only platform this codebase can produce.
 * A rep working the same thread sends on "web", and a rep who pastes the same
 * template within the window would otherwise be a candidate. Theirs DELIVERS
 * and ours does not (0 failures in 530 web sends against 98 in 113 api sends),
 * so matching theirs would close our receipt as delivered and report a dead
 * route as healthy. That single confusion would undo the whole subsystem.
 *
 * Then matched on body fingerprint, and among equal candidates the EARLIEST is
 * taken.
 *
 * NO ABSOLUTE TIME WINDOW. The obvious design — "the message closest in time to
 * when we sent" — is broken here, because TextTorrent's timestamps are US
 * Eastern while ours are UTC, so every comparison is off by hours and a tight
 * window matches nothing at all. Rather than hardcode an offset that DST will
 * move twice a year, matching relies on the fingerprint plus one-to-one
 * consumption by the caller: receipts are walked oldest-first and each matched
 * message is withdrawn from the pool, so repeat sends of identical copy pair up
 * in order. Relative order is invariant under any fixed offset; absolute
 * instants are not.
 */
export function matchThreadMessage(
  messages: ThreadMessage[],
  target: { bodyHash: string },
): ThreadMessage | null {
  let best: ThreadMessage | null = null;
  let bestAt = Infinity;
  for (const m of messages) {
    if (String(m.direction ?? "").toLowerCase() !== "outbound") continue;
    // ABSENT IS NOT "NOT API".
    //
    // This read `String(m.platform ?? "") !== "api"`, so a message object
    // WITHOUT the field was rejected — and TextTorrent stopped returning
    // `platform` on GET /inbox/{chatId}. Measured 2026-08-20: 47 receipts
    // reached a real carrier verdict between 08-07 and 08-16 and then not one
    // more; every receipt from 08-16 onward sat at 'unknown' while the body
    // hash, the direction and the api_send_status were all present and correct
    // on the message. A filter that excludes 100% of candidates does not look
    // like a filter, it looks like a quiet provider.
    //
    // The filter's PURPOSE was to avoid matching a message a rep typed by hand
    // in the TextTorrent UI. That still holds where the field exists, so it is
    // enforced then — and where it does not, the body hash carries the
    // identification, which is what it was built for. A human would have to
    // retype our rendered copy byte for byte to collide.
    const platform = m.platform == null ? "" : String(m.platform);
    if (platform !== "" && platform !== "api") continue;
    if (hashBody(String(m.message ?? "")) !== target.bodyHash) continue;
    // Earliest first, so oldest-receipt-to-oldest-message pairing holds. An
    // unparseable timestamp sorts last rather than being discarded: a
    // fingerprint match is still our message.
    const at = parseTtTimestamp(m.created_at) ?? Number.MAX_SAFE_INTEGER;
    if (at < bestAt) {
      best = m;
      bestAt = at;
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
  /** Now, for the half-open probe clock. */
  nowMs?: number;
  /** How long after the last verdict to let one probe through. */
  probeAfterMs?: number;
  /** Newest UNRESOLVED receipt, or null. A probe already in flight means we
   *  wait for its answer instead of sending more. */
  newestOpenAt?: number | null;
};

export type BreakerVerdict = {
  /** Do not send. */
  halt: boolean;
  /**
   * Halted, but this one send is a sanctioned probe.
   *
   * WITHOUT THIS THE BREAKER WEDGES SHUT. Once it trips, the executor stops
   * sending, so no new receipts arrive, so the failure ratio cannot fall and
   * the consecutive-failure streak cannot be broken — the breaker holds the
   * channel down long after the route recovers, and only luck (old failures
   * ageing out of the 24h window) releases it. The same shape took down TPS on
   * this repo in August 2026. A breaker must be able to find out that it was
   * wrong.
   */
  halfOpen: boolean;
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
      halfOpen: false,
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
    return { halt: false, halfOpen: false, reason: "no terminal receipts yet", consecutiveFailures: 0, failRatio: 0, sample: 0 };
  }

  /**
   * Is it time to test whether the route came back?
   *
   * Only when nothing is already in flight: an unresolved receipt newer than
   * the last verdict IS the outstanding probe, and firing more while waiting
   * would turn "one careful test" into a slow resumption of full sending into a
   * dead route.
   */
  const nowMs = opts.nowMs ?? Date.now();
  const probeAfterMs = opts.probeAfterMs ?? 30 * 60_000;
  const newestTerminalAt = terminal[0].at;
  const probeInFlight = opts.newestOpenAt != null && opts.newestOpenAt >= newestTerminalAt;
  const dueForProbe = !probeInFlight && nowMs - newestTerminalAt >= probeAfterMs;
  const halted = (r: Omit<BreakerVerdict, "halfOpen">): BreakerVerdict => ({
    ...r,
    halfOpen: dueForProbe,
    reason: dueForProbe ? `${r.reason} (letting one probe through to retest)` : r.reason,
  });

  let consecutive = 0;
  for (const r of terminal) {
    if (r.status !== "failed") break;
    consecutive++;
  }
  const failed = terminal.filter((r) => r.status === "failed").length;
  const ratio = failed / terminal.length;

  if (consecutive >= consecutiveLimit) {
    return halted({
      halt: true,
      reason: `${consecutive} consecutive carrier failures - the send route is not delivering`,
      consecutiveFailures: consecutive,
      failRatio: ratio,
      sample: terminal.length,
    });
  }
  if (terminal.length >= minSample && ratio >= failRatioLimit) {
    return halted({
      halt: true,
      reason: `${Math.round(ratio * 100)}% of the last ${terminal.length} sends failed at the carrier`,
      consecutiveFailures: consecutive,
      failRatio: ratio,
      sample: terminal.length,
    });
  }
  return {
    halt: false,
    halfOpen: false,
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

/**
 * Which TextTorrent ACCOUNT owns the thread a receipt refers to.
 *
 * Derived from the receipt's own `rep_key`, which the executor stamps at send
 * time, so the reconciler reads a thread with the same credentials that created
 * it. Anything else is the main SunBiz account.
 *
 * Deliberately NOT a lookup that defaults by guessing: an unrecognised rep_key
 * resolves to the main account, which is the historical behaviour and is
 * correct for every wire except the AI one. If a third account is ever added,
 * this is the single place that must learn about it — and the parity test in
 * tests/receipt-wire-account.test.ts fails until it does.
 */
export function serviceForRepKey(repKey: string | null | undefined): string {
  return repKey === AI_WIRE_REP_KEY ? AI_WIRE_SERVICE : "texttorrent";
}
