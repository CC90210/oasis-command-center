/**
 * tests/forms-tenant-scoping.test.ts
 *
 * The form builder was SunBiz-hardcoded for every tenant (2026-08-22):
 * "New form" shipped the "SunBiz Funding" headline, the SunBiz doc-collection
 * step, SunBiz stage keys in step_outcomes, and the SunBiz stage vocabulary
 * in the per-step dropdown — on tenants that are not SunBiz. These assertions
 * pin the tenant boundary in lib/forms/tenant-form-config.ts +
 * lib/forms/themes.ts:
 *
 *   - SunBiz keeps exactly what it had (no regression for the live tenant).
 *   - No other tenant's defaults may contain SunBiz branding, SunBiz doc
 *     steps, or SunBiz stage keys.
 *   - Unknown tenants FAIL CLOSED on stage vocabulary: an offered stage key
 *     is written into that tenant's lead rows on submit, so offering another
 *     tenant's keys is data corruption, not just wrong copy.
 */

import assert from "node:assert/strict";
import {
  formStageGroupsForTenant,
  starterFormForTenant,
} from "../lib/forms/tenant-form-config";
import { formThemesForTenant, FORM_THEMES } from "../lib/forms/themes";

function allStageKeys(profileSlug: string | null): string[] {
  return formStageGroupsForTenant(profileSlug).flatMap((g) => g.options.map((o) => o.value));
}

// ---------------------------------------------------------------- SunBiz keeps its own
{
  const starter = starterFormForTenant("sun", "Submissions", null);
  assert.equal(starter.branding.headline, "SunBiz Funding", "sun keeps its branded starter");
  assert.deepEqual(starter.step_outcomes, { "0": "sent_application" });
  assert.equal(starter.on_complete_stage, "submitted");
  assert.ok(
    starter.steps.some((s) => s.fields.some((f) => f.type === "file_upload_multi")),
    "sun starter keeps the doc-collection step",
  );

  const sunThemes = formThemesForTenant("sun");
  assert.deepEqual(sunThemes, FORM_THEMES, "sun keeps the full branded theme list");

  const sunKeys = allStageKeys("sun");
  assert.ok(sunKeys.includes("sent_application"), "sun keeps its lead-pipeline vocabulary");
}

// ---------------------------------------------------------------- other tenants never see SunBiz
for (const slug of ["oasis-ai-cc", "oasis-webdev", "fun", "nodeops-control-center", null]) {
  const starter = starterFormForTenant(slug, "Acme Web Co", "/logos/acme.png");
  const brandingJson = JSON.stringify(starter.branding).toLowerCase();
  assert.ok(!brandingJson.includes("sunbiz"), `${slug}: starter branding must not mention SunBiz`);
  assert.equal(starter.branding.headline, "Acme Web Co", `${slug}: headline is the tenant's own name`);
  assert.equal(starter.branding.logo_url, "/logos/acme.png", `${slug}: logo is the tenant's own`);
  assert.deepEqual(starter.step_outcomes, {}, `${slug}: no foreign stage keys in step_outcomes`);
  assert.equal(starter.on_complete_stage, null, `${slug}: no foreign on_complete_stage`);
  assert.ok(
    !starter.steps.some((s) => s.fields.some((f) => f.name === "bank_statements")),
    `${slug}: no SunBiz doc-collection step`,
  );

  const themesJson = JSON.stringify(formThemesForTenant(slug)).toLowerCase();
  assert.ok(!themesJson.includes("sunbiz"), `${slug}: theme list must not contain SunBiz themes`);
  assert.ok(!themesJson.includes("funding"), `${slug}: theme copy must not be funding vocabulary`);

  assert.ok(
    !allStageKeys(slug).includes("sent_application"),
    `${slug}: dropdown must not offer SunBiz stage keys`,
  );
}

// ---------------------------------------------------------------- OASIS gets its own vocabulary
{
  for (const slug of ["oasis-ai-cc", "oasis-webdev", "oasis"]) {
    const keys = allStageKeys(slug);
    assert.ok(keys.includes("proposal_sent"), `${slug}: offers the OASIS lead lifecycle`);
    assert.ok(keys.includes("launched"), `${slug}: offers the OASIS delivery stages`);
  }
}

// ---------------------------------------------------------------- unknown tenants fail closed
{
  assert.deepEqual(formStageGroupsForTenant("fun"), [], "unregistered tenant gets NO stage vocabulary");
  assert.deepEqual(formStageGroupsForTenant(null), [], "null profile fails closed");
}

// A tenant with no name still gets a neutral (non-SunBiz) headline.
{
  const starter = starterFormForTenant("oasis-webdev", null, null);
  assert.ok(starter.branding.headline, "neutral starter still has a headline");
  assert.ok(!/sunbiz|funding/i.test(starter.branding.headline!), "and it is not SunBiz/funding copy");
}

console.log("forms-tenant-scoping: all assertions passed");
