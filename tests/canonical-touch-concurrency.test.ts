import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { record_lead_touch, TURSO_RPC_SHIM } from "../lib/turso-rpc-shim";
import { persistCanonicalLeadTouch } from "../lib/leads/canonical-touch";

const TENANT = "tenant-oasis";
const LEAD = "lead-race";
const client = createClient({ url: ":memory:" });

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
    created_at TEXT NOT NULL
  )
`);
await client.executeMultiple(
  readFileSync("database/turso/156_atomic_lead_touch.turso.sql", "utf8"),
);
await client.execute({
  sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data, updated_at) VALUES (?, ?, 'lead', ?, ?)",
  args: [
    LEAD,
    TENANT,
    JSON.stringify({
      assigned_to: "owner-a",
      last_contacted_at: "2026-08-24T12:00:00.000Z",
    }),
    "2026-08-24T12:00:00.000Z",
  ],
});

assert.equal(
  TURSO_RPC_SHIM.record_lead_touch,
  record_lead_touch,
  "the atomic touch RPC must be reachable through the production Turso registry",
);

// Model two overlapping provider deliveries, including an older call that may
// finish after the newer event. SQLite serializes the final writes; the RPC's
// CAS retry must recalculate max from the winning value before it can commit.
await Promise.all([
  record_lead_touch(client, {
    p_id: LEAD,
    p_tenant_id: TENANT,
    p_occurred_at: "2026-08-24T14:00:00.000Z",
    p_is_call: false,
  }),
  record_lead_touch(client, {
    p_id: LEAD,
    p_tenant_id: TENANT,
    p_occurred_at: "2026-08-24T13:00:00.000Z",
    p_is_call: true,
  }),
]);

// A late retry after both writes is an explicit out-of-order regression case.
await record_lead_touch(client, {
  p_id: LEAD,
  p_tenant_id: TENANT,
  p_occurred_at: "2026-08-24T11:00:00.000Z",
  p_is_call: true,
});

const stored = await client.execute({
  sql: "SELECT data FROM tenant_records WHERE id = ? AND tenant_id = ?",
  args: [LEAD, TENANT],
});
const data = JSON.parse(String(stored.rows[0].data)) as Record<string, unknown>;
assert.equal(data.last_contacted_at, "2026-08-24T14:00:00.000Z");
assert.equal(data.last_call_at, "2026-08-24T13:00:00.000Z");

// The ledger trigger is the invariant for paths that only write an
// interaction (drips, gateway logs, scheduled sends, and future integrations).
await client.execute({
  sql: "INSERT INTO lead_interactions VALUES (?, ?, ?, 'email', 'email_sent', ?)",
  args: ["interaction-new", TENANT, LEAD, "2026-08-24T15:00:00.000Z"],
});
await client.execute({
  sql: "INSERT INTO lead_interactions VALUES (?, ?, ?, 'phone', 'call_completed', ?)",
  args: ["interaction-old-call", TENANT, LEAD, "2026-08-24T12:30:00.000Z"],
});
const triggered = await client.execute({
  sql: "SELECT data FROM tenant_records WHERE id = ? AND tenant_id = ?",
  args: [LEAD, TENANT],
});
const triggeredData = JSON.parse(String(triggered.rows[0].data)) as Record<string, unknown>;
assert.equal(triggeredData.last_contacted_at, "2026-08-24T15:00:00.000Z");
assert.equal(triggeredData.last_call_at, "2026-08-24T13:00:00.000Z");

await assert.rejects(
  record_lead_touch(client, {
    p_id: LEAD,
    p_tenant_id: TENANT,
    p_occurred_at: "2026-08-24T16:00:00.000Z",
    p_expected_owner_id: "owner-b",
  }),
  /record_lead_touch: owner_conflict/,
  "a touch authorized for the previous owner must not stamp a transferred lead",
);
const afterOwnerConflict = await client.execute({
  sql: "SELECT data FROM tenant_records WHERE id = ? AND tenant_id = ?",
  args: [LEAD, TENANT],
});
assert.equal(
  JSON.parse(String(afterOwnerConflict.rows[0].data)).last_contacted_at,
  "2026-08-24T15:00:00.000Z",
);

await assert.rejects(
  record_lead_touch(client, {
    p_id: LEAD,
    p_tenant_id: TENANT,
    p_occurred_at: "2026-08-24T16:00:00.000Z",
    p_expected_owner_id: null,
  }),
  /record_lead_touch: owner_conflict/,
  "explicit null means expected-unassigned; it must not disable the guard",
);

let forwardedArgs: Record<string, unknown> | null = null;
await persistCanonicalLeadTouch({
  rpc: async (_name: string, args: Record<string, unknown>) => {
    forwardedArgs = args;
    return {
      data: {
        last_contacted_at: "2026-08-24T16:00:00.000Z",
        last_call_at: null,
      },
      error: null,
    };
  },
} as never, {
  tenantId: TENANT,
  leadId: LEAD,
  occurredAt: "2026-08-24T16:00:00.000Z",
  expectedOwnerId: "owner-a",
});
assert.equal(
  forwardedArgs?.p_expected_owner_id,
  "owner-a",
  "the canonical wrapper must forward the frozen owner into the Turso guard",
);

forwardedArgs = null;
await persistCanonicalLeadTouch({
  rpc: async (_name: string, args: Record<string, unknown>) => {
    forwardedArgs = args;
    return {
      data: {
        last_contacted_at: "2026-08-24T16:00:00.000Z",
        last_call_at: null,
      },
      error: null,
    };
  },
} as never, {
  tenantId: TENANT,
  leadId: LEAD,
  occurredAt: "2026-08-24T16:00:00.000Z",
  expectedOwnerId: null,
});
assert.ok(forwardedArgs && Object.prototype.hasOwnProperty.call(forwardedArgs, "p_expected_owner_id"));
assert.equal(
  forwardedArgs.p_expected_owner_id,
  null,
  "the wrapper must preserve explicit null as an expected-unassigned guard",
);

await client.close();
console.log("canonical-touch-concurrency: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
