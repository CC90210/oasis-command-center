import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { claim_web_lead, TURSO_RPC_SHIM } from "../lib/turso-rpc-shim";

const TENANT = "tenant-oasis";
const ACTOR = "rep-opener";
const OCCURRED = "2026-08-25T14:00:00.000Z";
const INITIAL_UPDATED = "2026-08-24T14:00:00.000Z";

const client = createClient({ url: "file::memory:?cache=shared" });

function claimedData(company: string) {
  return {
    company,
    website: "https://example.test",
    assigned_to: ACTOR,
    claimed_at: OCCURRED,
    sales_program: "website_sales_v1",
    sales_motion: "cold_outbound",
    last_contacted_at: OCCURRED,
    last_call_at: null,
    lost_at: null,
    stage: "assigned",
    stage_entered_at: OCCURRED,
  };
}

async function leadData(id: string) {
  const result = await client.execute({
    sql: "SELECT data, updated_at FROM tenant_records WHERE id = ? AND tenant_id = ?",
    args: [id, TENANT],
  });
  assert.equal(result.rows.length, 1);
  return {
    data: JSON.parse(String(result.rows[0].data)) as Record<string, unknown>,
    updatedAt: String(result.rows[0].updated_at),
  };
}

async function interactionCount(id: string) {
  const result = await client.execute({
    sql: "SELECT count(*) AS total FROM lead_interactions WHERE tenant_id = ? AND lead_id = ?",
    args: [TENANT, id],
  });
  return Number(result.rows[0].total);
}

async function main() {
  await client.executeMultiple(`
    CREATE TABLE tenant_records (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      data TEXT,
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
      created_at TEXT NOT NULL
    );
  `);
  await client.batch([
    {
      sql: "INSERT INTO tenant_records VALUES (?, ?, 'lead', ?, ?)",
      args: [
        "lead-success",
        TENANT,
        JSON.stringify({ company: "Acme", website: "https://example.test", assigned_to: null, stage: null }),
        INITIAL_UPDATED,
      ],
    },
    {
      sql: "INSERT INTO tenant_records VALUES (?, ?, 'lead', ?, ?)",
      args: [
        "lead-rollback",
        TENANT,
        JSON.stringify({ company: "Rollback Co", assigned_to: null, stage: "prospect" }),
        INITIAL_UPDATED,
      ],
    },
    {
      sql: "INSERT INTO tenant_records VALUES (?, ?, 'lead', ?, ?)",
      args: [
        "lead-cap",
        TENANT,
        JSON.stringify({ company: "Capacity Co", assigned_to: null, stage: null }),
        INITIAL_UPDATED,
      ],
    },
  ], "write");

  assert.equal(
    TURSO_RPC_SHIM.claim_web_lead,
    claim_web_lead,
    "the production Turso registry must expose the atomic claim primitive",
  );

  const interactionId = "11111111-1111-4111-8111-111111111111";
  const first = await claim_web_lead(client, {
    p_tenant_id: TENANT,
    p_lead_id: "lead-success",
    p_actor_user_id: ACTOR,
    p_expected_updated_at: INITIAL_UPDATED,
    p_expected_owner_id: null,
    p_previous_stage: null,
    p_occurred_at: OCCURRED,
    p_interaction_id: interactionId,
    p_data: claimedData("Acme"),
  }) as Record<string, unknown>;
  assert.deepEqual({ ok: first.ok, idempotent: first.idempotent }, { ok: true, idempotent: false });

  const saved = await leadData("lead-success");
  assert.equal(saved.data.assigned_to, ACTOR);
  assert.equal(saved.data.stage, "assigned");
  assert.equal(saved.data.website, "https://example.test", "claiming must preserve website context");
  assert.equal(saved.data.last_contacted_at, OCCURRED, "claiming is a canonical touch");
  assert.equal(saved.updatedAt, OCCURRED);
  assert.equal(await interactionCount("lead-success"), 1);

  const receipt = await client.execute({
    sql: "SELECT actor_user_id, metadata FROM lead_interactions WHERE id = ?",
    args: [interactionId],
  });
  assert.equal(receipt.rows[0].actor_user_id, ACTOR);
  assert.deepEqual(
    JSON.parse(String(receipt.rows[0].metadata)),
    { action: "claim", from: null, to: "assigned", assigned_to: ACTOR },
  );

  const replay = await claim_web_lead(client, {
    p_tenant_id: TENANT,
    p_lead_id: "lead-success",
    p_actor_user_id: ACTOR,
    p_expected_updated_at: INITIAL_UPDATED,
    p_expected_owner_id: null,
    p_occurred_at: OCCURRED,
    p_interaction_id: interactionId,
    p_data: claimedData("Acme"),
  }) as Record<string, unknown>;
  assert.deepEqual({ ok: replay.ok, idempotent: replay.idempotent }, { ok: true, idempotent: true });
  assert.equal(await interactionCount("lead-success"), 1, "a transport retry must not duplicate touches");

  const conflict = await claim_web_lead(client, {
    p_tenant_id: TENANT,
    p_lead_id: "lead-success",
    p_actor_user_id: "different-rep",
    p_expected_updated_at: INITIAL_UPDATED,
    p_expected_owner_id: null,
    p_occurred_at: OCCURRED,
    p_interaction_id: "22222222-2222-4222-8222-222222222222",
    p_data: { ...claimedData("Acme"), assigned_to: "different-rep" },
  }) as Record<string, unknown>;
  assert.deepEqual(conflict, { ok: false, error: "claim_conflict" });
  assert.equal(await interactionCount("lead-success"), 1, "a lost race must not create a touch");

  await client.execute(`
    CREATE TRIGGER fail_claim_receipt
    BEFORE INSERT ON lead_interactions
    WHEN NEW.lead_id = 'lead-rollback'
    BEGIN
      SELECT RAISE(ABORT, 'forced receipt failure');
    END;
  `);
  await assert.rejects(
    () => claim_web_lead(client, {
      p_tenant_id: TENANT,
      p_lead_id: "lead-rollback",
      p_actor_user_id: ACTOR,
      p_expected_updated_at: INITIAL_UPDATED,
      p_expected_owner_id: null,
      p_previous_stage: "prospect",
      p_occurred_at: OCCURRED,
      p_interaction_id: "33333333-3333-4333-8333-333333333333",
      p_data: claimedData("Rollback Co"),
    }),
    /forced receipt failure/,
  );
  const rolledBack = await leadData("lead-rollback");
  assert.equal(rolledBack.data.assigned_to, null, "ledger failure must roll ownership back");
  assert.equal(rolledBack.data.stage, "prospect");
  assert.equal(rolledBack.updatedAt, INITIAL_UPDATED);
  assert.equal(await interactionCount("lead-rollback"), 0);

  await client.batch(
    Array.from({ length: 249 }, (_, index) => ({
      sql: "INSERT INTO tenant_records VALUES (?, ?, 'lead', ?, ?)",
      args: [
        `held-${index}`,
        TENANT,
        JSON.stringify({ assigned_to: ACTOR, stage: "assigned" }),
        INITIAL_UPDATED,
      ],
    })),
    "write",
  );
  const atCapacity = await claim_web_lead(client, {
    p_tenant_id: TENANT,
    p_lead_id: "lead-cap",
    p_actor_user_id: ACTOR,
    p_expected_updated_at: INITIAL_UPDATED,
    p_expected_owner_id: null,
    p_occurred_at: OCCURRED,
    p_interaction_id: "44444444-4444-4444-8444-444444444444",
    p_data: claimedData("Capacity Co"),
  }) as Record<string, unknown>;
  assert.deepEqual(atCapacity, { ok: false, error: "at_capacity" });
  assert.equal((await leadData("lead-cap")).data.assigned_to, null);
  assert.equal(await interactionCount("lead-cap"), 0, "capacity refusal must not create a false claim touch");

  console.log("atomic-web-lead-claim tests passed");
}

main().finally(() => client.close());
