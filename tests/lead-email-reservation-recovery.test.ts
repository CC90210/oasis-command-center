import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";

import { TENANT_ID_BRAND } from "../lib/email/brand-for-tenant";
import { recoverStaleDashboardEmailReservations } from "../lib/leads/dashboard-email-reservations";
import { createTursoPostgrest } from "../lib/turso-postgrest";

const OASIS_TENANT = Object.entries(TENANT_ID_BRAND).find(([, brand]) => brand === "oasis")?.[0];
assert.ok(OASIS_TENANT, "the recovery job needs an explicitly mapped OASIS tenant");

async function main() {
const client = createClient({ url: "file::memory:?cache=shared" });
await client.execute(`
  CREATE TABLE lead_interactions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    type TEXT NOT NULL,
    agent_source TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL
  )
`);

async function seed(
  id: string,
  tenantId: string,
  status: string,
  createdAt: string,
  attemptToken?: string,
) {
  await client.execute({
    sql: `INSERT INTO lead_interactions
          (id, tenant_id, type, agent_source, metadata, created_at)
          VALUES (?, ?, 'email_queued', 'dashboard_drawer', ?, ?)`,
    args: [
      id,
      tenantId,
      JSON.stringify({ status, requested_by_email: "rep@oasisai.work", ...(attemptToken ? { attempt_token: attemptToken } : {}) }),
      createdAt,
    ],
  });
}

const now = new Date("2026-09-14T16:00:00.000Z");
await seed("reserved-old", OASIS_TENANT, "direct_reserved", "2026-09-14T15:50:00.000Z", "token-reserved");
// No token intentionally: rows written by the previous release must also be
// frozen safely instead of remaining invisible forever.
await seed("attempting-old", OASIS_TENANT, "direct_attempting", "2026-09-14T15:49:00.000Z");
await seed("reserved-fresh", OASIS_TENANT, "direct_reserved", "2026-09-14T15:58:00.000Z", "token-fresh");
await seed("sent-old", OASIS_TENANT, "sent", "2026-09-14T15:40:00.000Z", "token-sent");
await seed("foreign-old", "11111111-1111-4111-8111-111111111111", "direct_reserved", "2026-09-14T15:40:00.000Z", "token-foreign");

const db = createTursoPostgrest(client) as unknown as SupabaseClient;
const result = await recoverStaleDashboardEmailReservations({
  db,
  now,
  staleAfterMs: 5 * 60_000,
});

assert.deepEqual(result, {
  inspected: 2,
  queued: 1,
  delivery_unknown: 1,
  raced: 0,
  errors: 0,
});

const rows = await client.execute(
  `SELECT id, metadata FROM lead_interactions ORDER BY id`,
);
const statuses = Object.fromEntries(
  rows.rows.map((row) => {
    const metadata = JSON.parse(String(row.metadata)) as Record<string, unknown>;
    return [String(row.id), metadata];
  }),
) as Record<string, Record<string, unknown>>;

assert.equal(statuses["reserved-old"].status, "queued");
assert.equal(statuses["reserved-old"].queue_reason, "stale_pre_dispatch_reservation_recovered");
assert.equal(statuses["reserved-old"].attempt_token, "token-reserved");

assert.equal(statuses["attempting-old"].status, "delivery_unknown");
assert.equal(statuses["attempting-old"].needs_operator_review, true);
assert.equal(statuses["attempting-old"].send_error, "uncertain_delivery_after_direct_attempt");

assert.equal(statuses["reserved-fresh"].status, "direct_reserved");
assert.equal(statuses["sent-old"].status, "sent");
assert.equal(statuses["foreign-old"].status, "direct_reserved");

const cronRoute = readFileSync("app/api/cron/dispatch-scheduled-sends/route.ts", "utf8");
assert.match(
  cronRoute,
  /checkCronAuth\(req\)[\s\S]*?recoverStaleDashboardEmailReservations\(\{ db \}\)/,
  "reservation recovery must run behind cron auth",
);
assert.match(
  cronRoute,
  /dashboard_email_recovery: dashboardEmailRecovery/,
  "the cron response must expose recovery counts for operations visibility",
);

console.log("lead email reservation recovery tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
