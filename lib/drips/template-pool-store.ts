/**
 * lib/drips/template-pool-store.ts — loads the approved template pool.
 *
 * The selection rules are pure and live in template-pool.ts. This is only the
 * I/O half.
 *
 * Loaded ONCE per dispatch run, like the email budget and the brand map, so
 * per-row copy resolution costs nothing. The pool is small (a few templates per
 * brand/stage/role) and changes rarely, so a single query per run is the right
 * shape.
 *
 * FAILS SAFE, not closed: a read error returns an EMPTY pool, which makes
 * resolveCopy fall back to the step's own copy — exactly today's behaviour. The
 * alternative (holding every row because a template table was unreachable)
 * would stall the whole engine over a cosmetic dependency.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveBrandKey } from "@/lib/email/brands";
import type { PoolTemplate } from "./template-pool";

type Db = ReturnType<typeof getServiceSupabase>;

/**
 * Every APPROVED template for a tenant. Filtered to approved at the query so an
 * unapproved row never enters the process, in addition to the selector's own
 * gate — the approval check is cheap and belongs on both sides.
 */
export async function loadApprovedPool(db: Db, tenantId: string): Promise<PoolTemplate[]> {
  try {
    const r = await db
      .from("drip_template_pool")
      .select("id, brand, stage, role, subject, body_text, status, weight")
      .eq("tenant_id", tenantId)
      .eq("status", "approved")
      .gt("weight", 0)
      .limit(2000);
    if (r.error) return [];
    return ((r.data || []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      brand: resolveBrandKey(row.brand),
      stage: String(row.stage || ""),
      role: String(row.role || "nudge"),
      subject: String(row.subject || ""),
      bodyText: String(row.body_text || ""),
      status: "approved" as const,
      weight: Number(row.weight ?? 1),
    }));
  } catch {
    return [];
  }
}
