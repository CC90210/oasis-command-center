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

const manifestData = readFileSync("lib/manifest/data.ts", "utf8");
assert.match(manifestData, /s === "full-application"/);
assert.doesNotMatch(manifestData, /const chosen = intakeMatch/);
assert.match(manifestData, /fail closed: never substitute the lead-capture form/);

console.log("drip-email-telemetry: all assertions passed");
