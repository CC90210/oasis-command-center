import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";

const migration167 = readFileSync(
  "database/turso/167_founder_meeting_closed_loop.turso.sql",
  "utf8",
);
const migration169 = readFileSync(
  "database/turso/169_founder_meeting_reminder_tiers.turso.sql",
  "utf8",
);

async function main() {
const db = createClient({ url: ":memory:" });
await db.execute("PRAGMA foreign_keys = ON");
await db.executeMultiple(`
  CREATE TABLE call_appointments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'lead',
    scheduled_for TEXT NOT NULL,
    assigned_to TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled',
    pre_call_note TEXT,
    outcome_note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  );
  CREATE TABLE lead_interactions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    agent_source TEXT,
    metadata TEXT
  );
  ${migration167}
`);

await db.execute({
  sql: `INSERT INTO call_appointments
    (id, tenant_id, lead_id, scheduled_for, created_by)
    VALUES (?, ?, ?, ?, ?)`,
  args: ["appt-legacy", "tenant-a", "lead-a", "2026-09-01T16:00:00.000Z", "rep-a"],
});
await db.execute({
  sql: `INSERT INTO website_sales_meeting_notifications
    (id, tenant_id, appointment_id, lead_id, kind, channel, due_at,
     recipient, sender_user_id, body, dedupe_key)
    VALUES (?, ?, ?, ?, 'ten_minute', 'sms', ?, ?, ?, ?, ?)`,
  args: [
    "notification-legacy",
    "tenant-a",
    "appt-legacy",
    "lead-a",
    "2026-09-01T15:50:00.000Z",
    "+14165550100",
    "rep-a",
    "Legacy reminder",
    "appt-legacy:1:ten_minute:sms",
  ],
});

await db.executeMultiple(migration169);

const columns = await db.execute("PRAGMA table_info(website_sales_meeting_notifications)");
assert(
  columns.rows.some((row) => row.name === "reminder_minutes_before"),
  "migration 169 adds reminder_minutes_before",
);

const legacy = await db.execute({
  sql: `SELECT kind, reminder_minutes_before, dedupe_key
        FROM website_sales_meeting_notifications WHERE id = ?`,
  args: ["notification-legacy"],
});
assert.deepEqual(
  {
    kind: legacy.rows[0].kind,
    reminder_minutes_before: legacy.rows[0].reminder_minutes_before,
    dedupe_key: legacy.rows[0].dedupe_key,
  },
  {
    kind: "ten_minute",
    reminder_minutes_before: 10,
    dedupe_key: "appt-legacy:1:ten_minute:sms",
  },
  "legacy T-10 rows keep their kind/key and gain the numeric tier",
);

const counts = await db.execute(`
  SELECT
    (SELECT count(*) FROM website_sales_meeting_notifications) AS live_count,
    (SELECT count(*) FROM website_sales_meeting_notifications_v167) AS retired_count
`);
assert.equal(counts.rows[0].live_count, counts.rows[0].retired_count);

const indexes = await db.execute(`
  SELECT name FROM sqlite_schema
  WHERE type = 'index'
    AND name IN (
      'website_sales_meeting_notifications_due_idx',
      'website_sales_meeting_notifications_appointment_idx',
      'website_sales_meeting_notifications_tracking_idx',
      'call_appointments_founder_backfill_idx'
    )
  ORDER BY name
`);
assert.equal(indexes.rows.length, 4, "all original indexes plus the founder backfill index exist");

for (const [id, kind, minutes] of [
  ["notification-60", "reminder_60", 60],
  ["notification-30", "reminder_30", 30],
] as const) {
  await db.execute({
    sql: `INSERT INTO website_sales_meeting_notifications
      (id, tenant_id, appointment_id, lead_id, kind, reminder_minutes_before,
       channel, due_at, recipient, sender_user_id, body, dedupe_key)
      VALUES (?, 'tenant-a', 'appt-legacy', 'lead-a', ?, ?, 'email',
              '2026-09-01T15:00:00.000Z', 'client@example.com', 'rep-a',
              'Tier reminder', ?)`,
    args: [id, kind, minutes, `appt-legacy:1:${kind}:email`],
  });
}

await assert.rejects(
  db.execute({
    sql: `INSERT INTO website_sales_meeting_notifications
      (id, tenant_id, appointment_id, lead_id, kind, channel, due_at,
       recipient, sender_user_id, body, dedupe_key)
      VALUES ('notification-bogus', 'tenant-a', 'appt-legacy', 'lead-a',
              'bogus', 'email', '2026-09-01T15:00:00.000Z',
              'client@example.com', 'rep-a', 'Bogus', 'bogus-key')`,
    args: [],
  }),
  /CHECK constraint failed/i,
);

const fk = await db.execute("PRAGMA foreign_key_check");
assert.equal(fk.rows.length, 0, "rename-aside rebuild preserves foreign-key integrity");

console.log("founder-meeting-reminder-tiers migration: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
