/**
 * lib/sms/delivery-receipts.ts — opening and closing the record of what the
 * carrier actually did with each SMS.
 *
 * A receipt is opened the moment a send returns 201 (which proves only that
 * TextTorrent accepted the request) and closed later by the reconciler, once
 * the carrier has reported on the message. Until it closes, the honest state is
 * 'unknown' — never 'sent'.
 *
 * See carrier-status.ts for why any of this exists. All rules live there and
 * are pure; this file is the I/O.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTextTorrentCredentials, getThreadRaw } from "@/lib/integrations/texttorrent";
import {
  hashBody,
  matchThreadMessage,
  readReceiptFacts,
  isTerminal,
  type CarrierStatus,
} from "./carrier-status";

type Db = ReturnType<typeof getServiceSupabase>;

export type OpenReceiptArgs = {
  tenantId: string;
  dripRunId?: string | null;
  leadId?: string | null;
  chatId: string;
  repKey?: string | null;
  actAsEmail?: string | null;
  fromNumber?: string | null;
  toPhone: string;
  body: string;
  sentAt?: Date;
};

/**
 * Record that we sent something and do not yet know whether it arrived.
 *
 * Never throws. A receipt is observability, and failing a merchant's drip step
 * because bookkeeping failed would be a worse outcome than the blind spot it
 * closes. A receipt that fails to open shows up as missing coverage in the
 * health check rather than as a lost send.
 */
export async function openReceipt(db: Db, args: OpenReceiptArgs): Promise<string | null> {
  const digits = String(args.toPhone || "").replace(/\D/g, "");
  const sentAt = args.sentAt ?? new Date();
  try {
    const r = await db
      .from("sms_delivery_receipts")
      .upsert(
        {
          tenant_id: args.tenantId,
          drip_run_id: args.dripRunId ?? null,
          lead_id: args.leadId ?? null,
          chat_id: String(args.chatId),
          rep_key: args.repKey ?? null,
          act_as_email: args.actAsEmail ?? null,
          from_number: args.fromNumber ?? null,
          to_last4: digits.slice(-4) || null,
          body_hash: hashBody(args.body),
          sent_at: sentAt.toISOString(),
          carrier_status: "unknown",
        },
        { onConflict: "tenant_id,chat_id,body_hash,sent_at" },
      )
      .select("id")
      .maybeSingle();
    if (r.error) {
      console.error("[sms-receipts] could not open receipt", r.error.message);
      return null;
    }
    return r.data?.id ?? null;
  } catch (err) {
    console.error("[sms-receipts] could not open receipt", err);
    return null;
  }
}

export type ReconcileResult = {
  examined: number;
  resolved: number;
  delivered: number;
  failed: number;
  stillOpen: number;
  abandoned: number;
  errors: string[];
};

/**
 * Give up after this many attempts THAT ACTUALLY READ THE THREAD. A fetch that
 * failed never asked the carrier anything, so it must not count: an hour of 429s
 * from the shared 60/min limiter would otherwise burn every receipt's budget and
 * resolve the lot as 'unknown', which the breaker ignores — quietly deleting the
 * evidence of the outage this exists to catch.
 */
const MAX_CHECK_ATTEMPTS = 8;

/**
 * Absolute backstop so the queue cannot clog. Without it, a permanently
 * unreadable thread is retried forever and, because the queue is oldest-first
 * and capped per run, a few hundred of them would starve every newer receipt.
 * Closed as 'unknown' — never counted as delivered.
 */
const MAX_RECEIPT_AGE_MS = 3 * 24 * 3_600_000;
/** Do not bother the API about a send younger than this — the carrier has not
 *  had time to report and every early look burns a request for nothing. */
const MIN_AGE_MS = 90_000;

/**
 * Close every receipt the carrier has ruled on.
 *
 * Groups by chat so one thread fetch resolves every message we sent on it, which
 * matters because a lead in a multi-step sequence accumulates several.
 */
export async function reconcileReceipts(
  tenantId: string,
  opts: { limit?: number; nowMs?: number } = {},
): Promise<ReconcileResult> {
  const db = getServiceSupabase();
  const limit = opts.limit ?? 200;
  const nowMs = opts.nowMs ?? Date.now();
  const out: ReconcileResult = {
    examined: 0, resolved: 0, delivered: 0, failed: 0, stillOpen: 0, abandoned: 0, errors: [],
  };

  // Retire anything past the absolute age first, so a wedge of unreadable
  // threads cannot starve the queue head. 'unknown', never 'delivered'.
  const tooOld = new Date(nowMs - MAX_RECEIPT_AGE_MS).toISOString();
  const aged = await db
    .from("sms_delivery_receipts")
    .update({ resolved_at: new Date(nowMs).toISOString(), last_checked_at: new Date(nowMs).toISOString() })
    .eq("tenant_id", tenantId)
    .is("resolved_at", null)
    .lt("sent_at", tooOld)
    .select("id");
  if (aged.error) out.errors.push(`retire aged: ${aged.error.message}`.slice(0, 160));
  else out.abandoned += aged.data?.length ?? 0;

  const open = await db
    .from("sms_delivery_receipts")
    .select("id, chat_id, body_hash, sent_at, act_as_email, check_attempts")
    .eq("tenant_id", tenantId)
    .is("resolved_at", null)
    .lt("sent_at", new Date(nowMs - MIN_AGE_MS).toISOString())
    .order("sent_at", { ascending: true })
    .limit(limit);

  if (open.error) {
    out.errors.push(`read open receipts: ${open.error.message}`);
    return out;
  }
  const rows = open.data || [];
  out.examined = rows.length;
  if (rows.length === 0) return out;

  // One fetch per (chat, identity). The act-as identity matters: a thread is
  // only visible to the sub-account that owns it.
  const byThread = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.act_as_email ?? ""}|${r.chat_id}`;
    const list = byThread.get(k) ?? [];
    list.push(r);
    byThread.set(k, list);
  }

  for (const [k, group] of byThread) {
    const [actAsEmail, chatId] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
    let messages: Awaited<ReturnType<typeof getThreadRaw>>;
    try {
      const creds = await getTextTorrentCredentials(tenantId, {
        service: "texttorrent",
        actAsEmail: actAsEmail || null,
      });
      messages = await getThreadRaw(creds, chatId);
    } catch (err) {
      // The thread could not be read, so the carrier was never asked. Touch the
      // timestamp but do NOT spend an attempt: a spell of 429s from the shared
      // rate limiter would otherwise exhaust every receipt's budget and retire
      // the batch as 'unknown', erasing exactly the evidence we are here to
      // collect. The absolute age cutoff above is what bounds these instead.
      out.errors.push(`chat ${chatId}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 160));
      out.stillOpen += group.length;
      const touch = await db
        .from("sms_delivery_receipts")
        .update({ last_checked_at: new Date(nowMs).toISOString() })
        .eq("tenant_id", tenantId)
        .in("id", group.map((r) => r.id));
      if (touch.error) out.errors.push(`touch: ${touch.error.message}`.slice(0, 160));
      continue;
    }

    for (const r of group) {
      const sentAtMs = Date.parse(r.sent_at);
      const hit = matchThreadMessage(messages, { bodyHash: r.body_hash, sentAtMs });
      if (!hit) {
        // The thread WAS read and our message is not in it. That is a real
        // answer, so this attempt counts.
        await bumpAttempt(db, tenantId, r.id, r.check_attempts, out);
        continue;
      }
      const facts = readReceiptFacts(hit);
      const terminal = isTerminal(facts.status);
      const patch: Record<string, unknown> = {
        carrier_status: facts.status,
        msg_sid: facts.msgSid,
        segments: facts.segments,
        credits: facts.credits,
        check_attempts: (r.check_attempts ?? 0) + 1,
        last_checked_at: new Date(nowMs).toISOString(),
      };
      if (terminal) patch.resolved_at = new Date(nowMs).toISOString();

      // tenant_id on every write: the service role bypasses RLS, so the filter
      // is the only thing keeping a mis-sourced id inside its own tenant.
      const upd = await db
        .from("sms_delivery_receipts")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", r.id);
      if (upd.error) {
        out.errors.push(`update ${r.id}: ${upd.error.message}`.slice(0, 160));
        continue;
      }
      if (terminal) {
        out.resolved++;
        if (facts.status === "delivered") out.delivered++;
        else out.failed++;
      } else {
        out.stillOpen++;
      }
    }
  }
  return out;
}

/**
 * Record a successful look that produced no verdict.
 *
 * Called ONLY when the thread was actually read and our message was not in it.
 * A failed fetch never reaches here — see the catch above — because spending an
 * attempt on a question we never asked is how a rate-limit spell would quietly
 * retire the whole queue.
 *
 * A receipt chased MAX_CHECK_ATTEMPTS times is closed as 'unknown' with a
 * resolved_at so it leaves the queue. It is deliberately NOT counted as
 * delivered or failed anywhere downstream: an unanswered question is not a pass.
 */
async function bumpAttempt(
  db: Db,
  tenantId: string,
  id: string,
  attempts: number | null,
  out: ReconcileResult,
): Promise<void> {
  const next = (attempts ?? 0) + 1;
  const patch: Record<string, unknown> = { check_attempts: next, last_checked_at: new Date().toISOString() };
  if (next >= MAX_CHECK_ATTEMPTS) {
    patch.resolved_at = new Date().toISOString();
    out.abandoned++;
  } else {
    out.stillOpen++;
  }
  const r = await db
    .from("sms_delivery_receipts")
    .update(patch)
    .eq("tenant_id", tenantId)
    .eq("id", id);
  if (r.error) out.errors.push(`bump ${id}: ${r.error.message}`.slice(0, 160));
}

/**
 * Every tenant with receipts still waiting on a verdict.
 *
 * The executor opens receipts under each drip row's own tenant_id, so a
 * reconciler hardcoded to one tenant would leave every other tenant's receipts
 * open forever — and an all-open history reads as "nothing terminal yet", which
 * the breaker correctly permits. The result is that the protection silently
 * applies to exactly one tenant on a multi-tenant platform.
 *
 * Returns null on a failed read so the caller can tell "no work" from "could
 * not look".
 */
export async function tenantsWithOpenReceipts(): Promise<string[] | null> {
  const db = getServiceSupabase();
  try {
    // No lookback window. An earlier version looked back 7 days, which was
    // strictly worse than useless: retirement happens at 3 days, so any receipt
    // that aged past the window could never be DISCOVERED and therefore could
    // never be retired either. After a cron outage longer than the window, a
    // non-SunBiz tenant's queue would have been stale forever. Retirement is
    // what bounds this set, so the window bought nothing.
    const r = await db
      .from("sms_delivery_receipts")
      .select("tenant_id")
      .is("resolved_at", null)
      .limit(5000);
    if (r.error) return null;
    return [...new Set((r.data || []).map((x) => String(x.tenant_id)))];
  } catch {
    return null;
  }
}

export type RecentReceipt = { status: CarrierStatus; at: number };

/**
 * The recent terminal window the breaker and health check judge against.
 *
 * Returns null — NOT an empty array — when the read fails. The distinction is
 * load-bearing: the breaker halts on null (it cannot see) and permits on empty
 * (there is genuinely nothing yet).
 */
export async function readRecentReceipts(
  tenantId: string,
  opts: { sinceMs?: number; limit?: number } = {},
): Promise<RecentReceipt[] | null> {
  const db = getServiceSupabase();
  const since = new Date(opts.sinceMs ?? Date.now() - 24 * 3_600_000).toISOString();
  try {
    const r = await db
      .from("sms_delivery_receipts")
      .select("carrier_status, sent_at")
      .eq("tenant_id", tenantId)
      .in("carrier_status", ["delivered", "failed"])
      .gte("sent_at", since)
      .order("sent_at", { ascending: false })
      .limit(opts.limit ?? 100);
    if (r.error) return null;
    return (r.data || []).map((x) => ({
      status: x.carrier_status as CarrierStatus,
      at: Date.parse(x.sent_at),
    }));
  } catch {
    return null;
  }
}

/**
 * When did we last send something we are still waiting on?
 *
 * This is how the breaker knows a half-open probe is already in flight. Without
 * it, every row in a dispatch batch would read "due for a probe" and the one
 * careful test would become a full resumption of sending into a dead route.
 *
 * null means nothing outstanding. A read failure also returns null, which is
 * the safe direction here: it makes the breaker believe no probe is in flight,
 * and the probe path is gated on a 30-minute clock anyway.
 */
export async function newestOpenReceiptAt(tenantId: string): Promise<number | null> {
  const db = getServiceSupabase();
  try {
    const r = await db
      .from("sms_delivery_receipts")
      .select("sent_at")
      .eq("tenant_id", tenantId)
      .is("resolved_at", null)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (r.error || !r.data?.sent_at) return null;
    return Date.parse(r.data.sent_at);
  } catch {
    return null;
  }
}
