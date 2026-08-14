/**
 * lib/drips/brand-store.ts — the I/O half of brand routing.
 *
 * The pure rules live in brand-routing.ts. This module reads and stamps them
 * onto the lead, and is the ONLY place that writes `data.sending_brand`.
 *
 * STORAGE (no migration required — the same jsonb the stage lives in):
 *   data.sending_brand       "sunbiz" | "bluerise"
 *   data.brand_assigned_at   ISO timestamp
 *   data.brand_switch_count  number, capped at 1 by the routing rule
 *   data.brand_source_class  "warm" | "cold" | "unknown", recorded for audit
 *
 * WHY THE BRAND IS STORED RATHER THAN DERIVED AT SEND TIME: derivation would
 * re-run on every dispatch tick, so a lead could flip brand mid-sequence the
 * moment its source list was reclassified or the launch date moved. Stamping it
 * once makes the merchant's experience stable and makes the audit trail able to
 * answer "which company did this person hear from" months later.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveBrandKey, type BrandKey } from "@/lib/email/brands";
import {
  classifyLeadSource,
  resolveInitialBrand,
  shouldSwitchBrand,
} from "./brand-routing";

type Db = ReturnType<typeof getServiceSupabase>;

/** When Bluerise started sending. Everything created before this knows SunBiz. */
export function blueriseLaunchAtMs(): number {
  const raw = (process.env.BLUERISE_LAUNCH_AT || "").trim();
  const parsed = raw ? Date.parse(raw) : NaN;
  // A bad or absent value must not read as "the epoch", which would make every
  // lead look post-launch and push the whole back catalogue onto Bluerise.
  // Default far in the FUTURE-safe direction: 2026-08-05, the build date.
  return Number.isFinite(parsed) ? parsed : Date.parse("2026-08-05T00:00:00Z");
}

/** Days of silence before a lead is eligible for the single handoff. */
export function brandSwitchSilenceDays(): number {
  const n = parseInt((process.env.DRIP_BRAND_SWITCH_DAYS || "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 21;
}

/**
 * Batch-resolve the brand for a dispatch run. NEVER writes.
 *
 * Fails SAFE to sunbiz: a read error must not silently move mail onto the newer
 * domain, and sunbiz is the pre-existing behaviour for every lead currently in
 * the CRM.
 */
export async function loadBrandsForLeads(
  db: Db,
  tenantId: string,
  leadIds: string[],
): Promise<Map<string, BrandKey>> {
  const out = new Map<string, BrandKey>();
  if (leadIds.length === 0) return out;
  try {
    const r = await db
      .from("tenant_records")
      .select("id, data")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "lead")
      .in("id", leadIds);
    if (r.error) {
      for (const id of leadIds) out.set(id, "sunbiz");
      return out;
    }
    for (const row of (r.data || []) as Array<{ id: string; data: Record<string, unknown> }>) {
      out.set(row.id, resolveBrandKey(row.data?.sending_brand));
    }
  } catch {
    /* fall through to the safe default below */
  }
  for (const id of leadIds) if (!out.has(id)) out.set(id, "sunbiz");
  return out;
}

/** Merge brand fields into a lead's jsonb. Read-modify-write on `data` because
 *  that is how every other lead field is stored. */
async function writeBrand(
  db: Db,
  tenantId: string,
  leadId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const cur = await db
    .from("tenant_records")
    .select("data")
    .eq("tenant_id", tenantId)
    .eq("id", leadId)
    .maybeSingle();
  if (cur.error || !cur.data) return false;
  const data = { ...((cur.data.data as Record<string, unknown>) || {}), ...patch };
  const w = await db
    .from("tenant_records")
    .update({ data, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", leadId);
  return !w.error;
}

/**
 * Stamp the initial brand if the lead has none. Returns the brand in force.
 *
 * Called from the enroller, inside the branch that already only runs when
 * DRIPS_LIVE=1 and the stage is allowlisted, so the dry-run contract holds: a
 * reporting-only run never writes a brand.
 *
 * `rowCreatedAt` is the tenant_records ROW timestamp. Measured 2026-08-05: zero
 * of 1,194 leads carry a created_at inside `data`, so reading `data.created_at`
 * would make every lead look undated.
 */
export async function ensureInitialBrand(
  db: Db,
  tenantId: string,
  leadId: string,
  data: Record<string, unknown>,
  rowCreatedAt: string | null | undefined,
): Promise<BrandKey> {
  const existing = data.sending_brand;
  if (existing === "sunbiz" || existing === "bluerise") return existing;

  const createdMs = rowCreatedAt ? Date.parse(rowCreatedAt) : NaN;
  const sourceClass = classifyLeadSource(data.source);
  const brand = resolveInitialBrand({
    createdAtMs: Number.isFinite(createdMs) ? createdMs : undefined,
    source: data.source,
    // The stage is what routes follow-up leads to Bluerise. Without it every
    // pre-2026-08-05 lead resolves to SunBiz and Bluerise stays empty.
    stage: data.stage,
    blueriseLaunchAtMs: blueriseLaunchAtMs(),
  });

  // Surface unclassified sources rather than letting them sit silent. An
  // unrecognised source resolves to SunBiz, which is the safe direction, but it
  // also means genuinely cold volume can quietly land on the established domain
  // — the thing the split exists to prevent. This log is how that gap gets
  // noticed instead of discovered in a complaint rate.
  if (sourceClass === "unknown" && data.source) {
    console.warn(
      `[brand-store] unclassified lead source ${JSON.stringify(String(data.source).slice(0, 60))} ` +
        `— defaulted to sunbiz. Add it to DRIP_COLD_LEAD_SOURCES or DRIP_WARM_LEAD_SOURCES.`,
    );
  }

  await writeBrand(db, tenantId, leadId, {
    sending_brand: brand,
    brand_assigned_at: new Date().toISOString(),
    brand_switch_count: Number(data.brand_switch_count || 0),
    brand_source_class: sourceClass,
  });
  return brand;
}

/**
 * Apply the single handoff when a lead has gone quiet. Returns the brand now in
 * force, which is unchanged when no switch is due.
 *
 * `lastInboundAtMs` is the merchant's most recent INBOUND message. A responding
 * merchant is warm and must never be handed to a different company mid
 * conversation.
 */
export async function applyBrandSwitchIfDue(
  db: Db,
  tenantId: string,
  lead: {
    id: string;
    data: Record<string, unknown>;
  },
  args: { lastInboundAtMs: number | null; suppressed: boolean; optedOut: boolean; nowMs: number },
): Promise<{ brand: BrandKey; switched: boolean; reason?: string }> {
  const current = resolveBrandKey(lead.data.sending_brand);
  const assignedRaw = lead.data.brand_assigned_at;
  const assignedMs =
    typeof assignedRaw === "string" ? Date.parse(assignedRaw) : NaN;
  // No assignment timestamp means we cannot prove how long they have been
  // silent, so we do not switch. Stamping happens at enrolment; a lead without
  // one has not been through that path yet.
  if (!Number.isFinite(assignedMs)) {
    return { brand: current, switched: false, reason: "no_brand_assigned_at" };
  }

  const decision = shouldSwitchBrand({
    currentBrand: current,
    brandAssignedAtMs: assignedMs,
    lastInboundAtMs: args.lastInboundAtMs,
    switchCount: Number(lead.data.brand_switch_count || 0),
    suppressed: args.suppressed,
    optedOut: args.optedOut,
    nowMs: args.nowMs,
    silenceDays: brandSwitchSilenceDays(),
  });

  if (!decision.switch) return { brand: current, switched: false, reason: decision.reason };

  const ok = await writeBrand(db, tenantId, lead.id, {
    sending_brand: decision.to,
    brand_assigned_at: new Date(args.nowMs).toISOString(),
    brand_switch_count: Number(lead.data.brand_switch_count || 0) + 1,
  });
  // A failed write must not report a switch that did not happen: the caller
  // would send as the new brand while the row still says the old one, and the
  // audit trail would disagree with what the merchant received.
  if (!ok) return { brand: current, switched: false, reason: "write_failed" };
  return { brand: decision.to, switched: true };
}
