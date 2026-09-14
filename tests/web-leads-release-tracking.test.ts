import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "web-leads-release-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;

const REP = "22222222-2222-4222-8222-222222222222";

async function main() {
  const { WEBDEV_TENANT_ID } = await import("../lib/web-leads/tenant");
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL
    );
    CREATE TABLE tenant_records (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL,
      data TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE lead_interactions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT, lead_id TEXT, type TEXT, channel TEXT, direction TEXT,
      agent_source TEXT, actor_user_id TEXT, subject TEXT, content TEXT,
      content_preview TEXT, metadata TEXT, created_at TEXT
    );
  `);
  await db.execute({
    sql: "INSERT INTO tenants (id, slug) VALUES (?, 'oasis-ai-cc')",
    args: [WEBDEV_TENANT_ID],
  });
  const insertLead = async (id: string, overrides: Record<string, unknown> = {}) => {
    await db.execute({
      sql: `INSERT INTO tenant_records
            (id, tenant_id, entity_type, data, created_at, updated_at)
            VALUES (?, ?, 'lead', ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
      args: [
        id,
        WEBDEV_TENANT_ID,
        JSON.stringify({
          name: id,
          assigned_to: REP,
          claimed_at: "2026-09-01T00:00:00.000Z",
          stage: "assigned",
          ...overrides,
        }),
      ],
    });
  };

  await insertLead("lead-expired");
  await db.execute({
    sql: "UPDATE tenant_records SET data = json_set(data, '$.claimed_at', '2000-01-01T00:00:00.000Z') WHERE id = ?",
    args: ["lead-expired"],
  });
  const { assertMayWorkLead } = await import("../lib/leads/rep-lead-access");
  const { releaseLeads } = await import("../lib/web-leads/claim-ops");
  const expiredAccess = await assertMayWorkLead({
    teamRole: "opener",
    userId: REP,
    tenantId: WEBDEV_TENANT_ID,
    leadId: "lead-expired",
    accessMode: "owned_oasis_sales",
  });
  assert.deepEqual(expiredAccess, {
    ok: false,
    status: 409,
    error: "claim_released",
    message: "This claim has returned to the Leads pool. Claim it again before working it.",
  });

  await insertLead("lead-dnc");
  await db.execute({
    sql: "UPDATE tenant_records SET data = json_set(data, '$.dnc', 1) WHERE id = ?",
    args: ["lead-dnc"],
  });
  const dncAccess = await assertMayWorkLead({
    teamRole: "opener",
    userId: REP,
    tenantId: WEBDEV_TENANT_ID,
    leadId: "lead-dnc",
    accessMode: "owned_oasis_sales",
  });
  assert.deepEqual(dncAccess, {
    ok: false,
    status: 409,
    error: "do_not_call",
    message: "This lead is on the do-not-call list and cannot be worked.",
  });

  await insertLead("lead-dnc-collaborator", {
    assigned_to: "33333333-3333-4333-8333-333333333333",
    collaborators: [REP],
    dnc: true,
  });
  const collaboratorDncAccess = await assertMayWorkLead({
    teamRole: "opener",
    userId: REP,
    tenantId: WEBDEV_TENANT_ID,
    leadId: "lead-dnc-collaborator",
    accessMode: "owned_oasis_sales",
  });
  assert.deepEqual(
    collaboratorDncAccess,
    {
      ok: false,
      status: 409,
      error: "do_not_call",
      message: "This lead is on the do-not-call list and cannot be worked.",
    },
    "do-not-call is organization-wide even when the caller is a collaborator rather than the assignee",
  );

  await insertLead("lead-post-handoff", { stage: "won" });
  const refusedPostHandoff = await releaseLeads(REP, false, ["lead-post-handoff"]);
  assert.deepEqual(refusedPostHandoff.released, []);
  assert.deepEqual(refusedPostHandoff.refused, ["lead-post-handoff"]);
  const refusedAdminPostHandoff = await releaseLeads(
    "44444444-4444-4444-8444-444444444444",
    true,
    ["lead-post-handoff"],
  );
  assert.deepEqual(refusedAdminPostHandoff.released, []);
  assert.deepEqual(
    refusedAdminPostHandoff.refused,
    ["lead-post-handoff"],
    "admin access does not turn the prospect release operation into a paid-workflow repair tool",
  );
  const postHandoffRow = await db.execute({
    sql: "SELECT data FROM tenant_records WHERE id = ?",
    args: ["lead-post-handoff"],
  });
  const postHandoffData = JSON.parse(String(postHandoffRow.rows[0].data)) as Record<string, unknown>;
  assert.equal(postHandoffData.assigned_to, REP, "release must not detach a paid workflow record");

  await insertLead("lead-release-ok");
  const first = await releaseLeads(REP, false, ["lead-release-ok"]);
  assert.deepEqual(first.released, ["lead-release-ok"]);
  assert.deepEqual(first.refused, []);
  assert.deepEqual(first.trackingFailed, [], "a persisted release interaction must report clean tracking");

  const releasedRow = await db.execute({
    sql: "SELECT data FROM tenant_records WHERE id = ?",
    args: ["lead-release-ok"],
  });
  const releasedData = JSON.parse(String(releasedRow.rows[0].data)) as Record<string, unknown>;
  assert.equal(releasedData.assigned_to, null);
  assert.equal(releasedData.claimed_at, null);

  const audit = await db.execute({
    sql: "SELECT type, agent_source, actor_user_id, metadata FROM lead_interactions WHERE lead_id = ?",
    args: ["lead-release-ok"],
  });
  assert.equal(audit.rows.length, 1, "one confirmed release must append one interaction");
  assert.equal(audit.rows[0].type, "lead_reassigned");
  assert.equal(audit.rows[0].agent_source, "web_leads_release");
  assert.equal(audit.rows[0].actor_user_id, REP);
  const metadata = JSON.parse(String(audit.rows[0].metadata)) as Record<string, unknown>;
  assert.equal(metadata.action, "release");
  assert.equal(metadata.from_assigned_to, REP);
  assert.equal(metadata.assigned_to, null);

  // Ownership is already changed when tracking fails. The result must name
  // that partial failure instead of claiming the operation was fully tracked.
  await insertLead("lead-release-untracked");
  await db.execute("DROP TABLE lead_interactions");
  const priorError = console.error;
  console.error = () => undefined;
  const second = await releaseLeads(REP, false, ["lead-release-untracked"]);
  console.error = priorError;
  assert.deepEqual(second.released, ["lead-release-untracked"]);
  assert.deepEqual(second.trackingFailed, ["lead-release-untracked"]);

  console.log("web-leads-release-tracking ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
