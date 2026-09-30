/**
 * lib/provisioning/provision-tenant.ts - OASIS sets up a client workspace.
 *
 * WHY THIS EXISTS (2026-09-30, audit finding no-operator-provisioning-path).
 * A client workspace is "provisioned" when it has its own manifest; until then
 * its owner sees Today alone and "your workspace is being set up". Nothing in
 * the product could write that manifest for a client: the manifest routes judge
 * a write by the caller's own workspace, so an operator (whose workspace is
 * OASIS's) was always "another tenant", and the only other writer was the
 * self-serve wizard any member could run. Production had 0 provisioning runs.
 *
 * What a run does, each step recorded in provisioning_runs.steps_json so the
 * client's setup page and the operator console show real progress:
 *   1. verify the caller is a platform operator (fails closed);
 *   2. select the workspace, or create it (name + slug chosen by the operator);
 *   3. open a provisioning run;
 *   4. build the manifest: the departments and opt-in modules the operator
 *      chose, neutral department teammates (lib/provisioning/team.ts);
 *   5. pass the manifest write guards with the operator-only, audited
 *      exemption (lib/manifest/guards.ts);
 *   6. save it through manifest persistence (versioned, with an audit row);
 *   7. give members who joined before setup (no agents yet) the new teammates;
 *   8. close the run as complete, or as failed with the reason.
 *
 * Idempotent in effect: provisioning an already-provisioned workspace saves a
 * new manifest version with the new choices and opens a new run.
 *
 * Never run on CC's behalf by an agent: callers are the operator's own clicks
 * on /admin/installs (confirmed in the page) and the secret-gated setup CLI.
 */

import "server-only";

import { randomUUID } from "node:crypto";
import { diffManifests } from "@/lib/manifest/diff";
import { manifestWriteGuards } from "@/lib/manifest/guards";
import { getManifestSlugForTenant, saveManifest, ManifestPersistenceError } from "@/lib/manifest/persistence";
import { OASIS_SEED_TENANT_IDS, UNPROVISIONED_SEED } from "@/lib/manifest/seeds";
import type { ManifestChatApp, ManifestJevMode } from "@/lib/manifest/schema";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { resolvePlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { buildProvisionedManifest } from "@/lib/provisioning/manifest";
import { departmentLabels } from "@/lib/provisioning/team";
import { getServiceSupabase } from "@/lib/supabase-server";
import { isRetiredTenant } from "@/lib/tenant/retired";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import type { DepartmentKey, ModuleKey } from "@/lib/os/types";

export type ProvisionStep = { title: string; time: string };

export type ProvisionTenantInput = {
  operator: { authUserId: string; email: string };
  target: { tenantId: string } | { create: { name: string; slug: string } };
  departments: DepartmentKey[];
  modules: ModuleKey[];
  chatApps?: ManifestChatApp[];
  jev?: ManifestJevMode;
};

export type ProvisionTenantResult =
  | {
      ok: true;
      tenantId: string;
      slug: string;
      name: string;
      runId: string;
      manifestVersion: number;
      steps: ProvisionStep[];
      created: boolean;
    }
  | { ok: false; status: number; error: string; message: string; runId?: string; steps?: ProvisionStep[] };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function isValidWorkspaceSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

function fail(status: number, error: string, message: string, extra: { runId?: string; steps?: ProvisionStep[] } = {}): ProvisionTenantResult {
  return { ok: false, status, error, message, ...extra };
}

type TenantRow = { id: string; slug: string; name: string; custom_fields: Record<string, unknown> | null };

async function readTenant(tenantId: string): Promise<TenantRow | null> {
  const { data, error } = await getServiceSupabase()
    .from("tenants")
    .select("id, slug, name, custom_fields")
    .eq("id", tenantId)
    .maybeSingle();
  if (error) throw new Error(`tenant_read_failed: ${error.message}`);
  return (data as TenantRow | null) ?? null;
}

async function createTenant(name: string, slug: string): Promise<{ ok: true; tenant: TenantRow } | { ok: false; status: number; error: string; message: string }> {
  const db = getServiceSupabase();
  const taken = await db.from("tenants").select("id").eq("slug", slug).limit(1);
  if (taken.error) throw new Error(`tenant_slug_check_failed: ${taken.error.message}`);
  if ((taken.data || []).length > 0) {
    return { ok: false, status: 409, error: "slug_taken", message: `A workspace already uses "${slug}". Pick another address.` };
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const insert = await db
    .from("tenants")
    .insert({
      id,
      slug,
      name,
      plan_tier: "starter",
      purchase_status: "pending",
      custom_fields: {},
      created_at: now,
      updated_at: now,
    })
    .select("id, slug, name, custom_fields")
    .single();
  if (insert.error || !insert.data) throw new Error(`tenant_create_failed: ${insert.error?.message ?? "no row"}`);
  return { ok: true, tenant: insert.data as TenantRow };
}

/** provisioning_runs writer. Raw libSQL, like the table's other readers. */
class RunLog {
  readonly steps: ProvisionStep[] = [];
  constructor(readonly id: string, private readonly tenantId: string) {}

  static async open(tenantId: string, tenantSlug: string): Promise<RunLog> {
    const id = randomUUID().replace(/-/g, "");
    await getTursoClient().execute({
      sql: `INSERT INTO provisioning_runs (id, tenant_id, tenant_slug, status, started_at, steps_json, created_at)
            VALUES (?, ?, ?, 'provisioning', ?, '[]', ?)`,
      args: [id, tenantId, tenantSlug, new Date().toISOString(), new Date().toISOString()],
    });
    return new RunLog(id, tenantId);
  }

  async step(title: string): Promise<void> {
    this.steps.push({ title, time: new Date().toISOString() });
    await getTursoClient().execute({
      sql: `UPDATE provisioning_runs SET steps_json = ? WHERE id = ? AND tenant_id = ?`,
      args: [JSON.stringify(this.steps), this.id, this.tenantId],
    });
  }

  async finish(status: "complete" | "failed", errorMessage?: string): Promise<void> {
    await getTursoClient().execute({
      sql: `UPDATE provisioning_runs
               SET status = ?, completed_at = ?, error_message = ?, steps_json = ?
             WHERE id = ? AND tenant_id = ?`,
      args: [status, new Date().toISOString(), errorMessage ?? null, JSON.stringify(this.steps), this.id, this.tenantId],
    });
  }
}

export async function provisionTenant(input: ProvisionTenantInput): Promise<ProvisionTenantResult> {
  // 1. Operator, re-verified here whatever the route checked.
  const operator = await resolvePlatformOperatorForAuthUser(input.operator.authUserId, input.operator.email);
  if (!operator.operator) return fail(403, "operator_required", "Only an OASIS operator can set up a client workspace.");
  if (!tursoConfigured()) {
    return fail(503, "provisioning_store_unavailable", "The provisioning log (Turso) is not configured, so nothing was set up.");
  }
  if (input.departments.length === 0) return fail(400, "no_departments", "Choose at least one department.");

  // 2. The workspace.
  let tenant: TenantRow;
  let created = false;
  if ("create" in input.target) {
    const name = input.target.create.name.trim().slice(0, 120);
    const slug = input.target.create.slug.trim().toLowerCase();
    if (!name) return fail(400, "name_required", "Give the workspace a name.");
    if (!isValidWorkspaceSlug(slug)) {
      return fail(400, "invalid_slug", "The address must be 2 to 63 lowercase letters, numbers or dashes, starting with a letter or number.");
    }
    const made = await createTenant(name, slug);
    if (!made.ok) return fail(made.status, made.error, made.message);
    tenant = made.tenant;
    created = true;
  } else {
    const found = await readTenant(input.target.tenantId);
    if (!found) return fail(404, "workspace_not_found", "That workspace does not exist.");
    tenant = found;
  }
  if (OASIS_SEED_TENANT_IDS.has(tenant.id) || isRetiredTenant(tenant.id)) {
    return fail(403, "protected_workspace", "OASIS's own workspaces and retired workspaces are not provisioned here.");
  }
  const slug = resolveClientProfileSlug({ slug: tenant.slug, custom_fields: tenant.custom_fields || {} }) || "";
  if (!isValidWorkspaceSlug(slug)) {
    return fail(422, "workspace_slug_unusable", `This workspace's address "${tenant.slug}" cannot hold a manifest. Rename it first.`);
  }
  const name = tenant.name.trim();

  // 3. The run. Every later failure is recorded on it.
  const run = await RunLog.open(tenant.id, slug);
  const failRun = async (status: number, error: string, message: string): Promise<ProvisionTenantResult> => {
    await run.step(`Stopped: ${message}`);
    await run.finish("failed", `${error}: ${message}`);
    return fail(status, error, message, { runId: run.id, steps: run.steps });
  };
  try {
    await run.step(created ? `Created the workspace "${name}" at /${slug}` : `Selected the workspace "${name}"`);

    // 4. The manifest.
    const manifest = buildProvisionedManifest({
      slug,
      name,
      departments: input.departments,
      modules: input.modules,
      chatApps: input.chatApps,
      jev: input.jev,
    });
    const teammates = manifest.agents.map((a) => a.display_name);
    await run.step(
      `Planned ${departmentLabels(input.departments).join(", ")}` +
        (teammates.length ? `, with teammates: ${teammates.join(", ")}` : ", with no AI teammates yet") +
        (input.modules.length ? `; add-ons requested: ${input.modules.join(", ")}` : ""),
    );

    // 5. Guards: protected names first, then the operator exemption.
    const existingSlug = await getManifestSlugForTenant(tenant.id);
    if (existingSlug && existingSlug !== slug) {
      return failRun(
        409,
        "manifest_under_other_address",
        `This workspace already has a setup saved under "${existingSlug}". It must be moved before it can be set up again.`,
      );
    }
    const guard = await manifestWriteGuards(slug, tenant.id, {
      kind: "operator_provisioning",
      operatorAuthUserId: input.operator.authUserId,
      operatorEmail: input.operator.email,
      targetTenantId: tenant.id,
      reason: `provision ${slug}`,
    });
    if (!guard.ok) return failRun(guard.status, guard.error, guard.reason ?? guard.error);
    await run.step("Checked the workspace address and recorded the operator action");

    // 6. Save (versioned; persistence writes the manifest audit row).
    const saved = await saveManifest({
      slug,
      next: manifest,
      diff: diffManifests(UNPROVISIONED_SEED, manifest),
      actor: { type: "user", id: input.operator.authUserId },
      message: `Provisioned by OASIS (${input.departments.join(", ")})`,
      tenant_id: tenant.id,
    });
    await run.step(`Saved the workspace setup (version ${saved.row.version})`);

    // 7. Members who joined before setup have no agents: give them the team.
    const primary = manifest.agents.find((a) => a.primary)?.slug ?? manifest.agents[0]?.slug ?? "";
    if (primary) {
      const agents = manifest.agents.map((a) => a.slug);
      const backfill = await getTursoClient().execute({
        sql: `UPDATE user_profiles SET agents_enabled = ?, primary_agent = ?
               WHERE tenant_id = ? AND (agents_enabled IS NULL OR trim(agents_enabled) IN ('', '[]'))`,
        args: [JSON.stringify(agents), primary, tenant.id],
      });
      const n = Number(backfill.rowsAffected ?? 0);
      if (n > 0) await run.step(`Gave ${n} existing member${n === 1 ? "" : "s"} the workspace's teammates`);
    }

    // 8. Done.
    await run.step("Workspace ready");
    await run.finish("complete");
    return {
      ok: true,
      tenantId: tenant.id,
      slug,
      name,
      runId: run.id,
      manifestVersion: saved.row.version,
      steps: run.steps,
      created,
    };
  } catch (err) {
    const message = err instanceof ManifestPersistenceError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
    console.error("[provisioning] run failed", { tenantId: tenant.id, runId: run.id, message });
    return failRun(500, "provisioning_failed", "Setup stopped on an unexpected error. Nothing after the last step was saved.");
  }
}

/** The newest provisioning run for a workspace, for the setup page and the console. */
export type ProvisioningRunView = {
  id: string;
  status: string;
  steps: ProvisionStep[];
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
};

export function parseRunSteps(raw: unknown): ProvisionStep[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((s): s is { title: unknown; time: unknown } => !!s && typeof s === "object")
    .map((s) => ({ title: String(s.title ?? ""), time: String(s.time ?? "") }))
    .filter((s) => s.title);
}

/** Throws on a failed read: "could not read" is not "no run". */
export async function latestProvisioningRun(tenantId: string): Promise<ProvisioningRunView | null> {
  const rs = await getTursoClient().execute({
    sql: `SELECT id, status, steps_json, started_at, completed_at, error_message
            FROM provisioning_runs WHERE tenant_id = ?
           ORDER BY COALESCE(started_at, created_at) DESC LIMIT 1`,
    args: [tenantId],
  });
  const row = rs.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    status: String(row.status ?? "pending"),
    steps: parseRunSteps(row.steps_json),
    startedAt: row.started_at == null ? null : String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    errorMessage: row.error_message == null ? null : String(row.error_message),
  };
}
