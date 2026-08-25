/**
 * lib/integrations/kixie-attribution.ts — attach raw Kixie webhook traffic
 * to the right lead + rep by PHONE NUMBER.
 *
 * Why: customField1 (the Bravo lead UUID) is only echoed back on calls/SMS
 * the dashboard itself initiated. The team lives in the Kixie app — without
 * number matching, their day-to-day dialing lands in /feed and dies there
 * (no timeline row, no metrics). This module closes that gap.
 *
 * Matching reuses findExistingLead (the same dedupe matcher the intake forms
 * + quick-add use) so "which lead owns this phone number" has exactly one
 * definition in the codebase. Leads store phones in mixed formats (10-digit
 * normalized at quick-add, whatever the merchant typed on older form leads),
 * so we probe the common NANP variants.
 */

import "server-only";

import { getServiceSupabase } from "@/lib/supabase-server";

/** Candidate storage formats for a NANP number: 10-digit, 1+10, +1+10. */
export function phoneCandidates(raw: string | null | undefined): string[] {
  const digits = String(raw || "").replace(/\D+/g, "");
  if (!digits) return [];
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length !== 10) {
    // Non-NANP / short code — probe the raw digit string only.
    return [...new Set([digits, `+${digits}`])];
  }
  return [...new Set([ten, `1${ten}`, `+1${ten}`])];
}

/**
 * Find the lead that owns this phone number (tenant-scoped, most-recent
 * match wins — findExistingLead's ordering). Returns null on no match.
 */
export async function findLeadByPhone(
  tenantId: string,
  rawPhone: string,
): Promise<{ id: string; data: Record<string, unknown> } | null> {
  const db = getServiceSupabase();
  for (const candidate of phoneCandidates(rawPhone)) {
    const result = await db
      .from("tenant_records")
      .select("id,data,created_at")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "lead")
      .filter("data->>phone", "eq", candidate)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (result.error) {
      throw new Error(`kixie_phone_attribution_failed:${result.error.message}`);
    }
    if (result.data) {
      const row = result.data as { id: string; data?: Record<string, unknown> | null };
      return { id: row.id, data: row.data || {} };
    }
  }
  return null;
}

export type ResolvedRep = {
  userId: string;
  email: string;
  displayName: string;
};

/**
 * Resolve the acting rep from the webhook's agent email (Kixie login) to a
 * dashboard user. Case-insensitive equality (Matt's Kixie login is
 * `Submissions@...` with a capital S). Returns null when no profile matches.
 */
export async function resolveRepByEmail(
  tenantId: string,
  email: string | null | undefined,
): Promise<ResolvedRep | null> {
  const e = String(email || "").trim();
  if (!e) return null;
  const db = getServiceSupabase();
  // ilike with no wildcards = case-insensitive equality. Escape the LIKE
  // metacharacters so an email can't broaden the match.
  const safe = e.replace(/[%_\\]/g, "\\$&");
  const r = await db
    .from("user_profiles")
    .select("auth_user_id, email, display_name, full_name")
    .eq("tenant_id", tenantId)
    .ilike("email", safe)
    .maybeSingle();
  if (r.error || !r.data) return null;
  const row = r.data as {
    auth_user_id: string;
    email: string;
    display_name: string | null;
    full_name: string | null;
  };
  return {
    userId: row.auth_user_id,
    email: row.email,
    displayName: row.display_name || row.full_name || e.split("@")[0],
  };
}

/**
 * The merchant-side number of an event: the caller on inbound, the dialed
 * number on outbound. (The other side is the rep's Kixie line.)
 */
export function merchantNumberFor(
  evt: {
    fromnumber?: string;
    tonumber?: string;
    number?: string;
    customernumber?: string;
  },
  isInbound: boolean,
): string {
  const n = isInbound
    ? evt.fromnumber || evt.customernumber || evt.number
    : evt.tonumber || evt.number || evt.customernumber;
  return String(n || "").trim();
}
