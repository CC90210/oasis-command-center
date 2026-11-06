import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import {
  AutomationPipelineError,
  buildAutomationDescription,
  parseAutomationPipeline,
  suggestConnectorKeys,
  targetMachineIsSelectable,
  targetMachineState,
} from "../lib/automations/pipeline";

async function main() {
  const pipeline = parseAutomationPipeline({
    department: "marketing",
    objective: "Prepare a qualified lead brief for the sales owner.",
    trigger_kind: "schedule",
    schedule_hint: "0 9 * * 1-5",
    input_parameters: "lead_id, owner",
    expected_outputs: "A concise account brief",
    connector_keys: ["gmail_client_id", "NOT-VALID", "GMAIL_CLIENT_ID"],
    target_pairing_id: "pair-cc-main",
  });
  assert.deepEqual(pipeline.input_parameters, ["lead_id", "owner"]);
  assert.deepEqual(pipeline.connector_keys, ["GMAIL_CLIENT_ID"]);
  assert.match(buildAutomationDescription(pipeline), /Never print or hardcode credential values/);
  assert.deepEqual(suggestConnectorKeys("finance", "Reconcile Wise deposits", ["WISE_API_TOKEN", "HIGGSFIELD_API_KEY"]), ["WISE_API_TOKEN"]);
  assert.throws(
    () => parseAutomationPipeline({ ...pipeline, target_pairing_id: "other tenant's computer" }),
    AutomationPipelineError,
  );

  const now = Date.parse("2026-10-13T12:00:00.000Z");
  assert.equal(targetMachineState("2026-10-13T11:59:00.000Z", now), "online");
  assert.equal(targetMachineState("2026-10-13T11:55:00.000Z", now), "idle");
  assert.equal(targetMachineState("2026-10-13T11:40:00.000Z", now), "offline");
  assert.equal(targetMachineIsSelectable({ scope: "daemon", last_seen_at: "2026-10-13T11:59:00.000Z", tool_capabilities: ["generated_script_v1"] }, now), true);
  assert.equal(targetMachineIsSelectable({ scope: "daemon", last_seen_at: "2026-10-13T11:59:00.000Z", tool_capabilities: [] }, now), false);
  assert.equal(targetMachineIsSelectable({ scope: "connector", last_seen_at: "2026-10-13T11:59:00.000Z" }, now), false);

  const dbFile = join(mkdtempSync(join(tmpdir(), "automation-pipeline-migration-")), "test.db");
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE bridge_pairings (id TEXT PRIMARY KEY);
    CREATE TABLE tenant_cron_jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0
    );
  `);
  const migration = readFileSync(join(process.cwd(), "database", "turso", "bravo__225_automation_templates.sql"), "utf8");
  await db.executeMultiple(migration);

  const cronColumns = await db.execute("PRAGMA table_info(tenant_cron_jobs)");
  assert.ok(cronColumns.rows.some((row) => row.name === "target_pairing_id"));
  const templateColumns = await db.execute("PRAGMA table_info(automation_templates)");
  assert.deepEqual(
    ["tenant_id", "cron_job_id", "target_pairing_id", "department", "connector_keys_json", "draft_json", "status"].filter(
      (name) => !templateColumns.rows.some((row) => row.name === name),
    ),
    [],
  );

  await db.batch([
    { sql: "INSERT INTO bridge_pairings (id) VALUES (?)", args: [pipeline.target_pairing_id] },
    { sql: "INSERT INTO tenant_cron_jobs (id, tenant_id, target_pairing_id) VALUES ('job-1', 'tenant-1', ?)", args: [pipeline.target_pairing_id] },
    {
      sql: `INSERT INTO automation_templates
        (id, tenant_id, created_by, cron_job_id, target_pairing_id, target_label, department, objective,
         trigger_kind, schedule_hint, input_parameters_json, expected_outputs, connector_keys_json, draft_json)
        VALUES ('template-1', 'tenant-1', 'user-1', 'job-1', ?, 'CCPC', ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        pipeline.target_pairing_id,
        pipeline.department,
        pipeline.objective,
        pipeline.trigger_kind,
        pipeline.schedule_hint,
        JSON.stringify(pipeline.input_parameters),
        pipeline.expected_outputs,
        JSON.stringify(pipeline.connector_keys),
        JSON.stringify({ suggested_name: "Lead brief" }),
      ],
    },
  ], "write");
  const stored = await db.execute("SELECT target_pairing_id, department, status FROM automation_templates WHERE id = 'template-1'");
  assert.deepEqual(
    { target: stored.rows[0].target_pairing_id, department: stored.rows[0].department, status: stored.rows[0].status },
    { target: "pair-cc-main", department: "marketing", status: "ready" },
  );
  db.close();
  console.log("automation-pipeline-migration: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
