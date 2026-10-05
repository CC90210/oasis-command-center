import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";

const OASIS_TENANT = "ef8d389e-3f15-43f2-ae00-3660f69a1452";

async function main() {
  const db = createClient({ url: ":memory:" });
  await db.execute(`
    CREATE TABLE tenant_records (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  const rows = [
    ["warm", { stage: "qualified", created_from_form_id: "form-1" }],
    ["claimed", { stage: "assigned", claimed_at: "2026-08-24T12:00:00.000Z" }],
    ["directory", { stage: "researched", webdev_source_business_id: "business-1" }],
    ["unworked", { stage: "researched" }],
  ] as const;
  for (const [id, data] of rows) {
    await db.execute({
      sql: "INSERT INTO tenant_records (id,tenant_id,entity_type,data,updated_at) VALUES (?,?,?,?,?)",
      args: [id, OASIS_TENANT, "lead", JSON.stringify(data), "2026-01-01T00:00:00.000Z"],
    });
  }

  const sql = readFileSync("database/turso/161_oasis_sales_motion_split.turso.sql", "utf8")
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of sql) await db.execute(statement);

  const result = await db.execute("SELECT id, json_extract(data, '$.sales_motion') AS motion FROM tenant_records ORDER BY id");
  const motion = new Map(result.rows.map((row) => [String(row.id), row.motion === null ? null : String(row.motion)]));
  assert.equal(motion.get("warm"), "inbound_warm");
  assert.equal(motion.get("claimed"), "cold_outbound");
  assert.equal(motion.get("directory"), "cold_outbound");
  assert.equal(motion.get("unworked"), null, "an untouched pool row is not promoted into Pipeline work");
  console.log("oasis-sales-motion-split: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
