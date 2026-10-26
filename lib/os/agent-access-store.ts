/**
 * lib/os/agent-access-store.ts - reading and saving an owner's agent choices,
 * and answering "may this agent use it?" (the rules are lib/os/agent-access.ts).
 *
 * WHERE IT IS KEPT. tenant_integration_credentials has no column for it and this
 * change adds no migration, so each choice is one row there under the service
 * "agent_access": field "custom:<key>" for a custom credential and
 * "connector:<slug>" for an app, value "all" or a JSON list of departments.
 * Rows are tenant-scoped like every other credential row, and encrypted like
 * them (harmless for a list of department names).
 *
 * FAILS CLOSED. A choice that cannot be read is not replaced by the default:
 * the default can be wider than what the owner saved, so a read error answers
 * "not allowed" and says why.
 */

import "server-only";

import { decryptField } from "@/lib/field-encryption";
import { departmentForAgent } from "@/lib/os/approvals/rules";
import {
  CUSTOM_DEFAULT_ACCESS,
  accessAllows,
  agentAccessLabel,
  connectorDefaultAccess,
  parseAgentAccess,
  sameAgentAccess,
  serializeAgentAccess,
  type AccessTarget,
  type AgentAccess,
} from "@/lib/os/agent-access";
import { CONNECTOR_CATALOG } from "@/lib/os/connectors";
import { getServiceSupabase } from "@/lib/supabase-server";
import { deleteTenantIntegrationValue, setTenantIntegrationValue } from "@/lib/tenant-integration-store";

export const AGENT_ACCESS_SERVICE = "agent_access";

/** The row's field for a target: "custom:<key in lower case>" or "connector:<slug>". */
export function accessField(target: AccessTarget): string {
  return target.kind === "custom" ? `custom:${target.key.trim().toLowerCase()}` : `connector:${target.slug.trim().toLowerCase()}`;
}

/** What applies when the owner has saved nothing for this target. */
export function defaultAccess(target: AccessTarget): AgentAccess {
  if (target.kind === "custom") return CUSTOM_DEFAULT_ACCESS;
  return connectorDefaultAccess(CONNECTOR_CATALOG.find((d) => d.slug === target.slug) ?? null);
}

export type AccessOverrides = { ok: true; byField: ReadonlyMap<string, AgentAccess> } | { ok: false; error: string };

/** Every saved choice for a workspace, by field. One read for a whole page or turn. */
export async function readAgentAccessOverrides(tenantId: string): Promise<AccessOverrides> {
  if (!tenantId) return { ok: false, error: "missing_tenant" };
  try {
    const r = await getServiceSupabase()
      .from("tenant_integration_credentials")
      .select("field_key, encrypted_value")
      .eq("tenant_id", tenantId)
      .eq("service", AGENT_ACCESS_SERVICE);
    if (r.error) return { ok: false, error: r.error.message || "agent_access_read_failed" };
    const byField = new Map<string, AgentAccess>();
    for (const row of (r.data || []) as { field_key: string; encrypted_value: string }[]) {
      const access = parseAgentAccess(decryptField(row.encrypted_value));
      if (access === null) return { ok: false, error: `agent_access_unreadable:${row.field_key}` };
      byField.set(row.field_key, access);
    }
    return { ok: true, byField };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "agent_access_read_failed" };
  }
}

/** The choice in force for a target, given a workspace's saved overrides. */
export function effectiveAccess(overrides: ReadonlyMap<string, AgentAccess>, target: AccessTarget): { access: AgentAccess; saved: boolean } {
  const saved = overrides.get(accessField(target));
  return saved !== undefined ? { access: saved, saved: true } : { access: defaultAccess(target), saved: false };
}

export type AccessVerdict = { allowed: true } | { allowed: false; reason: string };

/** May the agent `agentKey` use the target? A read failure is "no", with the reason. */
export function judgeAccess(overrides: AccessOverrides, target: AccessTarget, agentKey: string | null | undefined): AccessVerdict {
  if (!overrides.ok) return { allowed: false, reason: `could not check which agents may use this (${overrides.error})` };
  const { access } = effectiveAccess(overrides.byField, target);
  if (accessAllows(access, departmentForAgent(agentKey))) return { allowed: true };
  return { allowed: false, reason: `set for ${agentAccessLabel(access)}` };
}

export async function agentMayUse(tenantId: string, target: AccessTarget, agentKey: string | null | undefined): Promise<AccessVerdict> {
  return judgeAccess(await readAgentAccessOverrides(tenantId), target, agentKey);
}

/** Save the owner's choice. Saving the default itself clears the row, so a later change to the default applies. */
export async function saveAgentAccess(input: {
  tenantId: string;
  target: AccessTarget;
  access: AgentAccess;
  createdBy?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (sameAgentAccess(input.access, defaultAccess(input.target))) {
    return clearAgentAccess({ tenantId: input.tenantId, target: input.target });
  }
  const r = await setTenantIntegrationValue({
    tenantId: input.tenantId,
    service: AGENT_ACCESS_SERVICE,
    fieldKey: accessField(input.target),
    value: serializeAgentAccess(input.access),
    createdBy: input.createdBy ?? null,
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** Back to the default (also how a deleted credential's choice goes with it). */
export async function clearAgentAccess(input: { tenantId: string; target: AccessTarget }): Promise<{ ok: true } | { ok: false; error: string }> {
  return deleteTenantIntegrationValue({ tenantId: input.tenantId, service: AGENT_ACCESS_SERVICE, fieldKey: accessField(input.target) });
}
