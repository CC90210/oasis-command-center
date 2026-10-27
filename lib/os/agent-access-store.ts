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
 * FAILS CLOSED, AND NARROWLY. A choice that cannot be read is never replaced
 * by the default, which can be wider than what the owner saved: that key or
 * app is refused to every agent until an owner saves it again, and the page
 * lets them. One unreadable row does not shut every other key and app (review
 * of OCC #743). A read that fails outright refuses everything this time, since
 * nothing is known.
 */

import "server-only";

import { decryptField } from "@/lib/field-encryption";
import { isClientSafeTool, isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";
import { departmentForAgent } from "@/lib/os/approvals/rules";
import {
  APP_TOOLS,
  CUSTOM_DEFAULT_ACCESS,
  accessAllows,
  connectorDefaultAccess,
  parseAgentAccess,
  sameAgentAccess,
  serializeAgentAccess,
  type AccessTarget,
  type AgentAccess,
  type RefusalCode,
} from "@/lib/os/agent-access";
import { CONNECTOR_CATALOG } from "@/lib/os/connectors";
import { getServiceSupabase } from "@/lib/supabase-server";
import { AGENT_ACCESS_SERVICE, deleteTenantIntegrationValue, setTenantIntegrationValue } from "@/lib/tenant-integration-store";

export { AGENT_ACCESS_SERVICE };

/** The row's field for a target: "custom:<key in lower case>" or "connector:<slug>". */
export function accessField(target: AccessTarget): string {
  return target.kind === "custom" ? `custom:${target.key.trim().toLowerCase()}` : `connector:${target.slug.trim().toLowerCase()}`;
}

/** What applies when the owner has saved nothing for this target. */
export function defaultAccess(target: AccessTarget): AgentAccess {
  if (target.kind === "custom") return CUSTOM_DEFAULT_ACCESS;
  return connectorDefaultAccess(CONNECTOR_CATALOG.find((d) => d.slug === target.slug) ?? null);
}

export type AccessOverrides =
  | { ok: true; byField: ReadonlyMap<string, AgentAccess>; unreadable: ReadonlySet<string> }
  | { ok: false; error: string };

/** Every saved choice for a workspace, by field. One read for a whole page or turn. */
export async function readAgentAccessOverrides(tenantId: string): Promise<AccessOverrides> {
  if (!tenantId) return { ok: false, error: "missing_tenant" };
  let rows: { field_key: string; encrypted_value: string }[];
  try {
    const r = await getServiceSupabase()
      .from("tenant_integration_credentials")
      .select("field_key, encrypted_value")
      .eq("tenant_id", tenantId)
      .eq("service", AGENT_ACCESS_SERVICE);
    if (r.error) return { ok: false, error: r.error.message || "agent_access_read_failed" };
    rows = (r.data || []) as typeof rows;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "agent_access_read_failed" };
  }
  const byField = new Map<string, AgentAccess>();
  const unreadable = new Set<string>();
  for (const row of rows) {
    let access: AgentAccess | null = null;
    try {
      access = parseAgentAccess(decryptField(row.encrypted_value));
    } catch {
      access = null;
    }
    if (access === null) {
      unreadable.add(row.field_key);
      console.error("[agent-access] a saved agent choice could not be read; refused until saved again", { tenantId, field: row.field_key });
    } else {
      byField.set(row.field_key, access);
    }
  }
  return { ok: true, byField, unreadable };
}

/** The choice in force for a target: saved, the default, or null when the saved one cannot be read. */
export function effectiveAccess(
  overrides: { byField: ReadonlyMap<string, AgentAccess>; unreadable?: ReadonlySet<string> },
  target: AccessTarget,
): { access: AgentAccess | null; saved: boolean } {
  const field = accessField(target);
  if (overrides.unreadable?.has(field)) return { access: null, saved: true };
  const saved = overrides.byField.get(field);
  return saved !== undefined ? { access: saved, saved: true } : { access: defaultAccess(target), saved: false };
}

export type AccessVerdict = { allowed: true } | { allowed: false; code: RefusalCode; access: AgentAccess | null };

/** May the agent `agentKey` use the target? Anything unknown is "no", with the reason as a code. */
export function judgeAccess(overrides: AccessOverrides, target: AccessTarget, agentKey: string | null | undefined): AccessVerdict {
  if (!overrides.ok) return { allowed: false, code: "read_failed", access: null };
  const { access } = effectiveAccess(overrides, target);
  if (access === null) return { allowed: false, code: "unreadable", access: null };
  if (accessAllows(access, departmentForAgent(agentKey))) return { allowed: true };
  return { allowed: false, code: "not_given", access };
}

export async function agentMayUse(tenantId: string, target: AccessTarget, agentKey: string | null | undefined): Promise<AccessVerdict> {
  return judgeAccess(await readAgentAccessOverrides(tenantId), target, agentKey);
}

/**
 * Do this workspace's agents use what an owner assigns? Custom keys reach an
 * agent through get_credential (OASIS) and use_custom_key (every workspace,
 * CC 2026-10-27), apps through their tools (APP_TOOLS). Outside OASIS only the
 * client-safe tools run (lib/ai/tools/client-safe-registry.ts), so an
 * assignment is offered only where a client-safe tool honours it (final review
 * of OCC #748). The pages show the picker only where it is true.
 */
export function assignmentsApply(tenantId: string, what: "custom" | "apps"): boolean {
  if (isOasisInternalTenant(tenantId)) return true;
  return what === "custom"
    ? isClientSafeTool("get_credential") || isClientSafeTool("use_custom_key")
    : Object.keys(APP_TOOLS).some((tool) => isClientSafeTool(tool));
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

/** Back to the default (also how a deleted credential's choice goes with it, and how an unreadable one is repaired). */
export async function clearAgentAccess(input: { tenantId: string; target: AccessTarget }): Promise<{ ok: true } | { ok: false; error: string }> {
  return deleteTenantIntegrationValue({ tenantId: input.tenantId, service: AGENT_ACCESS_SERVICE, fieldKey: accessField(input.target) });
}
