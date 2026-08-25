import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";

const client = createClient({ url: ":memory:" });

async function main() {
  // Production started with this append-only shape. Keep one historical row
  // in place while applying the migration so backwards compatibility is
  // exercised, not merely inferred from nullable column declarations.
  await client.execute(`
    CREATE TABLE leadgen_call_outcomes (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      business_id TEXT NOT NULL,
      territory_id TEXT,
      rep_user_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      notes TEXT,
      called_at TEXT NOT NULL,
      next_action_at TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await client.execute({
    sql: `INSERT INTO leadgen_call_outcomes
      (id, tenant_id, business_id, rep_user_id, outcome, called_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: ["historical", "tenant-a", "business-a", "rep-a", "reached", "2026-08-24T12:00:00.000Z", "2026-08-24T12:00:00.000Z"],
  });

  await client.executeMultiple(
    readFileSync("database/turso/158_web_lead_outcome_idempotency.turso.sql", "utf8"),
  );

  const columns = await client.execute("PRAGMA table_info(leadgen_call_outcomes)");
  const names = new Set(columns.rows.map((row) => String(row.name)));
  for (const name of ["request_id", "stage_from", "stage_to", "owner_user_id"]) {
    assert.ok(names.has(name), `migration must add ${name}`);
  }

  const historical = await client.execute({
    sql: "SELECT request_id, stage_from, stage_to, owner_user_id FROM leadgen_call_outcomes WHERE id = ?",
    args: ["historical"],
  });
  assert.equal(historical.rows.length, 1);
  assert.equal(historical.rows[0].request_id, null);

  const insert = `INSERT INTO leadgen_call_outcomes
    (id, tenant_id, business_id, rep_user_id, outcome, called_at, created_at, request_id, stage_from, stage_to, owner_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const firstArgs = [
    "first",
    "tenant-a",
    "business-a",
    "rep-a",
    "reached",
    "2026-08-24T13:00:00.000Z",
    "2026-08-24T13:00:00.000Z",
    "9b210dce-630b-4b5f-8da2-60b30f03f7ad",
    "assigned",
    "connected",
    "rep-a",
  ];
  await client.execute({ sql: insert, args: firstArgs });
  const decision = await client.execute({
    sql: "SELECT stage_from, stage_to, owner_user_id FROM leadgen_call_outcomes WHERE id = ?",
    args: ["first"],
  });
  assert.deepEqual(
    [decision.rows[0].stage_from, decision.rows[0].stage_to, decision.rows[0].owner_user_id],
    ["assigned", "connected", "rep-a"],
  );

  // The database, not an in-memory promise map, is the race winner. A replay
  // in the same tenant cannot append a second call even in another process.
  await assert.rejects(
    client.execute({ sql: insert, args: ["duplicate", ...firstArgs.slice(1)] }),
    /unique constraint failed/i,
  );

  // Tenant scope is part of the key, and legacy/null-key rows remain valid.
  await client.execute({ sql: insert, args: ["other-tenant", "tenant-b", ...firstArgs.slice(2)] });
  await client.execute({
    sql: `INSERT INTO leadgen_call_outcomes
      (id, tenant_id, business_id, rep_user_id, outcome, called_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: ["historical-2", "tenant-a", "business-b", "rep-a", "no_answer", "2026-08-24T14:00:00.000Z", "2026-08-24T14:00:00.000Z"],
  });

  const rows = await client.execute("SELECT COUNT(*) AS total FROM leadgen_call_outcomes");
  assert.equal(Number(rows.rows[0].total), 4);

  client.close();
  console.log("web-leads-outcome-idempotency ok");
}

main().catch((error) => {
  client.close();
  console.error(error);
  process.exitCode = 1;
});
