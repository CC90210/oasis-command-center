#!/usr/bin/env node
/**
 * set-member-role.mjs — grant/change a SunBiz (or any tenant) member's team_role.
 *
 * Mirrors the app's setMemberRole() (lib/team.ts): updates user_profiles.team_role
 * via the service-role Supabase client. Safe by default (dry-run); pass --apply to write.
 *
 * USAGE (run where the service-role creds are available — VPS .env.agents, or
 *        `vercel env pull` locally, or Vercel-linked env):
 *
 *   node --env-file=.env.local scripts/set-member-role.mjs \
 *        --email jordan@sunbizfunding.com --role admin --tenant sun
 *
 *   # then add --apply once the dry-run preview looks right:
 *   node --env-file=.env.local scripts/set-member-role.mjs \
 *        --email jordan@sunbizfunding.com --role admin --tenant sun --apply
 *
 * REQUIRES env: BRAVO_SUPABASE_URL, BRAVO_SUPABASE_SERVICE_ROLE_KEY
 * VALID ROLES: owner | admin | loan_officer | processor | read_only | member
 */
import { createClient } from "@supabase/supabase-js";

const ROLES = ["owner", "admin", "loan_officer", "processor", "read_only", "member"];

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}
const email = (arg("email") || "").trim().toLowerCase();
const role = (arg("role") || "admin").trim();
const tenantSlug = (arg("tenant") || "sun").trim();
const apply = process.argv.includes("--apply");

if (!email) { console.error("ERROR: --email is required"); process.exit(1); }
if (!ROLES.includes(role)) { console.error(`ERROR: --role must be one of ${ROLES.join(", ")}`); process.exit(1); }

const url = process.env.BRAVO_SUPABASE_URL;
const key = process.env.BRAVO_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("ERROR: BRAVO_SUPABASE_URL and BRAVO_SUPABASE_SERVICE_ROLE_KEY must be set in the environment.");
  console.error("Tip: run with `node --env-file=.env.local` after `vercel env pull`, or run on the VPS where .env.agents has them.");
  process.exit(2);
}
const db = createClient(url, key, { auth: { persistSession: false } });

// Resolve tenant
// Resolve tenant by slug OR custom_fields.command_center_profile_slug. SunBiz is
// stored as tenants.slug='submissions' with command_center_profile_slug='sun', so a
// naive .eq("slug","sun") misses it — mirror provision_secrets._resolve_tenant.
async function resolveTenantId(client, wanted) {
  const direct = await client.from("tenants").select("id").eq("slug", wanted).limit(1).maybeSingle();
  if (direct.data?.id) return direct.data.id;
  const all = await client.from("tenants").select("id, custom_fields");
  for (const row of (all.data || [])) {
    const cf = row.custom_fields || {};
    if (cf.command_center_profile_slug === wanted) return row.id;
  }
  return null;
}
const tenantId = await resolveTenantId(db, tenantSlug);
if (!tenantId) { console.error(`ERROR: tenant "${tenantSlug}" not found by slug or command_center_profile_slug.`); process.exit(3); }

// Resolve member profile by email within tenant
const p = await db.from("user_profiles")
  .select("id, email, full_name, team_role, is_owner, auth_user_id, tenant_id")
  .eq("tenant_id", tenantId)
  .ilike("email", email)
  .maybeSingle();

if (p.error) { console.error(`ERROR querying profile: ${p.error.message}`); process.exit(4); }
if (!p.data) {
  console.error(`NOT FOUND: no user_profiles row for ${email} in tenant "${tenantSlug}".`);
  console.error("If they were invited but never finished signup, their invite likely needs redemption first (see Emily-repair flow / redeem_tenant_invite).");
  process.exit(5);
}

console.log("Tenant:", { slug: t.data.slug, name: t.data.name });
console.log("Member (before):", { email: p.data.email, full_name: p.data.full_name, team_role: p.data.team_role, is_owner: p.data.is_owner });

if (p.data.is_owner && role !== "owner") {
  console.error("REFUSING: target is the tenant owner; demoting the owner is blocked (matches app guard).");
  process.exit(6);
}
if (p.data.team_role === role) {
  console.log(`No change needed — already ${role}.`);
  process.exit(0);
}

if (!apply) {
  console.log(`\nDRY RUN — would set team_role: "${p.data.team_role}" -> "${role}".`);
  console.log("Re-run with --apply to write the change.");
  process.exit(0);
}

const upd = await db.from("user_profiles").update({ team_role: role }).eq("id", p.data.id).select("id, email, team_role").maybeSingle();
if (upd.error) { console.error(`ERROR updating role: ${upd.error.message}`); process.exit(7); }
console.log("Member (after):", { email: upd.data.email, team_role: upd.data.team_role });
console.log(`\n✅ Done — ${email} is now "${role}" in tenant "${tenantSlug}".`);
