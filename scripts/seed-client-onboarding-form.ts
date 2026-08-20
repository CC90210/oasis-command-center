#!/usr/bin/env node
/**
 * seed-client-onboarding-form.ts — create/refresh the OASIS client-onboarding
 * form on the `oasis-webdev` tenant.
 *
 * The form shape is the single source of truth in
 * lib/forms/oasis-client-onboarding-seed.ts; this script validates it through
 * the same parsers the public renderer and /api/forms/submit run, then writes
 * the `forms` row. Editing the seed file changes nothing until this runs.
 *
 * Run (dry run first — it prints the plan and writes nothing):
 *   node --conditions=react-server --env-file=.env.local --import tsx scripts/seed-client-onboarding-form.ts
 *   node --conditions=react-server --env-file=.env.local --import tsx scripts/seed-client-onboarding-form.ts --apply
 *
 * WHICH DATABASE. It writes wherever getServiceSupabase() points, which is
 * Turso when EMPIRE_DATA_BACKEND=turso_cloud — production, since the 2026-08-09
 * cutover. The variable is NOT defaulted here: a seed that silently picks a
 * backend is a seed that writes a client-facing form into the wrong database.
 * Set it explicitly (`.env.local` or the environment) or this refuses to run.
 *
 * SAFETY. On an existing form it updates the field SCHEMA only — name,
 * description, steps, step_outcomes, on_complete_stage — and preserves id,
 * slug, branding, enabled and redirect_url, so minted client links and any
 * theming survive. Same contract as scripts/reseed-sunbiz-forms.ts, and a
 * timestamped snapshot of the live row is written before any --apply.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { parseFormSteps, parseFormBranding } from "../lib/forms/types";
import {
  CLIENT_ONBOARDING_SLUG,
  CLIENT_ONBOARDING_TENANT_SLUG,
  CLIENT_ONBOARDING_STEPS,
  CLIENT_ONBOARDING_BRANDING,
  buildClientOnboardingRow,
} from "../lib/forms/oasis-client-onboarding-seed";
import { OASIS_LEAD_STAGE_KEYS } from "../lib/oasis-stage-meta";

const apply = process.argv.includes("--apply");

type FormRow = {
  id: string;
  slug: string;
  name: string | null;
  description: string | null;
  steps: unknown;
  step_outcomes: unknown;
  on_complete_stage: string | null;
  branding: unknown;
  enabled: boolean | null;
};

type TenantRow = { id: string; slug: string | null; custom_fields: Record<string, unknown> | null };

async function main(): Promise<void> {
  if (!process.env.EMPIRE_DATA_BACKEND) {
    console.error(
      "ERROR: EMPIRE_DATA_BACKEND is unset. Set it explicitly — 'turso_cloud' for\n" +
        "production (the live backend since 2026-08-09), or a Supabase value for a\n" +
        "legacy target. Guessing here would seed a client-facing form into the wrong\n" +
        "database.",
    );
    process.exit(2);
  }

  // Imported dynamically, after the env check: the factory reads the backend
  // variables at construction time and throws if the target is unconfigured.
  const { getServiceSupabase } = await import("../lib/supabase-server");
  const db = getServiceSupabase();

  // ---- Validate the definition BEFORE touching the database ---------------
  // A malformed show_if or an unknown field type is caught here rather than at
  // the first client's submit.
  const steps = parseFormSteps(CLIENT_ONBOARDING_STEPS);
  parseFormBranding(CLIENT_ONBOARDING_BRANDING);

  // on_complete_stage is written to the lead VERBATIM — updateRecord validates
  // the entity, never the stage value, so a typo becomes a phantom kanban
  // column and a bogus stage_entered_at that drip enrolment keys off. Nothing
  // downstream catches it, so it is caught here.
  const row0 = buildClientOnboardingRow("00000000-0000-0000-0000-000000000000");
  if (!OASIS_LEAD_STAGE_KEYS.includes(row0.on_complete_stage)) {
    console.error(
      `ERROR: on_complete_stage "${row0.on_complete_stage}" is not an OASIS lead stage.\n` +
        `Valid: ${OASIS_LEAD_STAGE_KEYS.join(", ")}`,
    );
    process.exit(3);
  }
  console.log(
    `✓ definition valid — ${steps.length} steps / ` +
      `${steps.reduce((n, s) => n + s.fields.length, 0)} fields, ` +
      `completes at stage "${row0.on_complete_stage}"\n`,
  );

  // ---- Resolve the tenant --------------------------------------------------
  // By slug, never by a hardcoded uuid: this repo has no verified tenant id for
  // oasis-webdev, and a wrong constant would seed a client-facing form into
  // another tenant's namespace.
  const direct = await db
    .from("tenants")
    .select("id, slug, custom_fields")
    .eq("slug", CLIENT_ONBOARDING_TENANT_SLUG)
    .limit(1)
    .maybeSingle();
  if (direct.error) {
    console.error(`ERROR reading tenants: ${direct.error.message}`);
    process.exit(4);
  }
  let tenantId = (direct.data as TenantRow | null)?.id ?? null;
  if (!tenantId) {
    // Same fallback scripts/seed-oasis-funnel.ts uses: some tenants carry the
    // command-center slug in custom_fields rather than in the slug column.
    const all = await db.from("tenants").select("id, slug, custom_fields");
    if (all.error) {
      console.error(`ERROR scanning tenants: ${all.error.message}`);
      process.exit(4);
    }
    for (const t of (all.data || []) as TenantRow[]) {
      const cf = (t.custom_fields || {}) as Record<string, unknown>;
      if (cf.command_center_profile_slug === CLIENT_ONBOARDING_TENANT_SLUG) {
        tenantId = t.id;
        break;
      }
    }
  }
  if (!tenantId) {
    console.error(
      `ERROR: tenant "${CLIENT_ONBOARDING_TENANT_SLUG}" not found in this backend ` +
        `(EMPIRE_DATA_BACKEND=${process.env.EMPIRE_DATA_BACKEND}).`,
    );
    process.exit(5);
  }

  const row = buildClientOnboardingRow(tenantId);
  const origin = (process.env.OASIS_PUBLIC_ORIGIN || "https://oasisai.work").replace(/\/$/, "");

  const existing = await db
    .from("forms")
    .select("id, slug, name, description, steps, step_outcomes, on_complete_stage, branding, enabled")
    .eq("tenant_id", tenantId)
    .eq("slug", CLIENT_ONBOARDING_SLUG)
    .maybeSingle();
  if (existing.error) {
    console.error(`ERROR reading the live form: ${existing.error.message}`);
    process.exit(6);
  }
  const live = (existing.data as FormRow | null) ?? null;

  console.log(`tenant:  ${CLIENT_ONBOARDING_TENANT_SLUG} (${tenantId})`);
  console.log(`form:    ${CLIENT_ONBOARDING_SLUG} — ${live ? `EXISTS (schema update, id ${live.id.slice(0, 8)})` : "NEW (insert)"}`);
  console.log(`public:  ${origin}/f/${CLIENT_ONBOARDING_TENANT_SLUG}/${CLIENT_ONBOARDING_SLUG}`);
  console.log(
    `client:  ${origin}/f/${CLIENT_ONBOARDING_TENANT_SLUG}/${CLIENT_ONBOARDING_SLUG}/<lead_token>  ` +
      `(mint via /api/forms/<id>/mint-link — prefills business_name, email, phone, industry)`,
  );
  console.log(
    "\nNOTE: an enabled form is fillable at its BARE public URL by anyone who has it,\n" +
      "and a submission there mints a NEW anonymous lead instead of attaching to the\n" +
      "intended client. There is no private-link-only mode in this codebase. Send\n" +
      "clients the minted /<lead_token> link, and treat bare-URL submissions as\n" +
      "untriaged inbound.",
  );

  if (!apply) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply.");
    return;
  }

  if (live) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    mkdirSync("tmp", { recursive: true });
    const backupPath = `tmp/client-onboarding-form-backup-${stamp}.json`;
    writeFileSync(
      backupPath,
      JSON.stringify({ captured_at: new Date().toISOString(), tenant_id: tenantId, form: live }, null, 2),
      "utf8",
    );
    console.log(`\n📦 Snapshot of the live form → ${backupPath}`);

    const upd = await db
      .from("forms")
      .update({
        name: row.name,
        description: row.description,
        steps: row.steps,
        step_outcomes: row.step_outcomes,
        on_complete_stage: row.on_complete_stage,
      })
      .eq("id", live.id)
      .select("id")
      .maybeSingle();
    if (upd.error) {
      console.error(`ERROR updating form: ${upd.error.message}`);
      process.exit(7);
    }
    console.log(`✅ Updated schema on form ${live.id} (branding / enabled / links preserved).`);
    console.log(`   Revert: restore steps/step_outcomes/on_complete_stage from ${backupPath}.`);
    return;
  }

  const ins = await db.from("forms").insert(row).select("id").maybeSingle();
  if (ins.error) {
    console.error(`ERROR inserting form: ${ins.error.message}`);
    process.exit(7);
  }
  console.log(`\n✅ Seeded "${CLIENT_ONBOARDING_SLUG}" (id ${(ins.data as { id: string } | null)?.id}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
