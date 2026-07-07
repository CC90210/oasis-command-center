/**
 * Enqueue a merchant background check (court / UCC / lien / prior-default screen).
 *
 * Called when a lead reaches the signed_application stage (forms/submit) and by the
 * BGC tab's "Run" button. Captures a full identity SNAPSHOT from the lead record so
 * the JARVIS bg-check-worker (which polls merchant_background_checks for status=
 * 'pending') has everything it needs to search + confirm matches — without re-reading
 * the lead. SSN/EIN are stored as last4 ONLY, never raw.
 *
 * Idempotent: one open (pending/running) check per lead — a re-submit or a double
 * "Run" tap reuses the existing row instead of stacking duplicates.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

function last4(raw: unknown): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : null;
}
function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "object") return JSON.stringify(v).slice(0, 500);
  const s = String(v).trim();
  return s || null;
}

/** Map a lead record's `data` → the bg-check identity snapshot (SSN/EIN → last4). */
export function snapshotFromLeadData(data: Record<string, unknown>) {
  return {
    business_name: str(data.business_name) ?? str(data.business_legal_name),
    dba: str(data.dba),
    state: str(data.business_state) ?? str(data.state),
    owner_name: str(data.owner_full_name) ?? str(data.owner_name) ?? str(data.contact_name),
    partner_name: str(data.partner_full_name) ?? str(data.partner_name),
    owner_email: str(data.owner_email) ?? str(data.email),
    owner_phone: str(data.owner_cell) ?? str(data.phone),
    owner_home_address: str(data.owner_home_address),
    business_address: str(data.business_address),
    owner_dob: str(data.owner_dob),
    ein_last4: last4(data.tax_id_ein),
    ssn_last4: str(data.owner_ssn_last4) ?? last4(data.owner_ssn),
  };
}

export type EnqueueResult =
  | { ok: true; checkId: string; reused: boolean }
  | { ok: false; reason: string };

export async function enqueueBackgroundCheck(opts: {
  db: SupabaseClient;
  tenantId: string;
  leadId: string;
  applicationId?: string | null;
}): Promise<EnqueueResult> {
  const { db, tenantId, leadId } = opts;

  // 1. Identity snapshot from the lead record.
  const rec = await db
    .from("tenant_records")
    .select("data")
    .eq("id", leadId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (rec.error) return { ok: false, reason: rec.error.message };
  // Fail closed on a missing / wrong-tenant lead (Codex adversarial review round-2,
  // 2026-07-07). Previously a non-existent leadId fell through with data={} and
  // still inserted a merchant_background_checks row — orphan automation work with
  // an empty identity snapshot. Require the tenant-scoped lead to exist first.
  if (!rec.data) return { ok: false, reason: "lead_not_found" };
  const data = (rec.data as { data?: Record<string, unknown> }).data ?? {};

  // 2. Idempotency — reuse an open check if one exists.
  const existing = await db
    .from("merchant_background_checks")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("lead_id", leadId)
    .in("status", ["pending", "running"])
    .limit(1)
    .maybeSingle();
  const existingId = (existing.data as { id?: string } | null)?.id;
  if (existingId) return { ok: true, checkId: existingId, reused: true };

  // 3. Insert pending.
  const ins = await db
    .from("merchant_background_checks")
    .insert({
      tenant_id: tenantId,
      lead_id: leadId,
      application_id: opts.applicationId ?? null,
      ...snapshotFromLeadData(data),
      status: "pending",
    })
    .select("id")
    .single();
  if (ins.error) return { ok: false, reason: ins.error.message };
  return { ok: true, checkId: (ins.data as { id: string }).id, reused: false };
}
