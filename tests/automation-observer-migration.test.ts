import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
async function main() {
  const db = createClient({ url: "file::memory:" });
  try {
    await db.execute("CREATE TABLE health_alert_state(alert_key TEXT PRIMARY KEY,tenant_id TEXT,last_signature TEXT,last_alerted_at TEXT,repeat_n INTEGER NOT NULL DEFAULT 0,first_failed_at TEXT,updated_at TEXT)");
    await db.executeMultiple(readFileSync("database/turso/bravo__258_automation_observer_rsvp.sql", "utf8"));
    const columns = (await db.execute("PRAGMA table_info(health_alert_state)")).rows.map((r) => r.name);
    assert.ok(columns.includes("recent_verdicts_json") && columns.includes("delivery_status"));
    const sql = `INSERT INTO founder_meeting_rsvp_state(tenant_id,appointment_id,revision,event_id,response,observed_at,failures,retry_at)
      VALUES(?,?,?,?,?,?,0,NULL) ON CONFLICT(tenant_id,appointment_id,revision,event_id) DO UPDATE SET
      response=excluded.response,observed_at=excluded.observed_at WHERE founder_meeting_rsvp_state.observed_at<excluded.observed_at`;
    await db.execute({ sql, args: ["tenant-a", "meeting", 1, "event", "declined", "2026-11-09T12:01:00Z"] });
    const stale = await db.execute({ sql, args: ["tenant-a", "meeting", 1, "event", "accepted", "2026-11-09T12:00:00Z"] });
    assert.equal(stale.rowsAffected, 0, "older accepted response cannot overwrite newer decline");
    await db.execute({ sql, args: ["tenant-b", "meeting", 1, "event", "accepted", "2026-11-09T12:00:00Z"] });
    const rows = (await db.execute("SELECT tenant_id,response FROM founder_meeting_rsvp_state ORDER BY tenant_id")).rows;
    assert.equal(rows[0].response, "declined"); assert.equal(rows[1].response, "accepted");
    const tick = { sql: "INSERT OR IGNORE INTO automation_observer_ticks(tenant_id,tick_at) VALUES(?,?)", args: ["tenant-a", "2026-11-09T12:00:00Z"] };
    assert.equal((await db.execute(tick)).rowsAffected, 1); assert.equal((await db.execute(tick)).rowsAffected, 0);
    console.log("automation-observer-migration: OK (in-memory SQL, scoped RSVP CAS and minute claims)");
  } finally { db.close(); }
}
main().catch((error) => { console.error(error); process.exit(1); });
