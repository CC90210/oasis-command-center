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
 * FAILS SAFE, not closed, ON THE SEND PATH: a read error returns an EMPTY pool,
 * which makes resolveCopy fall back to the step's own copy — exactly today's
 * behaviour. The alternative (holding every row because a template table was
 * unreachable) would stall the whole engine over a cosmetic dependency.
 *
 * THAT IS WRONG FOR A WRITE. An empty pool is indistinguishable from "your
 * template does not exist", so a validator handed the safe loader would refuse
 * a perfectly good swap and blame the operator's choice for a database outage.
 * Write paths use loadApprovedPoolOrThrow and say which one actually happened.
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
    return await loadApprovedPoolOrThrow(db, tenantId);
  } catch {
    return [];
  }
}

/**
 * The same read, but a failure is a failure.
 *
 * For any path that DECIDES something on the pool's contents — validating a
 * template swap before it is written, most of all. There, an empty pool from a
 * broken read is a wrong answer wearing the right shape: the operator is told
 * their template does not exist, when the truth is that nothing could be read.
 */
export async function loadApprovedPoolOrThrow(db: Db, tenantId: string): Promise<PoolTemplate[]> {
  const r = await db
    .from("drip_template_pool")
    .select("id, brand, stage, role, subject, body_text, status, weight")
    .eq("tenant_id", tenantId)
    .eq("status", "approved")
    .gt("weight", 0)
    .limit(2000);
  if (r.error) throw new Error(`template pool read failed: ${r.error.message}`);
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
}
