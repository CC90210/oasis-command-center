#!/usr/bin/env node
/**
 * reseed-sunbiz-forms.ts — push the canonical SunBiz form templates to the LIVE
 * `forms` rows so field-schema changes (multi-file dropzone, industry combobox,
 * name prefill, signature, removed confirmation) actually appear on the public
 * forms. Without this, /api/forms/templates/sunbiz only INSERTS new forms (409
 * on conflict) — it never updates the steps an existing form already serves, so
 * edits to lib/forms/sunbiz-templates.ts stay invisible to merchants.
 *
 * Source of truth: lib/forms/sunbiz-templates.ts (SUNBIZ_FORM_TEMPLATES) — the
 * SAME object the create-from-template button uses, so a re-seed and a fresh
 * create produce identical forms (no drift).
 *
 * Safety:
 *   - Validates every template's steps through parseFormSteps (the same parser
 *     /api/forms POST + the renderer run) BEFORE writing — a malformed field is
 *     caught here, not at the next merchant submit.
 *   - Snapshots each live form's CURRENT steps/outcomes/stage to a timestamped
 *     JSON backup before --apply, so a revert is a single restore.
 *   - Updates the field SCHEMA only (steps, step_outcomes, on_complete_stage,
 *     name, description). PRESERVES id, slug, branding, enabled, redirect_url —
 *     so existing minted links + the tenant's theme/logo survive untouched.
 *   - Same form id ⇒ already-sent links + recorded submissions are unaffected.
 *
 * Run (after `vercel env pull` so .env.local has service-role creds, or with the
 * creds in the environment — see scripts/run_reseed_sunbiz_forms.py):
 *   node --env-file=.env.local --import tsx scripts/reseed-sunbiz-forms.ts            # dry run
 *   node --env-file=.env.local --import tsx scripts/reseed-sunbiz-forms.ts --apply    # write
 *
 * REQUIRES: BRAVO_SUPABASE_URL, BRAVO_SUPABASE_SERVICE_ROLE_KEY.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { parseFormSteps } from "../lib/forms/types";
import { getFormTheme } from "../lib/forms/themes";
import {
  SUNBIZ_FORM_TEMPLATES,
  SUNBIZ_SLUGS,
  type SunBizStep,
} from "../lib/forms/sunbiz-templates";

const SUNBIZ_TENANT_ID = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const apply = process.argv.includes("--apply");

const url = process.env.BRAVO_SUPABASE_URL;
const key = process.env.BRAVO_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(
    "ERROR: BRAVO_SUPABASE_URL + BRAVO_SUPABASE_SERVICE_ROLE_KEY required " +
      "(run with --env-file=.env.local after `vercel env pull`, or inject via " +
      "scripts/run_reseed_sunbiz_forms.py).",
  );
  process.exit(2);
}
const db = createClient(url, key, { auth: { persistSession: false } });

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

function countFields(steps: { fields: unknown[] }[]): number {
  return steps.reduce((n, s) => n + (Array.isArray(s.fields) ? s.fields.length : 0), 0);
}

async function main() {
  const slugs = [...SUNBIZ_SLUGS] as SunBizStep[];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  // Validate every template first — fail before touching the DB.
  for (const slug of slugs) {
    parseFormSteps(SUNBIZ_FORM_TEMPLATES[slug].steps);
  }
  console.log(`✓ All ${slugs.length} templates validated through parseFormSteps.\n`);

  const existing = await db
    .from("forms")
    .select("id, slug, name, description, steps, step_outcomes, on_complete_stage, branding, enabled")
    .eq("tenant_id", SUNBIZ_TENANT_ID)
    .in("slug", slugs);
  if (existing.error) {
    console.error(`ERROR reading live forms: ${existing.error.message}`);
    process.exit(3);
  }
  const live = new Map<string, FormRow>();
  for (const r of (existing.data || []) as FormRow[]) live.set(r.slug, r);

  // Snapshot BEFORE applying so a revert is a single restore.
  const backup = {
    captured_at: new Date().toISOString(),
    tenant_id: SUNBIZ_TENANT_ID,
    forms: (existing.data || []) as FormRow[],
  };
  const backupDir = "tmp";
  const backupPath = `${backupDir}/sunbiz-forms-backup-${stamp}.json`;

  const plans: Array<{ slug: SunBizStep; row: FormRow | null }> = [];
  console.log("Plan:");
  for (const slug of slugs) {
    const tpl = SUNBIZ_FORM_TEMPLATES[slug];
    const row = live.get(slug) || null;
    const newFieldCount = countFields(tpl.steps);
    if (!row) {
      console.log(`  ${slug.padEnd(24)} NEW (insert) — ${tpl.steps.length} steps / ${newFieldCount} fields`);
    } else {
      const oldSteps = Array.isArray(row.steps) ? (row.steps as { fields: unknown[] }[]) : [];
      const oldFieldCount = countFields(oldSteps);
      console.log(
        `  ${slug.padEnd(24)} UPDATE id=${row.id.slice(0, 8)} — ` +
          `steps ${oldSteps.length}→${tpl.steps.length}, fields ${oldFieldCount}→${newFieldCount}`,
      );
    }
    plans.push({ slug, row });
  }
  console.log("");

  if (!apply) {
    console.log("DRY RUN — re-run with --apply to write. (No snapshot written on a dry run.)");
    return;
  }

  mkdirSync(backupDir, { recursive: true });
  writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf8");
  console.log(`📦 Snapshot of ${backup.forms.length} live form(s) → ${backupPath}\n`);

  for (const { slug, row } of plans) {
    const tpl = SUNBIZ_FORM_TEMPLATES[slug];
    if (row) {
      // Update SCHEMA only — preserve id/slug/branding/enabled/redirect_url.
      const upd = await db
        .from("forms")
        .update({
          name: tpl.name,
          description: tpl.description,
          steps: tpl.steps,
          step_outcomes: tpl.step_outcomes,
          on_complete_stage: tpl.on_complete_stage,
        })
        .eq("id", row.id)
        .select("id")
        .maybeSingle();
      if (upd.error) {
        console.error(`  ✗ ${slug}: update failed — ${upd.error.message}`);
        process.exit(5);
      }
      console.log(`  ✓ ${slug}: updated (id ${row.id.slice(0, 8)})`);
    } else {
      const branding = getFormTheme("sunbiz_standard")?.branding ?? {};
      const ins = await db
        .from("forms")
        .insert({
          tenant_id: SUNBIZ_TENANT_ID,
          slug,
          name: tpl.name,
          description: tpl.description,
          branding,
          steps: tpl.steps,
          step_outcomes: tpl.step_outcomes,
          on_complete_stage: tpl.on_complete_stage,
          enabled: true,
        })
        .select("id")
        .maybeSingle();
      if (ins.error) {
        console.error(`  ✗ ${slug}: insert failed — ${ins.error.message}`);
        process.exit(5);
      }
      console.log(`  ✓ ${slug}: inserted (id ${(ins.data as { id: string } | null)?.id?.slice(0, 8)})`);
    }
  }
  console.log("\n✅ SunBiz forms re-seeded from canonical template.");
  console.log(`   Revert: restore steps/step_outcomes/on_complete_stage from ${backupPath}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
