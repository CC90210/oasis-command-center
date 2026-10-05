import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";

async function main() {
  const migration = readFileSync("database/turso/170_sms_reply_agent.turso.sql", "utf8");
  const db = createClient({ url: ":memory:" });
  await db.executeMultiple(migration);

  const tables = await db.execute(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name LIKE 'sms_agent_%'
    ORDER BY name
  `);
  assert.deepEqual(
    tables.rows.map((row) => row.name),
    ["sms_agent_conversations", "sms_agent_jobs", "sms_agent_worker_health"],
  );

  const indexes = await db.execute(`
    SELECT name FROM sqlite_schema
    WHERE type = 'index' AND name LIKE 'sms_agent_jobs_%_idx'
    ORDER BY name
  `);
  assert.deepEqual(
    indexes.rows.map((row) => row.name),
    ["sms_agent_jobs_status_received_idx", "sms_agent_jobs_tenant_phone_received_idx"],
  );

  const baseJob = {
    sql: `INSERT INTO sms_agent_jobs
      (id, tenant_id, provider, provider_message_id, from_phone, to_phone,
       phone_last10, body)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      "job-1",
      "tenant-a",
      "twilio",
      "SM123",
      "+14165550100",
      "+18005550100",
      "4165550100",
      "Can we move the meeting?",
    ],
  };
  await db.execute(baseJob);
  const row = await db.execute("SELECT status, attempts, intent_source, received_at FROM sms_agent_jobs");
  assert.equal(row.rows[0].status, "pending");
  assert.equal(row.rows[0].attempts, 0);
  assert.equal(row.rows[0].intent_source, "none");
  assert.match(String(row.rows[0].received_at), /^\d{4}-\d{2}-\d{2}T/);

  await assert.rejects(
    db.execute({ ...baseJob, args: ["job-2", ...baseJob.args.slice(1)] }),
    /UNIQUE constraint failed/i,
    "provider MessageSid is durably idempotent per tenant",
  );
  await assert.rejects(
    db.execute({ ...baseJob, args: ["job-null-provider", "tenant-a", null, "SM124", "+1", "+2", "4165550100", "x"] }),
    /NOT NULL constraint failed/i,
  );

  await db.execute({
    sql: `INSERT INTO sms_agent_conversations (tenant_id, phone_last10)
          VALUES (?, ?)`,
    args: ["tenant-a", "4165550100"],
  });
  const conversation = await db.execute(
    "SELECT state, proposed_slots, agent_turns_24h, automation_paused FROM sms_agent_conversations",
  );
  assert.deepEqual(
    {
      state: conversation.rows[0].state,
      proposed_slots: conversation.rows[0].proposed_slots,
      agent_turns_24h: conversation.rows[0].agent_turns_24h,
      automation_paused: conversation.rows[0].automation_paused,
    },
    { state: "idle", proposed_slots: "[]", agent_turns_24h: 0, automation_paused: 0 },
  );

  console.log("sms-agent-schema: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
