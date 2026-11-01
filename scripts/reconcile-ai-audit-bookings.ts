/** Scoped maintenance: preview by default; --apply opens/links only the named leads' verified future bookings. */
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { autoOpenForBookedMeetings } from "../lib/ai-audit/auto-open";

async function main() {
  const args = process.argv.slice(2);
  assert(args.every(arg => arg === "--apply" || arg.startsWith("--tenant=") || arg.startsWith("--lead=")), "unknown argument");
  const tenantId = args.find(arg => arg.startsWith("--tenant="))?.slice(9) ?? "";
  const leadIds = [...new Set(args.filter(arg => arg.startsWith("--lead=")).map(arg => arg.slice(7)))];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert(uuid.test(tenantId) && leadIds.length > 0 && leadIds.length <= 10 && leadIds.every(id => uuid.test(id)), "supply --tenant=<uuid> and one to ten --lead=<uuid>");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  try {
    const now = new Date();
    const bookings = await db.execute({
      sql: `SELECT id, lead_id, scheduled_for, meet_room_id FROM call_appointments WHERE tenant_id=?
            AND lead_id IN (${leadIds.map(() => "?").join(",")}) AND meeting_kind='founder_audit' AND status='scheduled'
            AND workflow_status='active' AND calendar_status='verified' AND scheduled_for > ? ORDER BY scheduled_for`,
      args: [tenantId, ...leadIds, now.toISOString()],
    });
    for (const id of leadIds) assert.equal(bookings.rows.filter(row => row.lead_id === id).length, 1, `exactly one verified future booking is required for ${id}`);
    assert(bookings.rows.every(row => row.meet_room_id), "each booking must have a Meet room before reconciliation");
    if (!args.includes("--apply")) {
      console.log(JSON.stringify({ apply: false, bookings: bookings.rows }, null, 2));
      return;
    }
    const errors: string[] = [];
    const result = await autoOpenForBookedMeetings(db, { tenantId, leadIds, now, onError: id => errors.push(id) });
    assert.equal(errors.length, 0, "some bookings could not be reconciled");
    const after = await db.execute({
      sql: `SELECT id,lead_id,stage,appointment_id,meet_room_id FROM ai_audit_engagements WHERE tenant_id=? AND lead_id IN (${leadIds.map(() => "?").join(",")}) AND closed_at IS NULL ORDER BY lead_id`,
      args: [tenantId, ...leadIds],
    });
    assert.equal(after.rows.length, leadIds.length);
    for (const row of after.rows) {
      const booking = bookings.rows.find(item => item.lead_id === row.lead_id)!;
      assert.equal(row.appointment_id, booking.id);
      assert.equal(row.meet_room_id, booking.meet_room_id);
    }
    const replay = await autoOpenForBookedMeetings(db, { tenantId, leadIds, now, onError: id => errors.push(id) });
    assert.deepEqual(replay, { opened: 0, linked: 0 });
    assert.equal(errors.length, 0);
    console.log(JSON.stringify({ result, replay, verified: after.rows }, null, 2));
  } finally { db.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
