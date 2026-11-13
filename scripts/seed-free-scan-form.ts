#!/usr/bin/env node
/**
 * seed-free-scan-form.ts — create/refresh the form behind the free scan's offer
 * (lib/forms/oasis-free-scan-seed.ts, lib/site-scan/offer.ts): the details a
 * visitor sends with their scan, filed under the scan rather than the AI audit.
 *
 * Sibling of seed-ai-audit-funnel.ts, kept separate so seeding one form can
 * never overwrite the other. Idempotent: upserts the forms row by
 * (tenant_id, slug). Editing the seed file changes nothing until this runs.
 *
 * Run (Business-Empire-Agent's wrapper injects the credentials):
 *   python scripts/run_seed_oasis_forms.py --only free-scan            # dry run
 *   python scripts/run_seed_oasis_forms.py --only free-scan --apply
 */
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";
import { tursoConfigured } from "../lib/turso";
import { parseFormSteps, parseFormBranding } from "../lib/forms/types";
import { AI_AUDIT_TENANT_SLUG } from "../lib/forms/oasis-ai-audit-seed";
import { buildFreeScanFormRow } from "../lib/forms/oasis-free-scan-seed";
import { SCAN_OFFER_SLUG } from "../lib/site-scan/offer";

// The same server-only opt-in and data-plane checks as seed-ai-audit-funnel.ts.
createRequire(import.meta.url)("./allow-server-only.cjs");

const apply = process.argv.includes("--apply");

if (process.env.EMPIRE_DATA_BACKEND === "turso_cloud") {
  if (!tursoConfigured()) {
    console.error("ERROR: EMPIRE_DATA_BACKEND=turso_cloud but Turso is not configured. Run it through Business-Empire-Agent/scripts/run_seed_oasis_forms.py.");
    process.exit(2);
  }
} else if (!process.env.BRAVO_SUPABASE_URL || !process.env.BRAVO_SUPABASE_SERVICE_ROLE_KEY) {
  console.error("ERROR: no data backend configured. Run it through Business-Empire-Agent/scripts/run_seed_oasis_forms.py.");
  process.exit(2);
}

async function resolveTenantId(db: SupabaseClient, wanted: string): Promise<string | null> {
  const direct = await db.from("tenants").select("id").eq("slug", wanted).limit(1).maybeSingle();
  if (direct.data?.id) return direct.data.id as string;
  const all = await db.from("tenants").select("id, custom_fields");
  for (const t of (all.data || []) as Array<{ id: string; custom_fields: Record<string, unknown> | null }>) {
    if ((t.custom_fields || {}).command_center_profile_slug === wanted) return t.id;
  }
  return null;
}

async function main() {
  const { getServiceSupabase } = await import("../lib/supabase-server");
  const db = getServiceSupabase();
  const tenantId = await resolveTenantId(db, AI_AUDIT_TENANT_SLUG);
  if (!tenantId) {
    console.error(`ERROR: tenant "${AI_AUDIT_TENANT_SLUG}" not found.`);
    process.exit(3);
  }
  const row = buildFreeScanFormRow(tenantId);
  parseFormSteps(row.steps);
  parseFormBranding(row.branding);
  const existing = await db.from("forms").select("id, slug, enabled").eq("tenant_id", tenantId).eq("slug", SCAN_OFFER_SLUG).maybeSingle();

  console.log(`tenant     : ${AI_AUDIT_TENANT_SLUG} (${tenantId})`);
  console.log(`form slug  : ${SCAN_OFFER_SLUG} — ${existing.data ? "EXISTS (will update)" : "NEW (will insert)"}`);
  console.log(`steps      : ${row.steps.length}, fields: ${row.steps.reduce((n, s) => n + s.fields.length, 0)}`);
  console.log("page       : /scan (the scan itself; the form's own /f/ address redirects there)");

  if (!apply) {
    console.log("\nDRY RUN — re-run with --apply to write.");
    return;
  }
  const res = await db.from("forms").upsert(row, { onConflict: "tenant_id,slug" }).select("id, slug").maybeSingle();
  if (res.error) {
    console.error(`ERROR upserting form: ${res.error.message}`);
    process.exit(5);
  }
  console.log(`\nSeeded form "${SCAN_OFFER_SLUG}" (id ${res.data?.id}) for ${AI_AUDIT_TENANT_SLUG}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
