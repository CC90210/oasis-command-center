import type { SupabaseClient } from "@supabase/supabase-js";
import { getClientProfileSlugForBrand } from "./client-profiles";
import { getTursoClient, tursoConfigured } from "./turso";

type ProvisioningInput = {
  db: SupabaseClient;
  tenantId: string;
  profileId: string;
  brand?: string | null;
  email?: string | null;
};

export async function applyClientProvisioningProfile({
  db,
  tenantId,
  profileId,
  brand,
  email,
}: ProvisioningInput): Promise<{ clientProfileSlug: string | null; primaryAgent: string | null }> {
  const clientProfileSlug = getClientProfileSlugForBrand(brand, email);
  if (!clientProfileSlug) {
    return { clientProfileSlug: null, primaryAgent: null };
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
