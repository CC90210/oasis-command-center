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
  wirelessCandidates, chooseTextableNumber,
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
  // Numbers that belong to no lead's `phone` field but are still send targets:
  // the mobiles the lookup found. They need a health row or they can never be
  // chosen.
  const extraNumbers = new Set<string>();
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const res = await db
      .from("tenant_records")
      .select("id, data")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "lead")
      // Unordered .range() has no defined row order, so page 2 may repeat or
      // skip rows. Skipping is the dangerous direction here: a missed lead is a
      // number this walk never classifies, which is exactly the landline this
      // file exists to avoid texting. id is tenant_records' primary key.
      .order("id", { ascending: true })
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

      // CLASSIFY THE LOOKED-UP NUMBERS TOO, not just the one on the lead.
      //
      // The lookup finds a mobile and writes it to `phone_lookup_candidates`
      // without touching `data.phone` (which stays the merchant's own record).
      // Walking only `data.phone` meant those mobiles never got a health row —
      // and with no row there is no verdict, so under verified-only the sender
      // had nothing to send to and the lead stayed held. Measured 2026-08-21:
      // lookups succeeded, found Wireless numbers, and changed nothing.
      //
      // A candidate is tagged wireless by the lookup itself, so it seeds as
      // wireless — but never over an explicit landline for the same number, and
      // never over evidence, which destinationVerdict still resolves below.
      for (const w of wirelessCandidates(d.phone_lookup_candidates)) {
        const known = lineTypes.get(w);
        if (!known || known === "unknown") lineTypes.set(w, "wireless");
        if (!extraNumbers.has(w)) extraNumbers.add(w);
      }
    }
    if (page.length < PAGE) break;
  }

  const byNumber = new Map<string, DestinationOutcome[]>();
  // Seed every known number so a landline with no send history still gets a
  // row. Without this, the benching only ever applies to numbers we already
  // burned a message on.
  for (const last10 of leadToPhone.values()) if (!byNumber.has(last10)) byNumber.set(last10, []);
  // ...and the looked-up mobiles, which no lead carries in `phone`.
  for (const w of extraNumbers) if (!byNumber.has(w)) byNumber.set(w, []);
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
      // Same invariant. sms_destination_health's PK is
      // (tenant_id, phone_last10) and tenant_id is already pinned above, so
      // phone_last10 is unique across this result set — a valid order key.
      // A skipped page here drops a number from the untextable set, which
      // silently re-enables sending to it.
      .order("phone_last10", { ascending: true })
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
    const benched = row.textable === false || row.textable === 0;

    // A BENCH ALWAYS WINS, EVEN OVER VERIFICATION (Codex P1, 2026-08-20).
    //
    // The two flags answer different questions and can genuinely disagree: a
    // number the lookup tagged Wireless is verified=1, and if it then racks up
    // carrier failures it becomes textable=0. The first cut returned early on
    // `verified` and never looked at `textable`, so this stricter mode was a
    // way AROUND the existing failure bench — it would have kept sending to a
    // number we had already proven does not work.
    //
    // Checked before the verified branch so the ordering cannot be reversed by
    // a later edit without deleting this.
    if (benched) {
      return { textable: false, reason: row.reason || "benched", hold: "unreachable" };
    }
    if (!verified) {
      return {
        textable: false,
        reason: row.reason || "awaiting phone verification",
        hold: "awaiting_verification",
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

/**
 * WHICH of a lead's numbers should we actually text?
 *
 * THE GAP THIS CLOSES (measured 2026-08-21). The phone lookup writes what it
 * finds into `phone_lookup_candidates` and deliberately does NOT overwrite the
 * lead's `phone` — that field is what the merchant gave us and clobbering it
 * would destroy their own record of themselves.
 *
 * Correct, and it left the chain one link short. A lead now looks like this:
 *
 *   phone:      6619789433                    <- the office landline
 *   candidates: +12094831972 (Wireless), ...  <- the mobile we just found
 *
 * Everything downstream keys on `phone`, so the lookup succeeded, found a
 * reachable mobile, and the lead stayed held anyway. The night's lookups would
 * have produced nothing usable.
 *
 * So the send path asks for the best number rather than assuming the stored
 * one. Preference order lives in chooseTextableNumber: a number we have
 * actually delivered to beats a looked-up mobile beats anything else, and
 * anything benched is excluded outright.
 *
 * Returns the number in the form it is stored in, ready to send, plus where it
 * came from so the caller can record which one it used.
 */
export type SendNumber =
  | { phone: string; source: "provided" | "looked_up"; hold: null }
  /**
   * There is no number at all. PERMANENT — nothing will change on its own, so
   * the caller should skip the step and let the sequence's email steps run.
   */
  | { phone: null; source: null; hold: "no_phone" }
  /**
   * There ARE numbers, but none is verified yet. TEMPORARY — a lookup may still
   * land. The caller must HOLD, never skip.
   *
   * This distinction is the whole bug of 2026-08-22/23. Returning a bare null
   * for both cases meant the caller read "awaiting a lookup" as "no phone" and
   * called skipStep, which advances the row permanently past its SMS step. 190
   * leads were burned that way over two days and sends sat at 0 — the exact
   * defect Codex flagged for the isTextable gate, re-introduced one line
   * earlier in the code that resolves the number.
   */
  | { phone: null; source: null; hold: "awaiting_verification" };

export async function resolveSendNumber(
  tenantId: string,
  data: Record<string, unknown>,
): Promise<SendNumber> {
  const stored = typeof data.phone === "string" ? data.phone.trim() : "";
  const wireless = wirelessCandidates(data.phone_lookup_candidates);

  // Keep the sendable form for each candidate: chooseTextableNumber reasons in
  // last-10 (the only form that compares reliably), but the provider needs the
  // real number back.
  const forms = new Map<string, string>();
  const candidates: Array<{ phone: unknown; source: "provided" | "looked_up" }> = [];
  if (stored) {
    const k = normalizeLast10(stored);
    if (k) { forms.set(k, stored); candidates.push({ phone: stored, source: "provided" }); }
  }
  for (const w of wireless) {
    if (forms.has(w)) continue;   // the stored number IS the wireless one
    forms.set(w, w);
    candidates.push({ phone: w, source: "looked_up" });
  }
  if (candidates.length === 0) return { phone: null, source: null, hold: "no_phone" };

  // Verdicts for just these numbers.
  const db: Db = getServiceSupabase();
  const keys = [...forms.keys()];
  const res = await db
    .from("sms_destination_health")
    .select("phone_last10, delivered, failed, textable, verified, reason")
    .eq("tenant_id", tenantId)
    .in("phone_last10", keys);
  // FAIL CLOSED, but as a HOLD. The lead HAS numbers; we simply cannot vet them
  // right now. Skipping would burn the row permanently over a transient
  // database problem, which is the more expensive mistake.
  if (res.error) return { phone: null, source: null, hold: "awaiting_verification" };

  const verdicts = new Map<string, DestinationVerdict>();
  for (const r of (res.data || []) as Array<{
    phone_last10: string; delivered: number; failed: number; textable: unknown; verified: unknown; reason: string | null;
  }>) {
    verdicts.set(String(r.phone_last10), {
      last10: String(r.phone_last10),
      textable: r.textable === true || r.textable === 1,
      reason: r.reason || "",
      delivered: Number(r.delivered) || 0,
      failed: Number(r.failed) || 0,
    });
  }

  // Under verified-only, a candidate with no verdict row at all is not a
  // send-worthy option — the whole point of the mode. chooseTextableNumber only
  // excludes explicitly-untextable numbers, so the stricter filter is applied
  // here rather than by loosening that shared helper.
  const pool = verifiedOnly()
    ? candidates.filter((c) => {
        const k = normalizeLast10(c.phone);
        const row = (res.data || []).find((x) => String((x as { phone_last10: string }).phone_last10) === k) as
          | { verified: unknown } | undefined;
        return !!row && (row.verified === true || row.verified === 1);
      })
    : candidates;
  if (pool.length === 0) return { phone: null, source: null, hold: "awaiting_verification" };

  const pick = chooseTextableNumber(pool, verdicts);
  // Every candidate was excluded as untextable. That is a property of the
  // NUMBERS, not a missing lookup, so it is permanent.
  if (!pick) return { phone: null, source: null, hold: "no_phone" };
  const phone = forms.get(pick.last10);
  return phone ? { phone, source: pick.source, hold: null } : { phone: null, source: null, hold: "no_phone" };
}

export type { DestinationVerdict };
