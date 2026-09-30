/**
 * lib/ledger/purge.ts — the one privileged path that deletes ledger rows.
 *
 * outcome_events is append-only: its BEFORE DELETE trigger aborts any delete
 * whose tenant has no row in ledger_purge_grants (migration bravo__190). The
 * tenant offboard (Law 25 erasure of a retired workspace) is the exception,
 * and it removes a WHOLE tenant in one transaction: grant, delete, revoke the
 * grant. A grant never outlives the batch that used it.
 *
 * Refuses any tenant that is not in lib/tenant/retired.ts: a live workspace's
 * history is never erased by this function. No route calls it; it is for the
 * offboard tooling only (BEA's tenant_offboard.py runs the same three
 * statements as one transaction).
 */
import type { Client } from "@libsql/client";
import { isRetiredTenant } from "@/lib/tenant/retired";

export type PurgeResult = { tenantId: string; deleted: number };

export async function purgeTenantLedger(
  db: Client,
  args: { tenantId: string; operator: string; reason: string; now: Date },
): Promise<PurgeResult> {
  // Canonical form (lower case, as lib/tenant/retired.ts lists it and as rows
  // store it). isRetiredTenant is case-insensitive, so an id typed in upper case
  // would pass the check below and then match no row: a "done" purge that
  // deleted nothing.
  const tenantId = (args.tenantId || "").trim().toLowerCase();
  if (!tenantId) throw new Error("ledger purge: tenant id is required");
  if (!isRetiredTenant(tenantId)) throw new Error("ledger purge: refused - the tenant is not retired (lib/tenant/retired.ts)");
  const operator = (args.operator || "").trim();
  const reason = (args.reason || "").trim();
  if (!operator || !reason) throw new Error("ledger purge: operator and reason are required");
  const results = await db.batch(
    [
      {
        sql: "INSERT INTO ledger_purge_grants (tenant_id, granted_by, reason, granted_at) VALUES (?, ?, ?, ?)",
        args: [tenantId, operator, reason, args.now.toISOString()],
      },
      { sql: "DELETE FROM outcome_events WHERE tenant_id = ?", args: [tenantId] },
      { sql: "DELETE FROM ledger_purge_grants WHERE tenant_id = ?", args: [tenantId] },
    ],
    "write",
  );
  return { tenantId, deleted: results[1].rowsAffected };
}
