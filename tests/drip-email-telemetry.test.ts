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

console.log("drip-email-telemetry: all assertions passed");
