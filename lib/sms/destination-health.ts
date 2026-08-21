/**
 * lib/sms/destination-health.ts — the I/O behind "can this phone receive a
 * text".
 *
 * Rules are pure and live in destination-health-core.ts. This walks the carrier
 * receipts, joins each one back to the lead's actual phone number (receipts
 * keep only `to_last4`, which collides), and materialises a verdict per number.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import {
  destinationVerdict, normalizeLast10, lineTypeFor, isVerifiedMobile,
  type DestinationOutcome, type DestinationVerdict, type LineType,
} from "./destination-health-core";

type Db = ReturnType<typeof getServiceSupabase>;

const PAGE = 500;
const MAX_ROWS = 20_000;

/**
 * Recompute every destination's verdict from the carrier receipts.
 *
 * Returns counts rather than writing silently, so a caller can tell "nothing
 * needed changing" from "this did not run".
 */
export async function refreshDestinationHealth(
  tenantId: string,
  opts: { sinceMs?: number } = {},
): Promise<{ examined: number; untextable: number; verified: number; written: number; error: string | null }> {
  const db: Db = getServiceSupabase();
  const since = new Date(opts.sinceMs ?? Date.now() - 90 * 24 * 3_600_000).toISOString();

  // Receipts that reached a REAL verdict. 'unknown' is not evidence and must
  // not accumulate toward benching a number: 15 receipts sat at 'unknown' for
  // four days while the reconciler was broken, and counting those would have
  // benched every merchant that outage touched.
  const receipts: Array<{ drip_run_id: string | null; carrier_status: string | null; sent_at: string }> = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const res = await db
      .from("sms_delivery_receipts")
      .select("drip_run_id, carrier_status, sent_at")
      .eq("tenant_id", tenantId)
      .eq("purpose", "drip")
      .in("carrier_status", ["delivered", "failed", "undelivered"])
      .gte("sent_at", since)
      .order("sent_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (res.error) return { examined: 0, untextable: 0, verified: 0, written: 0, error: res.error.message };
    const page = (res.data || []) as typeof receipts;
    receipts.push(...page);
    if (page.length < PAGE) break;
  }
  // receipt -> drip_run -> lead. Both hops are needed because the receipt does
  // not carry a usable destination.
  const runIds = [...new Set(receipts.map((r) => r.drip_run_id).filter(Boolean) as string[])];
  const runToLead = new Map<string, string>();
  for (let i = 0; i < runIds.length; i += PAGE) {
    const res = await db.from("drip_runs").select("id, lead_id").eq("tenant_id", tenantId).in("id", runIds.slice(i, i + PAGE));
    if (res.error) return { examined: 0, untextable: 0, verified: 0, written: 0, error: res.error.message };
    for (const r of (res.data || []) as Array<{ id: string; lead_id: string | null }>) {
      if (r.lead_id) runToLead.set(String(r.id), String(r.lead_id));
    }
  }

  // EVERY lead with a phone, not just the ones already texted.
  //
  // The line type comes from the phone lookup, so a landline can be benched
  // BEFORE a message is ever spent on it. Restricting this walk to leads with
  // receipts would only ever catch desk phones after we had already texted
  // them, which is the cost this whole change exists to avoid.
  const leadToPhone = new Map<string, string>();
  const lineTypes = new Map<string, LineType>();
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const res = await db
      .from("tenant_records")
      .select("id, data")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "lead")
      .range(from, from + PAGE - 1);
    if (res.error) return { examined: 0, untextable: 0, verified: 0, written: 0, error: res.error.message };
    const page = (res.data || []) as Array<{ id: string; data: Record<string, unknown> | null }>;
    for (const r of page) {
      const d = r.data || {};
      const last10 = normalizeLast10(d.phone);
      if (!last10) continue;
      leadToPhone.set(String(r.id), last10);
      const t = lineTypeFor(d.phone, d.phone_lookup_candidates);
      // A number can appear on more than one lead. 'wireless' wins over
      // 'unknown', and an explicit 'landline' is only overwritten by a real
      // delivery later, never by another lead's missing label.
      const prev = lineTypes.get(last10);
      if (!prev || prev === "unknown") lineTypes.set(last10, t);
    }
    if (page.length < PAGE) break;
  }

  const byNumber = new Map<string, DestinationOutcome[]>();
  // Seed every known number so a landline with no send history still gets a
  // row. Without this, the benching only ever applies to numbers we already
  // burned a message on.
  for (const last10 of leadToPhone.values()) if (!byNumber.has(last10)) byNumber.set(last10, []);
  for (const rec of receipts) {
    const leadId = rec.drip_run_id ? runToLead.get(String(rec.drip_run_id)) : undefined;
    const last10 = leadId ? leadToPhone.get(leadId) : undefined;
    if (!last10) continue;
    const status = String(rec.carrier_status ?? "").toLowerCase();
    const list = byNumber.get(last10) ?? [];
    list.push({
      last10,
      status: status === "delivered" ? "delivered" : status === "failed" || status === "undelivered" ? "failed" : "unknown",
      at: rec.sent_at,
    });
    byNumber.set(last10, list);
  }

  let untextable = 0;
  let verifiedCount = 0;
  let written = 0;
  for (const [last10, outcomes] of byNumber) {
    const lineType = lineTypes.get(last10);
    const v = destinationVerdict(outcomes, { lineType, last10 });
    // The stricter flag the sender uses while the lookup backlog drains. See
    // isVerifiedMobile: `textable` fails open on an unknown number by design,
    // which is right in general and wrong for a cohort that is 100%
    // application-provided and has delivered 0 of 53.
    const ver = isVerifiedMobile(outcomes, lineType);
    if (!v.textable) untextable++;
    if (ver.verified) verifiedCount++;
    const up = await db.from("sms_destination_health").upsert(
      {
        tenant_id: tenantId,
        phone_last10: last10,
        delivered: v.delivered,
        failed: v.failed,
        // libSQL stores booleans as 0/1; write the integer explicitly rather
        // than relying on a driver coercion that differs between planes.
        textable: v.textable ? 1 : 0,
        verified: ver.verified ? 1 : 0,
        reason: v.reason.slice(0, 200),
        last_seen_at: outcomes[0]?.at ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,phone_last10" },
    );
    // The adapter RETURNS errors rather than throwing. Ignoring the result here
    // would report a clean refresh over a table that never changed.
    if (up.error) return { examined: byNumber.size, untextable, verified: verifiedCount, written, error: up.error.message };
    written++;
  }

  return { examined: byNumber.size, untextable, verified: verifiedCount, written, error: null };
}

/**
 * Numbers this tenant must not text, as last-10 digits.
 *
 * Returns null on a read failure. Callers MUST treat null as "I do not know"
 * and refuse to send, rather than as an empty set: an unreadable table would
 * otherwise re-open the exact landline blasting this exists to stop.
 */
export async function untextableNumbers(tenantId: string): Promise<Set<string> | null> {
  const db: Db = getServiceSupabase();
  const out = new Set<string>();
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const res = await db
      .from("sms_destination_health")
      .select("phone_last10")
      .eq("tenant_id", tenantId)
      .eq("textable", 0)
      .range(from, from + PAGE - 1);
    if (res.error) return null;
    const page = (res.data || []) as Array<{ phone_last10: string }>;
    for (const r of page) out.add(String(r.phone_last10));
    if (page.length < PAGE) break;
  }
  return out;
}

/** One number's verdict, for a per-lead check at dispatch. */
export type Reachability = {
  textable: boolean;
  reason: string;
  /**
   * WHY it is held, when it is.
   *
   *   "unreachable"           a landline, or a number that keeps failing.
   *                           Permanent until something about the number changes.
   *   "awaiting_verification" verified-only mode and no lookup on file yet.
   *                           TEMPORARY: it clears when the queue drains.
   *
   * Kept apart because they need different reactions, and because the guard
   * audit counts these by reason: a temporary wait reported as a permanent
   * bench would show the landline gate firing hundreds of times and hide the
   * occasions it really fires.
   */
  hold: "unreachable" | "awaiting_verification" | null;
};

export async function isTextable(tenantId: string, phone: unknown): Promise<Reachability> {
  const last10 = normalizeLast10(phone);
  if (!last10) return { textable: false, reason: "no usable phone number", hold: "unreachable" };
  const db: Db = getServiceSupabase();
  const res = await db
    .from("sms_destination_health")
    .select("textable, verified, reason")
    .eq("tenant_id", tenantId)
    .eq("phone_last10", last10)
    .maybeSingle();
  // FAIL CLOSED on a read error. Every other outcome here is a fact; this one
  // is an absence of facts, and sending into it is what a landline blast looks
  // like from the inside.
  if (res.error) {
    return { textable: false, reason: `destination health unreadable: ${res.error.message}`, hold: "unreachable" };
  }
  const row = res.data as { textable: unknown; verified: unknown; reason: string | null } | null;

  // VERIFIED-FIRST MODE. While the lookup backlog drains, send only where there
  // is positive evidence the number reaches a handset.
  //
  // Env-gated so it can be turned off without a deploy, and deliberately NOT a
  // change to the underlying rule: destinationVerdict still fails open on an
  // unknown number, because that is how a new number gets learned about. This
  // is a stricter question asked on top, not a reversal.
  //
  // Without it, the 347-lead follow-up cohort — 100% application-provided
  // numbers, 0 delivered of 53 — all read as textable, and 40/day into that
  // benches our lines within the hour.
  if (verifiedOnly()) {
    // An unknown number has no row at all. Under this mode that is a HOLD, not
    // a send: it is exactly the state the whole cohort is in.
    if (!row) {
      return { textable: false, reason: "awaiting phone verification (no lookup on file)", hold: "awaiting_verification" };
    }
    const verified = row.verified === true || row.verified === 1;
    if (!verified) {
      // A KNOWN landline stays permanent even in this mode. Only a genuinely
      // not-yet-looked-up number is a temporary wait.
      const knownBad = row.textable === false || row.textable === 0;
      return {
        textable: false,
        reason: row.reason || "awaiting phone verification",
        hold: knownBad ? "unreachable" : "awaiting_verification",
      };
    }
    return { textable: true, reason: row.reason || "verified mobile", hold: null };
  }

  if (!row) return { textable: true, reason: "no history", hold: null };
  const textable = row.textable === true || row.textable === 1;
  return {
    textable,
    reason: row.reason || (textable ? "known good" : "benched"),
    hold: textable ? null : "unreachable",
  };
}

/**
 * Send only to numbers proven to receive texts.
 *
 * Read at CALL time so it can be switched without a deploy — a value captured
 * at module load would keep the old behaviour on a warm serverless instance
 * long after the operator changed it.
 */
export function verifiedOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.DRIPS_SMS_VERIFIED_ONLY || "").trim() === "1";
}

export type { DestinationVerdict };
