import type { SupabaseClient } from "@supabase/supabase-js";
import { asBool } from "@/lib/cron-empire-row";
import { daemonToggleRefusal } from "@/lib/automations/daemon-cron-guard";
import type {
  CronToggleInput,
  CronToggleResult,
} from "@/lib/automations/cron-toggle-transaction";

type RpcPayload = {
  ok?: unknown;
  status?: unknown;
  body?: unknown;
  row?: unknown;
  previousEnabled?: unknown;
  enabled?: unknown;
};

function parseRpcPayload(value: unknown): RpcPayload | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RpcPayload
    : null;
}

/**
 * Atomic toggle path for the explicit `supabase_legacy` rollback mode.
 *
 * The scoped pre-read is mutation-free and exists only to enforce the daemon
 * interlock and supply expected name/state values. The SECURITY DEFINER RPC
 * locks that same row, compares both expectations, updates it, writes the audit
 * receipt, and returns the persisted row in one Postgres transaction.
 */
export async function toggleLegacyCronWithAudit(
  db: SupabaseClient,
  input: CronToggleInput,
): Promise<CronToggleResult> {
  const table = input.source === "empire" ? "cron_jobs" : "tenant_cron_jobs";
  const activeColumn = input.source === "empire" ? "is_active" : "enabled";

  const priorResult = await db
    .from(table)
    .select(`id, tenant_id, name, ${activeColumn}`)
    .eq("id", input.id)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (priorResult.error) throw new Error(`cron_toggle_read_failed:${priorResult.error.message}`);
  const prior = priorResult.data as Record<string, unknown> | null;
  if (!prior) {
    return {
      ok: false,
      status: 404,
      body: { ok: false, error: "not_found_or_forbidden" },
    };
  }

  const expectedName = typeof prior.name === "string" ? prior.name : null;
  const refusal = daemonToggleRefusal({ ok: true, name: expectedName });
  if (refusal) return { ok: false, status: refusal.status, body: refusal.body };

  const expectedEnabled = asBool(prior[activeColumn]);
  const rpcResult = await db.rpc("toggle_cron_job_with_audit_v1", {
    p_source: input.source,
    p_id: input.id,
    p_tenant_id: input.tenantId,
    p_enabled: input.enabled,
    p_expected_name: expectedName,
    p_expected_enabled: expectedEnabled,
    p_actor_user_id: input.actorUserId,
    p_actor_email: input.actorEmail,
  });
  if (rpcResult.error) throw new Error(`cron_toggle_rpc_failed:${rpcResult.error.message}`);

  const payload = parseRpcPayload(rpcResult.data);
  if (!payload || typeof payload.ok !== "boolean") {
    throw new Error("cron_toggle_rpc_invalid_response");
  }
  if (!payload.ok) {
    const status = typeof payload.status === "number" ? payload.status : 503;
    const body = payload.body && typeof payload.body === "object" && !Array.isArray(payload.body)
      ? payload.body as Record<string, unknown>
      : { ok: false, error: "cron_toggle_rpc_rejected" };
    return { ok: false, status, body };
  }

  if (!payload.row || typeof payload.row !== "object" || Array.isArray(payload.row)) {
    throw new Error("cron_toggle_rpc_readback_missing");
  }
  const row = payload.row as Record<string, unknown>;
  const hasPersistedState = Object.prototype.hasOwnProperty.call(row, activeColumn);
  if (
    row.id !== input.id ||
    row.tenant_id !== input.tenantId ||
    row.name !== expectedName ||
    !hasPersistedState ||
    typeof row[activeColumn] !== "boolean" ||
    row[activeColumn] !== input.enabled ||
    typeof payload.enabled !== "boolean" ||
    payload.enabled !== input.enabled ||
    typeof payload.previousEnabled !== "boolean" ||
    payload.previousEnabled !== expectedEnabled
  ) {
    throw new Error("cron_toggle_rpc_readback_mismatch");
  }

  return {
    ok: true,
    row,
    previousEnabled: payload.previousEnabled,
    enabled: payload.enabled,
  };
}
