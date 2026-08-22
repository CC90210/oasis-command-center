import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync("database/125_drip_email_events.sql", "utf8");
for (const column of [
  "merchant_id",
  "sequence_id",
  "subject_line",
  "payload_text",
  "payload_html",
  "sent_at",
]) {
  assert.match(migration, new RegExp(`\\b${column}\\b`));
}
assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
assert.match(migration, /auth\.uid\(\)/);

const executor = readFileSync("lib/drips/executor.ts", "utf8");
assert.match(executor, /logDripEmailEvent/);
assert.match(executor, /payloadHtml:\s*htmlPayload/);
assert.match(executor, /Promise\.all/);
assert.match(executor, /shouldSend && htmlPayload/);
assert.match(executor, /if \(error\) throw error/);

const reconciliation = readFileSync("lib/drips/reconcile-email-telemetry.ts", "utf8");
assert.match(reconciliation, /submissions_gmail/);
assert.match(reconciliation, /buildDripHtml/);
assert.match(reconciliation, /drip_run_id/);
assert.match(reconciliation, /ignoreDuplicates:\s*true/);

const cron = readFileSync("app/api/cron/reconcile-drip-telemetry/route.ts", "utf8");
assert.match(cron, /checkCronAuth/);
assert.match(cron, /reconcileDripEmailTelemetry/);

const idempotency = readFileSync("database/126_drip_email_event_idempotency.sql", "utf8");
assert.match(idempotency, /UNIQUE INDEX/);
assert.match(idempotency, /tenant_id, drip_run_id/);

const api = readFileSync("app/api/drip-tracker/route.ts", "utf8");
assert.match(api, /resolveTenantId/);
assert.match(api, /\.eq\("tenant_id", tenantId\)/);
assert.match(api, /total_sent_today/);
assert.match(api, /active_loops/);
assert.match(api, /\.from\("drip_runs"\)/);
assert.match(api, /\["scheduled", "sending"\]/);

const ui = readFileSync("components/drips/DripTrackerClient.tsx", "utf8");
assert.match(ui, /setInterval/);
assert.match(ui, /5_000/);
assert.match(ui, /sandbox=""/);
assert.match(ui, /payload_html/);
assert.match(ui, /payload_text/);
assert.match(ui, /compact = false/);
assert.match(ui, /max-h-\[246px\]/);
assert.match(ui, /href="\/drip-tracker"/);
assert.match(ui, /Collapse/);

const metricsUi = readFileSync("components/metrics/MetricsDashboard.tsx", "utf8");
assert.match(metricsUi, /import \{ DripTrackerClient \}/);
assert.match(metricsUi, /active === "drips" && <DripTrackerClient compact \/>/);

const defaults = readFileSync("lib/sunbiz-default-sequences.ts", "utf8");
assert.match(defaults, /Sent application - access link/);
assert.match(defaults, /delay_minutes:\s*0/);
assert.match(defaults, /\{\{lead\.application_url\}\}/);
assert.match(executor, /sms_delivery_failed_after_retries/);
assert.match(executor, /renderedCustomHtml/);
assert.match(executor, /copy\.bodyHtml/);

const sequenceBuilder = readFileSync("components/sequences/SequenceBuilderClient.tsx", "utf8");
assert.match(sequenceBuilder, /Save to Templates/);
assert.match(sequenceBuilder, /Your Drip Templates/);
assert.match(sequenceBuilder, /Optional custom HTML/);
assert.match(sequenceBuilder, /body_html/);

const templatesPage = readFileSync("app/templates/page.tsx", "utf8");
assert.match(templatesPage, /DripEmailTemplatesSection/);
assert.match(templatesPage, /Drip Templates/);

const dripLibrary = readFileSync("components/templates/DripEmailTemplatesSection.tsx", "utf8");
assert.match(dripLibrary, /Jordan direct/);
assert.match(dripLibrary, /Create with Solara/);
assert.match(dripLibrary, /application_url/);

const dripTemplatesApi = readFileSync("app/api/drip-templates/route.ts", "utf8");
assert.match(dripTemplatesApi, /resolveSessionContext/);
assert.match(dripTemplatesApi, /\.eq\("tenant_id", session\.tenantId\)/);
assert.match(dripTemplatesApi, /\.like\("category", "drip:%"\)/);
assert.doesNotMatch(dripTemplatesApi, /admin_only/);

const dripSeeds = readFileSync("scripts/seed-drip-template-library.ts", "utf8");
assert.match(dripSeeds, /Follow Up - Jordan Direct/);
assert.match(dripSeeds, /Sent Application - Direct Link/);
assert.match(dripSeeds, /Signed Application - Bank Statements/);
assert.match(dripSeeds, /Declined - Revisit the File/);
assert.match(dripSeeds, /templates: seeds\.length/);

const manifestData = readFileSync("lib/manifest/data.ts", "utf8");
assert.match(manifestData, /s === "full-application"/);
assert.doesNotMatch(manifestData, /const chosen = intakeMatch/);
assert.match(manifestData, /fail closed: never substitute the lead-capture form/);

console.log("drip-email-telemetry: all assertions passed");

// ---------------------------------------------------------------------------
// FK-orphan gate (2026-08-22). Both sequence_id (NOT NULL FK) and drip_run_id
// (FK) come from HISTORICAL interaction metadata; a deleted parent made the
// upsert die with SQLITE_CONSTRAINT: FOREIGN KEY hourly, and until #270 the
// route reported the cause as "unknown_error". The lib must check parent
// existence BEFORE writing, skip-and-count orphans (never null them into
// plausibility), and report the count so a growing orphan set is visible.
// ---------------------------------------------------------------------------
{
  const src = readFileSync("lib/drips/reconcile-email-telemetry.ts", "utf8");
  assert.match(src, /from\("drip_runs"\)/, "must check drip_runs for parent existence before upserting");
  assert.match(src, /sequenceClasses\.has\(/, "a sequence missing from the fetch is a DELETED parent, not 'commercial by default'");
  assert.match(src, /const orphaned = missing\.length - writable\.length/, "orphans must be counted, not silently dropped");
  assert.match(src, /already_recorded: existing\.size, orphaned/, "the orphan count must be returned so the route surfaces it");
  assert.doesNotMatch(src, /drip_run_id:\s*null/, "never null an orphan's run id to force the insert through");
}
