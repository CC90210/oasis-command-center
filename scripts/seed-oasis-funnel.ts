#!/usr/bin/env node
/**
 * seed-oasis-funnel.ts — create/refresh CC's personal-brand funnel form.
 *
 * Idempotent: upserts the `forms` row by (tenant_id, slug). Safe to re-run —
 * editing lib/forms/oasis-funnel-seed.ts then re-running pushes the new shape.
 *
 * The form shape is the single source of truth in
 * lib/forms/oasis-funnel-seed.ts; this script just validates + writes it.
 *
 * Run (after `vercel env pull` so .env.local has service-role creds, or on the
 * VPS where the secrets file is present):
 *   node --env-file=.env.local --import tsx scripts/seed-oasis-funnel.ts        # dry run
 *   node --env-file=.env.local --import tsx scripts/seed-oasis-funnel.ts --apply
 *
 * REQUIRES: BRAVO_SUPABASE_URL, BRAVO_SUPABASE_SERVICE_ROLE_KEY.
 */
import { createClient } from "@supabase/supabase-js";
import { parseFormSteps, parseFormBranding } from "../lib/forms/types";
import {
  OASIS_FUNNEL_SLUG,
  OASIS_FUNNEL_TENANT_SLUG,
  buildOasisFunnelRow,
} from "../lib/forms/oasis-funnel-seed";

const apply = process.argv.includes("--apply");

const url = process.env.BRAVO_SUPABASE_URL;
const key = process.env.BRAVO_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(
    "ERROR: BRAVO_SUPABASE_URL + BRAVO_SUPABASE_SERVICE_ROLE_KEY required " +
      "(run with --env-file=.env.local after `vercel env pull`, or on the VPS).",
  );
  process.exit(2);
}
const db = createClient(url, key, { auth: { persistSession: false } });

async function resolveTenantId(wanted: string): Promise<string | null> {
  const direct = await db.from("tenants").select("id").eq("slug", wanted).limit(1).maybeSingle();
  if (direct.data?.id) return direct.data.id as string;
  const all = await db.from("tenants").select("id, custom_fields");
  for (const t of (all.data || []) as Array<{ id: string; custom_fields: Record<string, unknown> | null }>) {
    const cf = t.custom_fields || {};
    if ((cf as Record<string, unknown>).command_center_profile_slug === wanted) return t.id;
  }
  return null;
}

async function main() {
  const tenantId = await resolveTenantId(OASIS_FUNNEL_TENANT_SLUG);
  if (!tenantId) {
    console.error(`ERROR: tenant "${OASIS_FUNNEL_TENANT_SLUG}" not found.`);
    process.exit(3);
  }

  const row = buildOasisFunnelRow(tenantId);

  // Validate the shape through the same parsers the API + renderer use, so a
  // malformed show_if/field is caught here — not at first prospect submit.
  parseFormSteps(row.steps);
  parseFormBranding(row.branding);

  const existing = await db
    .from("forms")
    .select("id, slug, enabled")
    .eq("tenant_id", tenantId)
    .eq("slug", OASIS_FUNNEL_SLUG)
    .maybeSingle();

  console.log(`tenant: ${OASIS_FUNNEL_TENANT_SLUG} (${tenantId})`);
  console.log(`form slug: ${OASIS_FUNNEL_SLUG} — ${existing.data ? "EXISTS (will update)" : "NEW (will insert)"}`);
  console.log(`steps: ${row.steps.length}, fields: ${row.steps.reduce((n, s) => n + s.fields.length, 0)}`);
  console.log(`public URL: ${(process.env.OASIS_PUBLIC_ORIGIN || "https://oasisai.work").replace(/\/$/, "")}/f/${OASIS_FUNNEL_TENANT_SLUG}/${OASIS_FUNNEL_SLUG}`);

  if (!apply) {
    console.log("\nDRY RUN — re-run with --apply to write.");
    return;
  }

  const res = await db
    .from("forms")
    .upsert(row, { onConflict: "tenant_id,slug" })
    .select("id, slug")
    .maybeSingle();
  if (res.error) {
    console.error(`ERROR upserting form: ${res.error.message}`);
    process.exit(5);
  }
  console.log(`\n✅ Seeded form "${OASIS_FUNNEL_SLUG}" (id ${res.data?.id}) for ${OASIS_FUNNEL_TENANT_SLUG}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
