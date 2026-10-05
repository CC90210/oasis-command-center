/**
 * Diagnostics and queue payloads for SMS rows waiting on phone verification.
 *
 * This module never sends a text and never updates a lead. Its only write
 * consumer inserts a bounded `phone_lookup_jobs` row, which the residential
 * lookup worker may later drain. Keeping the scan and payload construction
 * here makes the health check and the explicit repair endpoint agree on what
 * an orphan is.
 */

import type { getServiceSupabase } from "@/lib/supabase-server";

type Db = ReturnType<typeof getServiceSupabase>;

const HOLD_SCAN_PAGE = 500;
const HOLD_SCAN_LIMIT = 5_000;
const JOB_QUERY_BATCH = 200;

export const SMS_VERIFICATION_HOLD_PATTERN = "sms_awaiting_verification:%";

export type OrphanScan =
  | {
      ok: true;
      heldLeadCount: number;
      orphanLeadIds: string[];
    }
  | {
      ok: false;
      error: "hold_scan_failed" | "hold_scan_limit_exceeded" | "job_scan_failed";
    };

/**
 * Find distinct active drip leads that say they are waiting for verification
 * but have no lookup job of any status.
 *
 * `phone_lookup_stalled` cannot see this state: an empty job queue looks green
 * even while hundreds of drip rows wait for a job that was never created.
 * Every database read is tenant-bound because both tables are shared.
 */
export async function findOrphanedVerificationLeadIds(
  db: Db,
  tenantId: string,
): Promise<OrphanScan> {
  const heldLeadIds = new Set<string>();
  let offset = 0;

  while (offset <= HOLD_SCAN_LIMIT) {
    const remaining = HOLD_SCAN_LIMIT + 1 - offset;
    const pageSize = Math.min(HOLD_SCAN_PAGE, remaining);
    const r = await db
      .from("drip_runs")
      .select("id, lead_id")
      .eq("tenant_id", tenantId)
      .eq("status", "scheduled")
      .like("last_error", SMS_VERIFICATION_HOLD_PATTERN)
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (r.error) return { ok: false, error: "hold_scan_failed" };

    const rows = (r.data || []) as Array<{ lead_id: string | null }>;
    offset += rows.length;
    if (offset > HOLD_SCAN_LIMIT) {
      return { ok: false, error: "hold_scan_limit_exceeded" };
    }
    for (const row of rows) {
      const id = String(row.lead_id || "").trim();
      if (id) heldLeadIds.add(id);
    }
    if (rows.length < pageSize) break;
  }

  const allHeld = [...heldLeadIds].sort();
  if (allHeld.length === 0) {
    return { ok: true, heldLeadCount: 0, orphanLeadIds: [] };
  }

  const withAnyJob = new Set<string>();
  for (let i = 0; i < allHeld.length; i += JOB_QUERY_BATCH) {
    const ids = allHeld.slice(i, i + JOB_QUERY_BATCH);
    const r = await db
      .from("phone_lookup_jobs")
      .select("lead_id")
      .eq("tenant_id", tenantId)
      .in("lead_id", ids);
    if (r.error) return { ok: false, error: "job_scan_failed" };
    for (const row of (r.data || []) as Array<{ lead_id: string | null }>) {
      const id = String(row.lead_id || "").trim();
      if (id) withAnyJob.add(id);
    }
  }

  return {
    ok: true,
    heldLeadCount: allHeld.length,
    orphanLeadIds: allHeld.filter((id) => !withAnyJob.has(id)),
  };
}

export type VerificationRepairJob = {
  tenant_id: string;
  lead_id: string;
  query_first_name: string;
  query_last_name: string;
  query_city: string | null;
  query_state: string | null;
  query_age: number | null;
  trigger_source: "drip_verification_repair";
  requested_by_email: "auto:drip_verification_repair";
};

type JobBuild =
  | { ok: true; job: VerificationRepairJob }
  | { ok: false; reason: "insufficient_name" };

function splitName(full: unknown): { first: string; last: string } | null {
  const clean = String(full || "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  if (clean.includes(",")) {
    const [last, first] = clean.split(",", 2).map((part) => part.trim());
    if (last && first) return { first: first.split(" ")[0], last };
  }
  const parts = clean.split(" ").filter(Boolean);
  return parts.length >= 2 ? { first: parts[0], last: parts[parts.length - 1] } : null;
}

/** Build only the queue row; deliberately does not modify `leadData`. */
export function buildVerificationRepairJob(
  tenantId: string,
  leadId: string,
  leadData: Readonly<Record<string, unknown>>,
): JobBuild {
  const name = splitName(
    leadData.owner_full_name || leadData.owner_name || leadData.contact_name,
  );
  if (!name) return { ok: false, reason: "insufficient_name" };

  const city = String(
    leadData.owner_home_city || leadData.owner_city || leadData.city || "",
  ).trim();
  const state = String(
    leadData.owner_home_state || leadData.owner_state ||
      leadData.business_state || leadData.state || "",
  ).trim();
  const age = Number(leadData.owner_age);

  return {
    ok: true,
    job: {
      tenant_id: tenantId,
      lead_id: leadId,
      query_first_name: name.first,
      query_last_name: name.last,
      query_city: city || null,
      query_state: state || null,
      query_age: Number.isFinite(age) && age > 0 && age < 120 ? Math.round(age) : null,
      trigger_source: "drip_verification_repair",
      requested_by_email: "auto:drip_verification_repair",
    },
  };
}
