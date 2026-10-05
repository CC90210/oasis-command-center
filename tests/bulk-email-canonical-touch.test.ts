import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";

const client = createClient({ url: ":memory:" });
const TENANT = "tenant-oasis";

async function leadTouch(id: string): Promise<string | null> {
  const result = await client.execute({
    sql: "SELECT data FROM tenant_records WHERE tenant_id = ? AND id = ?",
    args: [TENANT, id],
  });
  const data = JSON.parse(String(result.rows[0]?.data || "{}")) as Record<string, unknown>;
  return typeof data.last_contacted_at === "string" ? data.last_contacted_at : null;
}

async function main() {
  await client.execute(`
    CREATE TABLE tenant_records (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      data TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE lead_interactions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      lead_id TEXT,
      channel TEXT,
      type TEXT,
      agent_source TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await client.executeMultiple(readFileSync("database/turso/156_atomic_lead_touch.turso.sql", "utf8"));
  await client.executeMultiple(readFileSync("database/turso/159_bulk_email_atomic_touch.turso.sql", "utf8"));

  for (const id of ["lead-a", "lead-b"]) {
    await client.execute({
      sql: "INSERT INTO tenant_records VALUES (?, ?, 'lead', ?, ?)",
      args: [id, TENANT, JSON.stringify({ last_contacted_at: "2026-08-24T12:00:00.000Z" }), "2026-08-24T12:00:00.000Z"],
    });
  }

  // This is the same multi-row INSERT boundary the Turso PostgREST adapter uses
  // for a route chunk. Each AFTER trigger update commits in that transaction.
  await client.execute({
    sql: `INSERT INTO lead_interactions
      (id, tenant_id, lead_id, channel, type, agent_source, created_at)
      VALUES (?, ?, ?, 'email', 'email_queued', 'dashboard_bulk_email_v2', ?),
             (?, ?, ?, 'email', 'email_queued', 'dashboard_bulk_email_v2', ?)`,
    args: [
      "interaction-a", TENANT, "lead-a", "2026-08-24T15:00:00.000Z",
      "interaction-b", TENANT, "lead-b", "2026-08-24T15:01:00.000Z",
    ],
  });
  assert.equal(await leadTouch("lead-a"), "2026-08-24T15:00:00.000Z");
  assert.equal(await leadTouch("lead-b"), "2026-08-24T15:01:00.000Z");

  // One invalid target aborts the WHOLE insert statement. The first row's
  // interaction and trigger update must both roll back, proving the API cannot
  // count a queue row whose canonical touch did not commit.
  await assert.rejects(
    client.execute({
      sql: `INSERT INTO lead_interactions
        (id, tenant_id, lead_id, channel, type, agent_source, created_at)
        VALUES (?, ?, ?, 'email', 'email_queued', 'dashboard_bulk_email_v2', ?),
               (?, ?, ?, 'email', 'email_queued', 'dashboard_bulk_email_v2', ?)`,
      args: [
        "interaction-rollback", TENANT, "lead-a", "2026-08-24T16:00:00.000Z",
        "interaction-missing", TENANT, "not-a-lead", "2026-08-24T16:01:00.000Z",
      ],
    }),
    /bulk_email_touch_target_missing/,
  );
  assert.equal(await leadTouch("lead-a"), "2026-08-24T15:00:00.000Z");
  const rolledBack = await client.execute({
    sql: "SELECT count(*) AS n FROM lead_interactions WHERE id IN (?, ?)",
    args: ["interaction-rollback", "interaction-missing"],
  });
  assert.equal(Number(rolledBack.rows[0]?.n), 0);

  await client.close();
  console.log("bulk-email-canonical-touch: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
