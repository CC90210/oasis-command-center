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
  destinationVerdict, normalizeLast10, lineTypeFor,
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
): Promise<{ examined: number; untextable: number; written: number; error: string | null }> {
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
    if (res.error) return { examined: 0, untextable: 0, written: 0, error: res.error.message };
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
    if (res.error) return { examined: 0, untextable: 0, written: 0, error: res.error.message };
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
    if (res.error) return { examined: 0, untextable: 0, written: 0, error: res.error.message };
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
  let written = 0;
  for (const [last10, outcomes] of byNumber) {
    const v = destinationVerdict(outcomes, { lineType: lineTypes.get(last10), last10 });
    if (!v.textable) untextable++;
    const up = await db.from("sms_destination_health").upsert(
      {
        tenant_id: tenantId,
        phone_last10: last10,
        delivered: v.delivered,
        failed: v.failed,
        // libSQL stores booleans as 0/1; write the integer explicitly rather
        // than relying on a driver coercion that differs between planes.
        textable: v.textable ? 1 : 0,
        reason: v.reason.slice(0, 200),
        last_seen_at: outcomes[0]?.at ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,phone_last10" },
    );
    // The adapter RETURNS errors rather than throwing. Ignoring the result here
    // would report a clean refresh over a table that never changed.
    if (up.error) return { examined: byNumber.size, untextable, written, error: up.error.message };
    written++;
  }

  return { examined: byNumber.size, untextable, written, error: null };
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
export async function isTextable(tenantId: string, phone: unknown): Promise<{ textable: boolean; reason: string }> {
  const last10 = normalizeLast10(phone);
  if (!last10) return { textable: false, reason: "no usable phone number" };
  const db: Db = getServiceSupabase();
  const res = await db
    .from("sms_destination_health")
    .select("textable, reason")
    .eq("tenant_id", tenantId)
    .eq("phone_last10", last10)
    .maybeSingle();
  // FAIL CLOSED on a read error. Every other outcome here is a fact; this one
  // is an absence of facts, and sending into it is what a landline blast looks
  // like from the inside.
  if (res.error) return { textable: false, reason: `destination health unreadable: ${res.error.message}` };
  const row = res.data as { textable: unknown; reason: string | null } | null;
  if (!row) return { textable: true, reason: "no history" };
  const textable = row.textable === true || row.textable === 1;
  return { textable, reason: row.reason || (textable ? "known good" : "benched") };
}

export type { DestinationVerdict };
