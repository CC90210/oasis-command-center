#!/usr/bin/env node
/**
 * seed-ai-audit-funnel.ts — create/refresh the OASIS AI Solutions B2B
 * qualification funnel (/f/oasis-ai-cc/ai-audit).
 *
 * Sibling of seed-oasis-funnel.ts, deliberately kept as a separate script so
 * seeding one funnel can never overwrite the other. Idempotent: upserts the
 * `forms` row by (tenant_id, slug).
 *
 * EDITING lib/forms/oasis-ai-audit-seed.ts CHANGES NOTHING UNTIL THIS RUNS.
 * The live definition lives in the `forms` table; the file is only the source
 * of truth for what SHOULD be there. (This has bitten before — see
 * memory/PATTERNS.md on DB-driven form re-seeds.)
 *
 * Run:
 *   node --env-file=.env.local --import tsx scripts/seed-ai-audit-funnel.ts          # dry run
 *   node --env-file=.env.local --import tsx scripts/seed-ai-audit-funnel.ts --apply
 *
 * REQUIRES: BRAVO_SUPABASE_URL, BRAVO_SUPABASE_SERVICE_ROLE_KEY.
 */
import { createClient } from "@supabase/supabase-js";
import { parseFormSteps, parseFormBranding } from "../lib/forms/types";
import {
  AI_AUDIT_SLUG,
  AI_AUDIT_TENANT_SLUG,
  buildAiAuditFunnelRow,
} from "../lib/forms/oasis-ai-audit-seed";

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
  for (const t of (all.data || []) as Array<{
    id: string;
    custom_fields: Record<string, unknown> | null;
  }>) {
    const cf = t.custom_fields || {};
    if ((cf as Record<string, unknown>).command_center_profile_slug === wanted) return t.id;
  }
  return null;
}

async function main() {
  const tenantId = await resolveTenantId(AI_AUDIT_TENANT_SLUG);
  if (!tenantId) {
    console.error(`ERROR: tenant "${AI_AUDIT_TENANT_SLUG}" not found.`);
    process.exit(3);
  }

  const row = buildAiAuditFunnelRow(tenantId);

  // Validate through the same parsers the API + renderer use, so a malformed
  // field type is caught here rather than at the first real prospect submit.
  parseFormSteps(row.steps);
  parseFormBranding(row.branding);

  const existing = await db
    .from("forms")
    .select("id, slug, enabled")
    .eq("tenant_id", tenantId)
    .eq("slug", AI_AUDIT_SLUG)
    .maybeSingle();

  // (A runtime `AI_AUDIT_SLUG === "start"` guard was removed: tsc proves the
  // literal type can never be "start", so the check was unreachable. The real
  // protection is that this script and seed-oasis-funnel.ts each import their
  // own slug constant and touch only that row.)

  console.log(`tenant     : ${AI_AUDIT_TENANT_SLUG} (${tenantId})`);
  console.log(
    `form slug  : ${AI_AUDIT_SLUG} — ${existing.data ? "EXISTS (will update)" : "NEW (will insert)"}`,
  );
  console.log(
    `steps      : ${row.steps.length}, fields: ${row.steps.reduce((n, s) => n + s.fields.length, 0)}`,
  );
  console.log(
    `public URL : ${(process.env.OASIS_PUBLIC_ORIGIN || "https://oasisai.work").replace(/\/$/, "")}/f/${AI_AUDIT_TENANT_SLUG}/${AI_AUDIT_SLUG}`,
  );

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
  console.log(`\n✅ Seeded form "${AI_AUDIT_SLUG}" (id ${res.data?.id}) for ${AI_AUDIT_TENANT_SLUG}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
