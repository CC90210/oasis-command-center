import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";

const OASIS_TENANT = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const OTHER_TENANT = "tenant-other";
const CLAIMED_AT = "2026-08-25T14:47:35.973Z";

async function main() {
  const db = createClient({ url: ":memory:" });
  await db.executeMultiple(`
    CREATE TABLE tenant_records (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE lead_interactions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      lead_id TEXT,
      type TEXT NOT NULL,
      channel TEXT NOT NULL,
      direction TEXT,
      agent_source TEXT,
      actor_user_id TEXT,
      subject TEXT,
      content TEXT,
      content_preview TEXT,
      metadata TEXT,
      created_at TEXT
    );
  `);

  const lead = (
    id: string,
    tenantId: string,
    data: Record<string, unknown>,
  ) => db.execute({
    sql: "INSERT INTO tenant_records VALUES (?, ?, 'lead', ?, ?)",
    args: [id, tenantId, JSON.stringify(data), "2026-08-25T14:47:35.973Z"],
  });

  await lead("missing-ledger", OASIS_TENANT, {
    assigned_to: "rep-1",
    claimed_at: CLAIMED_AT,
    stage: "assigned",
    sales_motion: "cold_outbound",
  });
  await lead("already-tracked", OASIS_TENANT, {
    assigned_to: "rep-1",
    claimed_at: CLAIMED_AT,
    stage: "assigned",
    sales_motion: "cold_outbound",
  });
  await lead("progressed", OASIS_TENANT, {
    assigned_to: "founder-1",
    attributed_rep_user_id: "rep-2",
    claimed_at: CLAIMED_AT,
    last_contacted_at: "2026-08-25T15:30:00.000Z",
    stage: "qualified",
    sales_motion: "cold_outbound",
  });
  await lead("warm-form", OASIS_TENANT, {
    assigned_to: "rep-1",
    claimed_at: CLAIMED_AT,
    stage: "assigned",
    sales_motion: "inbound_warm",
  });
  await lead("foreign", OTHER_TENANT, {
    assigned_to: "rep-1",
    claimed_at: CLAIMED_AT,
    stage: "assigned",
    sales_motion: "cold_outbound",
  });
  await lead("invalid-date", OASIS_TENANT, {
    assigned_to: "rep-1",
    claimed_at: "not-a-date",
    stage: "assigned",
    sales_motion: "cold_outbound",
  });

  await db.execute({
    sql: `INSERT INTO lead_interactions
      (id,tenant_id,lead_id,type,channel,direction,agent_source,actor_user_id,subject,content,content_preview,metadata,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      "existing-claim",
      OASIS_TENANT,
      "already-tracked",
      "stage_changed",
      "system",
      "internal",
      "web_leads_claim",
      "rep-1",
      "Lead claimed",
      "Lead claimed.",
      "Lead claimed.",
      JSON.stringify({ action: "claim", to: "assigned" }),
      CLAIMED_AT,
    ],
  });

  const triggerSql = readFileSync("database/turso/156_atomic_lead_touch.turso.sql", "utf8");
  await db.executeMultiple(triggerSql);
  const migrationSql = readFileSync("database/turso/165_oasis_claim_touch_cutover.turso.sql", "utf8");
  const attributionSql = readFileSync("database/turso/166_oasis_claim_touch_attribution.turso.sql", "utf8");
  await db.executeMultiple(migrationSql);
  await db.executeMultiple(attributionSql);
  await db.executeMultiple(migrationSql);
  await db.executeMultiple(attributionSql);

  const interactions = await db.execute(`
    SELECT lead_id, actor_user_id, agent_source, created_at, metadata
    FROM lead_interactions
    ORDER BY lead_id, id
  `);
  assert.equal(interactions.rows.length, 3, "the migration is idempotent and adds only two missing OASIS cold-claim events");

  const byLead = new Map(interactions.rows.map((row) => [String(row.lead_id), row]));
  const missing = byLead.get("missing-ledger");
  assert.equal(missing?.agent_source, "web_leads_claim_backfill");
  assert.equal(missing?.actor_user_id, "rep-1");
  assert.equal(missing?.created_at, CLAIMED_AT);
  assert.deepEqual(JSON.parse(String(missing?.metadata)), {
    action: "claim",
    to: "assigned",
    assigned_to: "rep-1",
    backfilled: 1,
  });
  assert.ok(byLead.has("already-tracked"), "a real claim event remains untouched");
  assert.ok(byLead.has("progressed"), "an advanced lead still receives its missing historical claim touch");
  assert.equal(
    byLead.get("progressed")?.actor_user_id,
    "rep-2",
    "a progressed lead credits the preserved opener, not its current founder/builder owner",
  );
  assert.deepEqual(JSON.parse(String(byLead.get("progressed")?.metadata)), {
    action: "claim",
    to: "assigned",
    assigned_to: "rep-2",
    backfilled: 1,
    attribution_repaired: 1,
  });
  assert.ok(!byLead.has("warm-form"), "warm form leads never enter the cold-sales claim ledger");
  assert.ok(!byLead.has("foreign"), "another tenant is never backfilled");
  assert.ok(!byLead.has("invalid-date"), "an invalid claim timestamp is not invented into the ledger");

  const leadTouches = await db.execute(`
    SELECT id, json_extract(data, '$.last_contacted_at') AS last_contacted_at
    FROM tenant_records
    ORDER BY id
  `);
  const touchByLead = new Map(leadTouches.rows.map((row) => [String(row.id), row.last_contacted_at]));
  assert.equal(touchByLead.get("missing-ledger"), CLAIMED_AT, "the canonical Last Touch clock advances to the claim");
  assert.equal(
    touchByLead.get("progressed"),
    "2026-08-25T15:30:00.000Z",
    "a historical claim never moves a newer Last Touch clock backwards",
  );

  console.log("oasis-claim-touch-cutover: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
