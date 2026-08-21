import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { assign_web_lead_territory } from "../lib/turso-rpc-shim";

const TENANT = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const TERRITORY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

function fakeClient({ territory = true, member = true }: { territory?: boolean; member?: boolean } = {}) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const batches: unknown[] = [];
  return {
    calls,
    batches,
    async execute(statement: { sql: string; args: unknown[] }) {
      calls.push(statement);
      if (statement.sql.includes("FROM leadgen_territories")) return { rows: territory ? [{ id: TERRITORY }] : [] };
      if (statement.sql.includes("FROM user_profiles")) return { rows: member ? [{ 1: 1 }] : [] };
      throw new Error("unexpected execute");
    },
    async batch(statements: unknown[], mode: string) {
      batches.push({ statements, mode });
      return [{ rowsAffected: 1 }, { rowsAffected: 37 }];
    },
  };
}

async function main() {
// Permanent isolated runtime-shaped fixture: real libSQL JSON mutation and
// transaction semantics, with no production credentials or customer rows.
{
  const db = createClient({ url: ":memory:" });
  await db.batch([
    "CREATE TABLE leadgen_territories (id TEXT PRIMARY KEY, tenant_id TEXT, assigned_to TEXT, assigned_at TEXT, updated_at TEXT)",
    "CREATE TABLE user_profiles (tenant_id TEXT, auth_user_id TEXT, team_role TEXT)",
    "CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT, entity_type TEXT, data TEXT, updated_at TEXT)",
  ], "write");
  await db.batch([
    { sql: "INSERT INTO leadgen_territories VALUES (?, ?, NULL, NULL, ?)", args: [TERRITORY, TENANT, new Date(0).toISOString()] },
    { sql: "INSERT INTO user_profiles VALUES (?, ?, 'agent')", args: [TENANT, AGENT] },
    { sql: "INSERT INTO tenant_records VALUES ('lead-a', ?, 'lead', ?, ?)", args: [TENANT, JSON.stringify({ webdev_territory_id: TERRITORY, assigned_to: null }), new Date(0).toISOString()] },
    { sql: "INSERT INTO tenant_records VALUES ('other-territory', ?, 'lead', ?, ?)", args: [TENANT, JSON.stringify({ webdev_territory_id: "33333333-3333-4333-8333-333333333333", assigned_to: null }), new Date(0).toISOString()] },
    { sql: "INSERT INTO tenant_records VALUES ('other-tenant', 'other', 'lead', ?, ?)", args: [JSON.stringify({ webdev_territory_id: TERRITORY, assigned_to: null }), new Date(0).toISOString()] },
  ], "write");
  const receipt = await assign_web_lead_territory(db, { p_tenant_id: TENANT, p_territory_id: TERRITORY, p_assigned_to: AGENT }) as { leads_updated: number };
  assert.equal(receipt.leads_updated, 1);
  const rows = await db.execute("SELECT id, json_extract(data, '$.assigned_to') AS owner FROM tenant_records ORDER BY id");
  assert.deepEqual(rows.rows.map((r) => [r.id, r.owner]), [
    ["lead-a", AGENT], ["other-tenant", null], ["other-territory", null],
  ], "only the selected tenant and territory may change");
  await db.close();
}

{
  const db = fakeClient();
  const result = await assign_web_lead_territory(db as never, {
    p_tenant_id: TENANT, p_territory_id: TERRITORY, p_assigned_to: AGENT.toUpperCase(),
  }) as { assigned_to: string; leads_updated: number };
  assert.equal(result.assigned_to, AGENT, "assignee identity must be normalized");
  assert.equal(result.leads_updated, 37, "must report the CRM rows changed");
  assert.equal(db.batches.length, 1, "territory and lead propagation must share one batch");
  assert.equal((db.batches[0] as { mode: string }).mode, "write", "batch must be transactional write mode");
  const statements = (db.batches[0] as { statements: Array<{ sql: string; args: unknown[] }> }).statements;
  assert.match(statements[0].sql, /leadgen_territories/, "must update the territory owner");
  assert.match(statements[1].sql, /tenant_id = \?/, "lead propagation must pin tenant_id");
  assert.match(statements[1].sql, /webdev_territory_id/, "must update only leads in the selected territory");
}

{
  const db = fakeClient({ member: false });
  await assert.rejects(
    assign_web_lead_territory(db as never, { p_tenant_id: TENANT, p_territory_id: TERRITORY, p_assigned_to: AGENT }),
    /assignee_not_an_agent_in_tenant/,
  );
  assert.equal(db.batches.length, 0, "invalid cross-role/cross-tenant assignee must write nothing");
}

{
  const db = fakeClient();
  const result = await assign_web_lead_territory(db as never, {
    p_tenant_id: TENANT, p_territory_id: TERRITORY, p_assigned_to: null,
  }) as { assigned_to: null };
  assert.equal(result.assigned_to, null, "unassignment must be supported");
  assert.equal(db.calls.filter((c) => c.sql.includes("user_profiles")).length, 0, "unassign needs no member lookup");
}

const route = fs.readFileSync(path.join(process.cwd(), "app/api/web-leads/assignments/route.ts"), "utf8");
assert.match(route, /!session\.isAdmin/, "assignment endpoint must be admin-only");
assert.match(route, /session\.tenantId\s*!==\s*WEBDEV_TENANT_ID/, "assignment endpoint must reject other tenants");
assert.match(route, /\.eq\("tenant_id",\s*WEBDEV_TENANT_ID\)/, "assignment roster reads must pin tenant");
assert.match(route, /assign_web_lead_territory/, "route must use the atomic assignment RPC");

console.log("web-leads-assignments ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
