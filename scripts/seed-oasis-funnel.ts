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
 * Run (the wrapper injects credentials from .env.agents — preferred):
 *   python C:\Users\User\Business-Empire-Agent\scripts\run_seed_oasis_forms.py             # dry run
 *   python C:\Users\User\Business-Empire-Agent\scripts\run_seed_oasis_forms.py --apply
 * Or directly, with the backend's credentials already in the environment:
 *   node --import tsx scripts/seed-oasis-funnel.ts        # dry run
 *   node --import tsx scripts/seed-oasis-funnel.ts --apply
 *
 * REQUIRES: whatever getServiceSupabase() requires for the active backend —
 * TURSO_DATABASE_URL + TURSO_AUTH_TOKEN under EMPIRE_DATA_BACKEND=turso_cloud
 * (production), otherwise BRAVO_SUPABASE_URL + BRAVO_SUPABASE_SERVICE_ROLE_KEY.
 */
import { createRequire } from "node:module";
import type { SupabaseClient } from "@supabase/supabase-js";
import { tursoConfigured } from "../lib/turso";
import { parseFormSteps, parseFormBranding } from "../lib/forms/types";
import {
  OASIS_FUNNEL_SLUG,
  OASIS_FUNNEL_TENANT_SLUG,
  buildOasisFunnelRow,
} from "../lib/forms/oasis-funnel-seed";

// This script used to build its OWN supabase-js client from BRAVO_SUPABASE_*.
// Production is Turso; Supabase is retired. So that client pointed at nothing
// and the script died on "tenant not found" — meaning form edits could not be
// pushed live by the only tooling that pushes them. Both live OASIS funnels
// consequently kept a retired on_complete_stage long after the code default was
// fixed, and every inbound lead landed in a pipeline column that does not
// render. Use the app's accessor so the seeder follows the app's data plane.
//
// lib/supabase-server.ts transitively imports lib/r2-storage.ts, which carries
// `import "server-only"` — that throws outside a bundler. scripts/allow-server-only.cjs
// is the repo's existing opt-in for exactly this case. Loading it here rather
// than requiring a `--require` flag on the command line keeps plain
// `node --import tsx scripts/...` working for every caller, including
// Business-Empire-Agent/scripts/run_seed_oasis_forms.py.
createRequire(import.meta.url)("./allow-server-only.cjs");

const apply = process.argv.includes("--apply");

// Fail fast, and name the vars the ACTIVE backend actually needs. Mirrors the
// two branches in lib/supabase-server.ts: turso_cloud + tursoConfigured() routes
// .from() to the Turso adapter, anything else builds a real Supabase client.
if (process.env.EMPIRE_DATA_BACKEND === "turso_cloud") {
  if (!tursoConfigured()) {
    console.error(
      "ERROR: EMPIRE_DATA_BACKEND=turso_cloud but Turso is not configured — set " +
        "TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (or TURSO_DB_PATH for a local file). " +
        "Easiest path: run Business-Empire-Agent/scripts/run_seed_oasis_forms.py, " +
        "which injects them from .env.agents.",
    );
    process.exit(2);
  }
} else if (!process.env.BRAVO_SUPABASE_URL || !process.env.BRAVO_SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "ERROR: no data backend configured — set EMPIRE_DATA_BACKEND=turso_cloud with " +
      "TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (production), or BRAVO_SUPABASE_URL + " +
      "BRAVO_SUPABASE_SERVICE_ROLE_KEY for a legacy Supabase target.",
  );
  process.exit(2);
}

async function resolveTenantId(db: SupabaseClient, wanted: string): Promise<string | null> {
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
  // Dynamic import: the server-only shim above must be installed BEFORE this
  // module graph loads, and esbuild hoists static imports above statements.
  const { getServiceSupabase } = await import("../lib/supabase-server");
  const db = getServiceSupabase();

  const tenantId = await resolveTenantId(db, OASIS_FUNNEL_TENANT_SLUG);
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
