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
 *   4. read the setup the workspace already has, if any;
 *   5. build the manifest: the departments and opt-in modules the operator
 *      chose, neutral department teammates (lib/provisioning/team.ts), merged
 *      into the stored setup when there is one;
 *   6. pass the manifest write guards with the operator-only, audited
 *      exemption (lib/manifest/guards.ts);
 *   7. save it through manifest persistence (versioned, with an audit row);
 *   8. give members who joined before setup (no agents yet) the new teammates;
 *   9. close the run as complete, or as failed with the reason.
 *
 * Setting up an already-set-up workspace again saves a new manifest version
 * that MERGES the new choices into the stored setup (departments, add-ons, chat
 * apps, Jev and the department teammates change; the workspace's own name,
 * tagline, pages, data model, saved prompts and added teammates stay), with the
 * audit diff taken against the stored manifest and the save pinned to its
 * version (lib/provisioning/manifest.ts mergeProvisionedManifest).
 *
 * A new workspace's address is checked BEFORE its tenants row is written: a
 * reserved name (sun, suga, default, oasis...), an address that already names an
 * in-code workspace, or one another workspace's setup is saved under is refused
 * with nothing created. If a run that created a workspace still fails before
 * its setup is saved, the new, empty workspace row is removed again.
 *
 * What the client sees: the setup page lists these steps verbatim, so they use
 * department and add-on LABELS, and a failed run records only "Setup stopped";
 * the reason goes to error_message and to the operator's response.
 *
 * Never run on CC's behalf by an agent: callers are the operator's own clicks
 * on /admin/installs (confirmed in the page) and the secret-gated setup CLI.
 */

import "server-only";

import { randomUUID } from "node:crypto";
import { diffManifests } from "@/lib/manifest/diff";
import { manifestWriteGuards, PROTECTED_SLUGS } from "@/lib/manifest/guards";
import {
  getManifestRow,
  getManifestSlugForTenant,
  saveManifest,
  ManifestPersistenceError,
  type ManifestRow,
} from "@/lib/manifest/persistence";
import { getSeedManifest, isUnprovisionedManifest, OASIS_SEED_TENANT_IDS, UNPROVISIONED_SEED } from "@/lib/manifest/seeds";
import type { ManifestChatApp, ManifestJevMode } from "@/lib/manifest/schema";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { resolvePlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { buildProvisionedManifest, mergeProvisionedManifest } from "@/lib/provisioning/manifest";
import { DEPARTMENT_TEAMMATE_SLUGS, departmentLabels, moduleLabels } from "@/lib/provisioning/team";
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

/**
 * Why a NEW workspace may not take `slug`, or null. Runs before any row is
 * written. The manifest guards used to catch these only after createTenant, so
 * the refusal left a tenants row behind (no delete or rename exists in the UI),
 * and with "sun" that row resolved to SunBiz's retired shell and its agents.
 * Throws on a failed read: "could not check" is never "free".
 */
async function newAddressRefusal(slug: string): Promise<{ status: number; error: string; message: string } | null> {
  if (PROTECTED_SLUGS.has(slug) || !isUnprovisionedManifest(getSeedManifest(slug, null))) {
    return { status: 409, error: "slug_reserved", message: `The address "${slug}" is reserved. Pick another address.` };
  }
  const db = getServiceSupabase();
  const taken = await db.from("tenants").select("id").eq("slug", slug).limit(1);
  if (taken.error) throw new Error(`tenant_slug_check_failed: ${taken.error.message}`);
  if ((taken.data || []).length > 0) {
    return { status: 409, error: "slug_taken", message: `A workspace already uses "${slug}". Pick another address.` };
  }
  const held = await db.from("tenant_manifests").select("tenant_id").eq("slug", slug).limit(1);
  if (held.error) throw new Error(`manifest_slug_check_failed: ${held.error.message}`);
  if ((held.data || []).length > 0) {
    return {
      status: 409,
      error: "slug_taken",
      message: `Another workspace's setup is saved under "${slug}". Pick another address.`,
    };
  }
  return null;
}

async function createTenant(name: string, slug: string): Promise<{ ok: true; tenant: TenantRow } | { ok: false; status: number; error: string; message: string }> {
  const refused = await newAddressRefusal(slug);
  if (refused) return { ok: false, ...refused };
  const db = getServiceSupabase();
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

/**
 * Remove a workspace THIS run created when the run failed before its setup was
 * saved. The SQL itself refuses once the workspace has a manifest or a member,
 * so a later failure (after the save) can never delete a real workspace.
 */
async function discardCreatedTenant(tenantId: string): Promise<"removed" | "kept" | "failed"> {
  try {
    const rs = await getTursoClient().execute({
      sql: `DELETE FROM tenants
             WHERE id = ?
               AND NOT EXISTS (SELECT 1 FROM tenant_manifests WHERE tenant_id = ?)
               AND NOT EXISTS (SELECT 1 FROM user_profiles WHERE tenant_id = ?)`,
      args: [tenantId, tenantId, tenantId],
    });
    return Number(rs.rowsAffected ?? 0) === 1 ? "removed" : "kept";
  } catch (err) {
    console.error("[provisioning] could not remove the workspace a failed run created", {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
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
  if (!("create" in input.target)) {
    const found = await readTenant(input.target.tenantId);
    if (!found) return fail(404, "workspace_not_found", "That workspace does not exist.");
    return provisionWorkspace(input, found, false);
  }
  const name = input.target.create.name.trim().slice(0, 120);
  const slug = input.target.create.slug.trim().toLowerCase();
  if (!name) return fail(400, "name_required", "Give the workspace a name.");
  if (!isValidWorkspaceSlug(slug)) {
    return fail(400, "invalid_slug", "The address must be 2 to 63 lowercase letters, numbers or dashes, starting with a letter or number.");
  }
  const made = await createTenant(name, slug);
  if (!made.ok) return fail(made.status, made.error, made.message);

  // A workspace this run created is not kept when the run stops before its
  // setup is saved: nothing in the product can delete or rename it later.
  let result: ProvisionTenantResult;
  try {
    result = await provisionWorkspace(input, made.tenant, true);
  } catch (err) {
    await discardCreatedTenant(made.tenant.id);
    throw err;
  }
  if (result.ok) return result;
  const discarded = await discardCreatedTenant(made.tenant.id);
  if (discarded === "removed") return { ...result, message: `${result.message} The new workspace was not kept.` };
  if (discarded === "failed") {
    return {
      ...result,
      message: `${result.message} The new workspace "${made.tenant.name}" could not be removed again and is listed without a setup.`,
    };
  }
  return result;
}

async function provisionWorkspace(input: ProvisionTenantInput, tenant: TenantRow, created: boolean): Promise<ProvisionTenantResult> {
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
    // The client's setup page lists the steps verbatim, so the step says only
    // that setup stopped. The reason is for OASIS: error_message on the run and
    // the operator's response.
    await run.step("Setup stopped");
    await run.finish("failed", `${error}: ${message}`);
    return fail(status, error, message, { runId: run.id, steps: run.steps });
  };
  try {
    await run.step(created ? `Created the workspace "${name}" at /${slug}` : `Selected the workspace "${name}"`);

    // 4. The setup it already has, if any. "Set up again" merges into it.
    const existingSlug = await getManifestSlugForTenant(tenant.id);
    if (existingSlug && existingSlug !== slug) {
      return failRun(
        409,
        "manifest_under_other_address",
        `This workspace already has a setup saved under "${existingSlug}". It must be moved before it can be set up again.`,
      );
    }
    let stored: ManifestRow | null = null;
    if (existingSlug) {
      try {
        stored = await getManifestRow(existingSlug);
      } catch (err) {
        console.error("[provisioning] stored setup unreadable; not replacing it", {
          tenantId: tenant.id,
          slug: existingSlug,
          error: err instanceof Error ? err.message : String(err),
        });
        return failRun(
          409,
          "stored_setup_unreadable",
          "This workspace's saved setup could not be read, so it was not replaced. Nothing was changed.",
        );
      }
    }

    // 5. The manifest.
    const built = buildProvisionedManifest({
      slug,
      name,
      departments: input.departments,
      modules: input.modules,
      chatApps: input.chatApps,
      jev: input.jev,
    });
    const manifest = stored ? mergeProvisionedManifest(stored.manifest, built) : built;
    const teammates = manifest.agents.map((a) => a.display_name);
    const addOns = moduleLabels(input.modules);
    await run.step(
      `Planned ${departmentLabels(input.departments).join(", ")}` +
        (teammates.length ? `, with teammates: ${teammates.join(", ")}` : ", with no AI teammates yet") +
        (addOns.length ? `; add-ons requested: ${addOns.join(", ")}` : ""),
    );

    // 6. Guards: protected names first, then the operator exemption.
    const guard = await manifestWriteGuards(slug, tenant.id, {
      kind: "operator_provisioning",
      operatorAuthUserId: input.operator.authUserId,
      operatorEmail: input.operator.email,
      targetTenantId: tenant.id,
      reason: `provision ${slug}`,
    });
    if (!guard.ok) return failRun(guard.status, guard.error, guard.reason ?? guard.error);
    await run.step("Checked the workspace address and recorded the operator action");

    // 7. Save (versioned; persistence writes the manifest audit row). The diff
    // is taken against what is stored, so the audit row records what changed,
    // and the save is pinned to the version read above.
    const saved = await saveManifest({
      slug,
      next: manifest,
      diff: diffManifests(stored?.manifest ?? UNPROVISIONED_SEED, manifest),
      actor: { type: "user", id: input.operator.authUserId },
      message: `${stored ? "Set up again" : "Provisioned"} by OASIS (${input.departments.join(", ")})`,
      tenant_id: tenant.id,
      ...(stored ? { if_version: stored.version } : {}),
    });
    await run.step(`Saved the workspace setup (version ${saved.row.version})`);
    if (stored) {
      const own = manifest.agents.filter((a) => !DEPARTMENT_TEAMMATE_SLUGS.has(a.slug)).length;
      await run.step(
        `Kept the workspace's own name, pages and saved prompts` +
          (own ? `, and ${own} teammate${own === 1 ? "" : "s"} it added` : ""),
      );
    }

    // 8. Members who joined before setup have no agents: give them the team.
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

    // 9. Done.
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
    if (err instanceof ManifestPersistenceError && err.code === "version_conflict") {
      return failRun(
        409,
        "setup_changed",
        "This workspace's setup changed while this ran, so nothing was saved. Reload the page and try again.",
      );
    }
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
