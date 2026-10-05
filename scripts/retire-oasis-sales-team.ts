/**
 * One-time: deactivate the retired OASIS sales reps (CC, 2026-09-24).
 *
 * CC retired the sales team; the reps are DEACTIVATED, never deleted, through
 * the exact code path the Settings → Team toggle uses (lib/team-activation.ts),
 * so this run and every future toggle behave the same. Their leads follow CC's
 * disposition: early-stage → Leads pool, warm → board unassigned, closed →
 * kept for history.
 *
 *   node --conditions=react-server --import tsx scripts/retire-oasis-sales-team.ts            (dry run)
 *   node --conditions=react-server --import tsx scripts/retire-oasis-sales-team.ts --apply
 *
 * Safe to re-run: an already-inactive rep only gets the lead sweep again.
 * Reversible per person from /team (reactivate), except that moved leads are
 * not handed back — that part is the founders' call.
 */

import { loadEnvConfig } from "@next/env";

// The hybrid data client falls back to the retired Supabase path unless this
// is exactly turso_cloud. Pin it BEFORE any data module is imported.
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
loadEnvConfig(process.cwd());

const RETIRED = ["ariel", "ethan perez", "jasper van veen", "yaacov azoulay"];
const FOUNDER_EMAIL = "conaugh@oasisai.work";

async function main() {
  const apply = process.argv.includes("--apply");
  const { tursoConfigured } = await import("../lib/turso");
  if (!tursoConfigured()) throw new Error("turso_not_configured: refusing to run without the Turso data client");

  const { getServiceSupabase } = await import("../lib/supabase-server");
  const { WEBDEV_TENANT_ID } = await import("../lib/web-leads/tenant");
  const { deactivateMember, previewDeactivation } = await import("../lib/team-activation");

  const db = getServiceSupabase();
  const { data, error } = await db
    .from("user_profiles")
    .select("id, auth_user_id, email, full_name, team_role, is_owner, deactivated_at")
    .eq("tenant_id", WEBDEV_TENANT_ID);
  if (error) throw new Error(`profile_read_failed: ${error.message}`);
  const profiles = (data || []) as Array<{
    id: string;
    auth_user_id: string | null;
    email: string;
    full_name: string | null;
    team_role: string;
    is_owner: boolean | null;
    deactivated_at: string | null;
  }>;

  const founder = profiles.find((p) => p.email.trim().toLowerCase() === FOUNDER_EMAIL && p.auth_user_id);
  if (!founder) throw new Error("founder_profile_not_found");
  const actor = {
    authUserId: founder.auth_user_id as string,
    profileId: founder.id,
    tenantId: WEBDEV_TENANT_ID,
    teamRole: "owner" as const,
    isOwner: true,
    adminAccess: true,
  };

  const matches = (p: (typeof profiles)[number]) => {
    const name = (p.full_name || "").trim().toLowerCase();
    const local = p.email.split("@")[0].trim().toLowerCase();
    return RETIRED.includes(name) || RETIRED.includes(local);
  };
  const targets = profiles.filter((p) => matches(p) && !p.is_owner);
  // Exactly one profile per retired name, or stop: a fuzzy match that caught
  // the wrong person would lock out someone who still works here.
  for (const name of RETIRED) {
    const hits = targets.filter(
      (p) => (p.full_name || "").trim().toLowerCase() === name || p.email.split("@")[0].toLowerCase() === name,
    );
    if (hits.length !== 1) throw new Error(`expected exactly one profile for "${name}", found ${hits.length}`);
  }

  console.log(`${apply ? "APPLY" : "DRY RUN"} — retiring ${targets.length} reps as ${FOUNDER_EMAIL}\n`);
  for (const target of targets) {
    const label = `${target.full_name || target.email} <${target.email}> (${target.team_role})`;
    if (!apply) {
      const impact = await previewDeactivation({ tenantId: WEBDEV_TENANT_ID, targetProfileId: target.id, actor });
      console.log(
        `${label}: ${impact.active ? "active" : "already inactive"} · leads → pool ${impact.leads.pool}, ` +
          `board ${impact.leads.board}, keep ${impact.leads.keep} · unpaid commission lines ${impact.unpaidCommissions}`,
      );
      continue;
    }
    const result = await deactivateMember({
      tenantId: WEBDEV_TENANT_ID,
      targetProfileId: target.id,
      actor,
      reason: "OASIS sales team retired 2026-09-24 (CC)",
    });
    console.log(
      `${label}: deactivated · login ${result.loginBlocked ? "blocked" : `kept (${result.loginNote})`} · ` +
        `released to pool ${result.released}/${result.impact.leads.pool} · ` +
        `kept on board unassigned ${result.boardUnassigned}/${result.impact.leads.board} · ` +
        `kept for history ${result.impact.leads.keep} · refused ${result.refused.length}` +
        (result.refused.length ? ` [${result.refused.join(", ")}]` : ""),
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
