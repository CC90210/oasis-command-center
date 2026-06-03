#!/usr/bin/env node
/**
 * set-manifest-flag.mjs — flip a UI flag on a tenant's LIVE manifest.
 *
 * The manifest seed (lib/manifest/seeds.ts) only applies to NEW tenants /
 * re-seeds; an existing tenant's manifest lives in tenant_manifests.manifest
 * (JSONB). This patches manifest.ui.<flag> for a given tenant slug.
 *
 * Primary use: enable the CLI / chat-mode picker for SunBiz employees:
 *   node --env-file=.env.local scripts/set-manifest-flag.mjs \
 *        --tenant sun --flag advanced_picker --value true            # preview
 *   node --env-file=.env.local scripts/set-manifest-flag.mjs \
 *        --tenant sun --flag advanced_picker --value true --apply    # write
 *
 * Runs wherever the service-role creds exist (VPS secrets file, or local
 * after `vercel env pull`). REQUIRES: BRAVO_SUPABASE_URL, BRAVO_SUPABASE_SERVICE_ROLE_KEY.
 */
import { createClient } from "@supabase/supabase-js";

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const slug = (arg("tenant") || "sun").trim();
const flag = (arg("flag") || "advanced_picker").trim();
const rawValue = (arg("value") || "true").trim().toLowerCase();
const value = rawValue === "true" ? true : rawValue === "false" ? false : rawValue;
const apply = process.argv.includes("--apply");

const url = process.env.BRAVO_SUPABASE_URL;
const key = process.env.BRAVO_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("ERROR: BRAVO_SUPABASE_URL + BRAVO_SUPABASE_SERVICE_ROLE_KEY required (run with --env-file or on the VPS).");
  process.exit(2);
}
const db = createClient(url, key, { auth: { persistSession: false } });

// Resolve tenant by slug OR custom_fields.command_center_profile_slug.
// SunBiz is stored as tenants.slug='submissions' with command_center_profile_slug='sun',
// so a naive .eq("slug","sun") misses it — mirror provision_secrets._resolve_tenant.
const tenantId = await resolveTenantId(db, slug);
if (!tenantId) { console.error(`ERROR: tenant "${slug}" not found by slug or command_center_profile_slug.`); process.exit(3); }

async function resolveTenantId(client, wanted) {
  const direct = await client.from("tenants").select("id").eq("slug", wanted).limit(1).maybeSingle();
  if (direct.data?.id) return direct.data.id;
  const all = await client.from("tenants").select("id, custom_fields");
  for (const t of (all.data || [])) {
    const cf = t.custom_fields || {};
    if (cf.command_center_profile_slug === wanted) return t.id;
  }
  return null;
}

const r = await db.from("tenant_manifests").select("tenant_id, manifest").eq("tenant_id", tenantId).maybeSingle();
if (r.error || !r.data) { console.error(`ERROR: no tenant_manifests row for "${slug}".`); process.exit(4); }

const manifest = r.data.manifest || {};
const ui = { ...(manifest.ui || {}) };
const before = ui[flag];
console.log(`tenant: ${slug} (${tenantId})`);
console.log(`manifest.ui.${flag}: ${JSON.stringify(before)} -> ${JSON.stringify(value)}`);

if (before === value) { console.log("No change needed."); process.exit(0); }
if (!apply) { console.log("\nDRY RUN — re-run with --apply to write."); process.exit(0); }

ui[flag] = value;
const next = { ...manifest, ui };
const upd = await db.from("tenant_manifests").update({ manifest: next }).eq("tenant_id", tenantId).select("tenant_id").maybeSingle();
if (upd.error) { console.error(`ERROR updating manifest: ${upd.error.message}`); process.exit(5); }
console.log(`\n✅ Set manifest.ui.${flag} = ${JSON.stringify(value)} for "${slug}". Reload the dashboard to see it.`);
