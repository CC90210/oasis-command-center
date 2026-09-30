import type { SupabaseClient } from "@supabase/supabase-js";
import { getClientCommandCenterProfileById } from "./client-profiles";
import { getTursoClient, tursoConfigured } from "./turso";

/** Registered profile ids that belong to OASIS itself, never to a client. */
export const OASIS_ONLY_PROFILE_IDS: ReadonlySet<string> = new Set(["default", "oasis-ai-cc"]);

/**
 * Shells of retired workspaces. "sun" is SunBiz's (retired 2026-09-28): its
 * nav, the solara/helios agents and a dedicated Turso backend. Writing it onto
 * any workspace would re-couple SunBiz and show its agents to a client, so it
 * is never written again, whoever asks.
 */
export const RETIRED_PROFILE_IDS: ReadonlySet<string> = new Set(["sun"]);

/**
 * Shells a BRAND-NEW workspace may start with (the setup CLI,
 * app/api/auth/provision-cli). An allowlist, so a shell added to
 * lib/client-profiles.ts later is refused until someone decides it is a
 * client shell. Empty today: every registered shell is OASIS's own
 * (default, oasis-ai-cc), a retired workspace's (sun), or one named client's
 * (suga, whose brand and Maven agent belong to that one client). A new
 * workspace is set up at /admin/installs instead (lib/provisioning).
 */
export const NEW_WORKSPACE_SHELL_IDS: ReadonlySet<string> = new Set<string>();

/**
 * Why the setup CLI may not give a new workspace `slug` as its shell, or null
 * when it may. A sentence, for the CLI's 400.
 */
export function newWorkspaceShellRefusal(slug: string): string | null {
  if (NEW_WORKSPACE_SHELL_IDS.has(slug)) return null;
  if (getClientCommandCenterProfileById(slug).id !== slug) return `"${slug}" is not a registered shell.`;
  if (OASIS_ONLY_PROFILE_IDS.has(slug)) return `"${slug}" is OASIS's own shell, not a client shell.`;
  if (RETIRED_PROFILE_IDS.has(slug)) return `"${slug}" belongs to a retired workspace and is never given to another one.`;
  return `"${slug}" belongs to one named client and is not given to a new workspace. Set the workspace up at /admin/installs.`;
}

type ProvisioningInput = {
  db: SupabaseClient;
  tenantId: string;
  profileId: string;
  /**
   * The shell to give this tenant, chosen explicitly by whoever provisions it
   * (an operator). Omitted -> nothing is written. It must be a registered
   * profile id in lib/client-profiles.ts; anything else throws.
   *
   * This replaced deriving the shell from brand text (P0-8, 2026-09-28): a
   * "Sunrise Funding" signup got SunBiz's shell because its brand contained
   * "sun" and "funding".
   */
  clientProfileSlug?: string | null;
  /** @deprecated Ignored — brand text no longer selects a shell (P0-8). */
  brand?: string | null;
  /** @deprecated Ignored — see `brand`. */
  email?: string | null;
};

export async function applyClientProvisioningProfile({
  db,
  tenantId,
  profileId,
  clientProfileSlug: requestedSlug,
}: ProvisioningInput): Promise<{ clientProfileSlug: string | null; primaryAgent: string | null }> {
  const clientProfileSlug = (requestedSlug || "").trim().toLowerCase();
  if (!clientProfileSlug) {
    return { clientProfileSlug: null, primaryAgent: null };
  }
  // getClientCommandCenterProfileById degrades an unknown id to the default
  // profile; a typo'd slug must fail here rather than write a shell no code
  // path recognises.
  if (getClientCommandCenterProfileById(clientProfileSlug).id !== clientProfileSlug) {
    throw new Error(`applyClientProvisioningProfile: unknown client profile "${clientProfileSlug}"`);
  }
  // OASIS's own shells are not client shells. "oasis-ai-cc" resolves to OASIS's
  // seed manifest (its nav, its agents), so writing it onto another workspace
  // would hand that workspace OASIS's command center.
  if (OASIS_ONLY_PROFILE_IDS.has(clientProfileSlug)) {
    throw new Error(`applyClientProvisioningProfile: "${clientProfileSlug}" is OASIS's own shell, not a client shell`);
  }
  if (RETIRED_PROFILE_IDS.has(clientProfileSlug)) {
    throw new Error(`applyClientProvisioningProfile: "${clientProfileSlug}" is a retired workspace's shell and is never written again`);
  }

  const tenantRes = await db
    .from("tenants")
    .select("custom_fields")
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantRes.error) throw tenantRes.error;

  const existingCustomFields = (tenantRes.data?.custom_fields || {}) as Record<string, unknown>;
  const existingProfileSlug =
    typeof existingCustomFields.command_center_profile_slug === "string"
      ? existingCustomFields.command_center_profile_slug.trim().toLowerCase()
      : null;
  if (existingProfileSlug) {
    return { clientProfileSlug: existingProfileSlug, primaryAgent: null };
  }

  const isDedicated = clientProfileSlug === "sun" || clientProfileSlug === "suga";
  const customFields = {
    ...existingCustomFields,
    command_center_profile_slug: clientProfileSlug,
    data_backend: isDedicated ? "turso" : "supabase",
    deployment_mode: isDedicated ? "dedicated" : "shared",
  };

  const tenantUpdate = await db
    .from("tenants")
    .update({ custom_fields: customFields })
    .eq("id", tenantId);
  if (tenantUpdate.error) throw tenantUpdate.error;

  const profileAgentMap: Record<string, { primary: string; enabled: string[] }> = {
    sun: {
      // Operational primary (Solara) + sales-facing sub-agent (Helios).
      // Old config enabled "suga_sean" on the sun profile — that was a copy
      // mistake; SunBiz never shipped the Suga client agent.
      primary: "solara",
      enabled: ["solara", "helios"],
    },
    suga: {
      // Brand-command work folds into Maven (CMO). Lyra package retired
      // 2026-05-14 — single tenant doesn't justify a forked agent line.
      primary: "maven",
      enabled: ["maven"],
    },
  };
  const agentConfig = profileAgentMap[clientProfileSlug];
  const primaryAgent = agentConfig?.primary ?? null;

  if (primaryAgent) {
    const profileRes = await db
      .from("user_profiles")
      .select("agents_enabled")
      .eq("id", profileId)
      .maybeSingle();
    if (profileRes.error) throw profileRes.error;

    const agents = new Set<string>(profileRes.data?.agents_enabled || []);
    for (const agent of agentConfig.enabled) {
      agents.add(agent);
    }
    const profileUpdate = await db
      .from("user_profiles")
      .update({
        primary_agent: primaryAgent,
        agents_enabled: Array.from(agents),
        // Brand-hinted signups have already chosen their profile by
        // brand name; the industry-template wizard would just ask
        // redundant questions. Mark onboarding complete so middleware
        // doesn't bounce them through /onboarding/wizard.
        onboarding_completed_at: new Date().toISOString(),
      })
      .eq("id", profileId);
    if (profileUpdate.error) throw profileUpdate.error;

    return { clientProfileSlug, primaryAgent };
  }

  return { clientProfileSlug, primaryAgent: null };
}

export async function startProvisioningRun(tenantId: string, stripeInvoice?: string) {
  if (!tursoConfigured()) return;
  const db = getTursoClient();
  await db.execute({
    sql: `INSERT INTO provisioning_runs (tenant_id, stripe_invoice, status, started_at, steps_json)
          VALUES (?, ?, 'pending', datetime('now'), '[]')`,
    args: [tenantId, stripeInvoice || null],
  });
}

export async function updateProvisioningRun(
  tenantId: string,
  status: "pending" | "provisioning" | "complete" | "failed",
  stepTitle?: string,
  errorMessage?: string
) {
  if (!tursoConfigured()) return;
  const db = getTursoClient();

  if (stepTitle) {
    const r = await db.execute({
      sql: `SELECT steps_json FROM provisioning_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`,
      args: [tenantId],
    });
    const run = r.rows[0];
    if (run) {
      const steps = JSON.parse(String(run.steps_json || "[]"));
      steps.push({ title: stepTitle, time: new Date().toISOString() });
      await db.execute({
        sql: `UPDATE provisioning_runs SET steps_json = ?, status = ? WHERE tenant_id = ? AND created_at = (SELECT MAX(created_at) FROM provisioning_runs WHERE tenant_id = ?)`,
        args: [JSON.stringify(steps), status, tenantId, tenantId],
      });
    }
  } else {
    await db.execute({
      sql: `UPDATE provisioning_runs SET status = ? WHERE tenant_id = ? AND created_at = (SELECT MAX(created_at) FROM provisioning_runs WHERE tenant_id = ?)`,
      args: [status, tenantId, tenantId],
    });
  }

  if (status === "complete") {
    await db.execute({
      sql: `UPDATE provisioning_runs SET completed_at = datetime('now') WHERE tenant_id = ? AND created_at = (SELECT MAX(created_at) FROM provisioning_runs WHERE tenant_id = ?)`,
      args: [tenantId, tenantId],
    });
  }
  if (errorMessage) {
    await db.execute({
      sql: `UPDATE provisioning_runs SET error_message = ? WHERE tenant_id = ? AND created_at = (SELECT MAX(created_at) FROM provisioning_runs WHERE tenant_id = ?)`,
      args: [errorMessage, tenantId, tenantId],
    });
  }
}
