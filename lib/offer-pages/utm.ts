/**
 * lib/offer-pages/utm.ts - first-touch campaign attribution on a lead
 * (HANDOVER section 5.3 / build spec item 5): utm_source, utm_medium,
 * utm_campaign, kw (keyword) and cat (the funnel pillar, p1-p4) from the
 * offer page's query string, stamped once at submit.
 *
 * DELIBERATELY SEPARATE FROM lib/forms/lead-source.ts. That module's
 * LEAD_SOURCE_KEY ("lead_source") is the Text/Dial/Email origination channel
 * and already feeds pipelineBreakdown()'s "Lead sources" card — overloading
 * it with campaign data would corrupt both. These five keys live beside it on
 * the same lead, on their own namespace, and never touch LEAD_SOURCE_KEY.
 *
 * FIRST-TOUCH WINS, same rule as adoptLeadSource: once a lead carries a real
 * value for a key, a retry, a duplicate delivery, or the same visitor
 * returning through a different campaign link can never overwrite it. A key
 * that has never been set CAN be filled in later — an upgrade from "never
 * attributed", not a reassignment.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const UTM_FIELDS =["utm_source", "utm_medium", "utm_campaign", "kw", "cat"] as const;
export type UtmField = (typeof UTM_FIELDS)[number];

/** The jsonb keys on tenant_records.data this module owns. */
export const UTM_KEYS: Record<UtmField, string> = {
  utm_source: "utm_source",
  utm_medium: "utm_medium",
  utm_campaign: "utm_campaign",
  kw: "kw",
  cat: "cat",
};
export const UTM_AT_KEY = "utm_captured_at";

/** The only values `cat` may carry (the four funnel pillars, HANDOVER section 4). */
const CAT_VALUES = new Set(["p1", "p2", "p3", "p4"]);

/** A raw query value this long or longer is a mangled link or an attack, not a campaign tag. */
const MAX_RAW_LENGTH = 128;

export type UtmInput = Partial<Record<UtmField, unknown>>;

/**
 * Normalize one untrusted field value. Total function: never throws. `cat`
 * is checked against its closed vocabulary (lowercased); every other field
 * is free text, trimmed and length-capped — a UTM campaign name is operator-
 * chosen text, not a fixed enum, so it is never validated against a list the
 * way lead_source's channel is.
 */
export function normalizeUtmField(field: UtmField, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_RAW_LENGTH) return null;
  if (field === "cat") {
    const lowered = trimmed.toLowerCase();
    return CAT_VALUES.has(lowered) ? lowered : null;
  }
  return trimmed;
}

/**
 * The patch to merge into a lead's `data`, or null when there is nothing new
 * to write. Each of the five fields is independent: a lead may already carry
 * `cat` from an earlier visit while `kw` is still unset, and this fills in
 * only `kw` without touching `cat`. Mirrors adoptLeadSource's "first touch
 * wins, never a blind overwrite" contract field-by-field.
 */
export function adoptUtm(
  existing: Record<string, unknown> | null | undefined,
  incoming: UtmInput,
  nowIso: string,
): Record<string, string> | null {
  const patch: Record<string, string> = {};
  let changed = false;
  for (const field of UTM_FIELDS) {
    const key = UTM_KEYS[field];
    const already = existing?.[key];
    if (typeof already === "string" && already.trim()) continue; // first touch wins
    const value = normalizeUtmField(field, incoming[field]);
    if (value === null) continue;
    patch[key] = value;
    changed = true;
  }
  if (!changed) return null;
  patch[UTM_AT_KEY] = nowIso;
  return patch;
}

/**
 * Read-modify-write wrapper for the submit route: reads the lead's current
 * `data`, computes the first-touch patch, and writes it back only when there
 * is something new. A no-op (not found, nothing new, or a DB error) is
 * silent and never throws — this is best-effort attribution, not a gate on
 * the submission it rides alongside. A rare race against another write to
 * the same lead can at worst repeat an already-first-touch value (adoptUtm
 * is idempotent per field), never corrupt it.
 */
export async function stampUtmOnLead(
  db: SupabaseClient,
  input: { tenantId: string; leadId: string; utm: UtmInput; now: string },
): Promise<void> {
  try {
    const cur = await db
      .from("tenant_records")
      .select("data")
      .eq("id", input.leadId)
      .eq("tenant_id", input.tenantId)
      .maybeSingle();
    if (cur.error || !cur.data) return;
    const curData = (cur.data as { data?: Record<string, unknown> }).data || {};
    const patch = adoptUtm(curData, input.utm, input.now);
    if (!patch) return;
    await db
      .from("tenant_records")
      .update({ data: { ...curData, ...patch } })
      .eq("id", input.leadId)
      .eq("tenant_id", input.tenantId);
  } catch (err) {
    console.error("[offer-pages.utm] stamp failed", {
      leadId: input.leadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
