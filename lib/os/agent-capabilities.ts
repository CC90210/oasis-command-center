/** Fresh, secretless capabilities for the authenticated member and department.
 * Credential values never enter this reader. Saving or revoking a connection is
 * visible on the next call; discovery is not a grant to a later execution.
 */
import "server-only";
import { resolveOsViewerFor, type OsViewer } from "@/components/os/department/viewer";
import { departmentGate } from "@/components/os/department/gate";
import { loadConnectorFacts } from "@/components/os/connections/connector-facts";
import { CONNECTOR_CATALOG, connectionSetUp, resolveConnectorStatus } from "@/lib/os/connectors";
import { judgeDepartmentAccess, readAgentAccessOverrides } from "@/lib/os/agent-access-store";
import { readKeyHosts } from "@/lib/os/custom-key-hosts";
import { looksLikeSecret } from "@/lib/os/custom-keys";
import { getServiceSupabase } from "@/lib/supabase-server";
import { VAULT_CUSTOM_SERVICE, VAULT_KEY_PATTERN } from "@/lib/tenant-integration-store";
import type { OsDepartment } from "@/lib/os/departments";

export type CustomKeyCapability = { name: string; website: string | null; status: "available" | "website_required"; tools: string[] };
export type AppCapability = {
  id: string; name: string; status: string; connected: boolean;
  reads: readonly string[]; does: readonly string[]; tools: string[];
};
export type AgentCapabilities = { apps: AppCapability[]; custom_keys: CustomKeyCapability[]; checked_at: string };
type CustomRow = { field_key: string; updated_at?: string | null };
export type CapabilityDeps = {
  resolveViewer: typeof resolveOsViewerFor;
  facts: typeof loadConnectorFacts;
  access: typeof readAgentAccessOverrides;
  hosts: typeof readKeyHosts;
  customRows: (tenantId: string) => Promise<CustomRow[]>;
};

async function customRows(tenantId: string): Promise<CustomRow[]> {
  const result = await getServiceSupabase().from("tenant_integration_credentials")
    .select("field_key, updated_at").eq("tenant_id", tenantId).eq("service", VAULT_CUSTOM_SERVICE)
    .order("field_key", { ascending: true }).limit(501);
  if (result.error) throw new Error("custom_keys_unavailable");
  if ((result.data?.length ?? 0) > 500) throw new Error("custom_key_catalog_too_large");
  return (result.data ?? []) as CustomRow[];
}
const defaults: CapabilityDeps = { resolveViewer: resolveOsViewerFor, facts: loadConnectorFacts, access: readAgentAccessOverrides, hosts: readKeyHosts, customRows };

/** Re-check the real seat and department; a stale prompt never authorizes a tool. */
export async function currentCapabilityViewer(viewer: OsViewer, dept: OsDepartment | null, resolve = resolveOsViewerFor): Promise<OsViewer> {
  const tenantId = viewer.surface.tenantId;
  const userId = viewer.authUserId || viewer.surface.userId;
  if (!tenantId || !userId) throw new Error("capability_session_required");
  const fresh = await resolve(tenantId, userId);
  if (!fresh.ok || fresh.surface.tenantId !== tenantId || fresh.surface.userId !== userId || (dept !== null && departmentGate(dept.slug, fresh.navInput) === null)) {
    throw new Error("capability_access_unavailable");
  }
  return fresh;
}

export async function loadAgentCapabilities(viewer: OsViewer, dept: OsDepartment | null, nowMs = Date.now(), injected: Partial<CapabilityDeps> = {}): Promise<AgentCapabilities> {
  const deps = { ...defaults, ...injected };
  const fresh = await currentCapabilityViewer(viewer, dept, deps.resolveViewer);
  const tenantId = fresh.surface.tenantId;
  const [facts, access, hosts, rows] = await Promise.all([
    deps.facts({ tenantId, userId: fresh.surface.userId, personal: true }),
    deps.access(tenantId), deps.hosts(tenantId), deps.customRows(tenantId),
  ]);
  if (!access.ok || !hosts.ok) throw new Error("capability_assignments_unavailable");
  const apps: AppCapability[] = [];
  for (const def of CONNECTOR_CATALOG) {
    if (!def.live || def.category === "ai_models" || !judgeDepartmentAccess(access, { kind: "connector", slug: def.slug }, dept?.key ?? null).allowed) continue;
    const status = resolveConnectorStatus(def, facts, nowMs);
    if (!connectionSetUp(status) && (!dept || !def.departments.includes(dept.key))) continue;
    const sms = def.slug === "quo" && !!dept && ["chief_of_staff", "sales", "client_success"].includes(dept.key) && fresh.surface.capabilities.canAct;
    apps.push({ id: def.slug, name: def.name, status: status.label, connected: status.kind === "connected", reads: def.reads,
      does: sms ? ["Prepare a text for approval. The approved text uses this workspace's Quo sender after current sending checks pass."] : ["Connection information; no action adapter is available in this chat."],
      tools: sms ? ["propose_sms"] : [],
    });
  }
  const custom_keys = rows.flatMap(row => {
    const name = row.field_key.toUpperCase();
    if (!VAULT_KEY_PATTERN.test(name) || looksLikeSecret(name) || !judgeDepartmentAccess(access, { kind: "custom", key: name }, dept?.key ?? null).allowed) return [];
    const website = hosts.hosts.get(name) ?? null;
    return [{ name, website, status: website ? "available" as const : "website_required" as const, tools: website ? ["use_custom_key"] : [] }];
  });
  return { apps, custom_keys, checked_at: new Date(nowMs).toISOString() };
}
