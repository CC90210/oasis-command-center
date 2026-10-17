/**
 * lib/manifest/event-copies.ts - a deleted lead's details must not outlive it
 * in agent_events.
 *
 * Events about a lead carry copies of its details: a stage change publishes
 * the whole record as payload.data (lib/manifest/events.ts, so drips can fill
 * in {{lead.first_name}}), and a queued dashboard email keeps to_email. After
 * the lead is deleted nothing reads them (the drip enroller reads
 * tenant_records), so they are only personal details outliving the lead (live
 * E2E of #669, and Codex on #674).
 *
 * This removes those fields and keeps the event rows, so history and its counts
 * do. A SENT message keeps its recipient: that is the record of what went out,
 * as sent history is everywhere else in the delete. agent_events has no
 * tenant_id column, so the tenant is the payload's.
 *
 * Turso only (raw SQL); the delete itself runs only there.
 */
import { getTursoClient } from "../turso";

const DETAIL_PATHS = ["$.data", "$.to_email", "$.to_phone", "$.email", "$.phone", "$.name"] as const;

// record_id names any manifest record (an application, an offer), so only a
// lead's status events match on it; lead_id is always a lead (Codex on #674).
const WHERE =
  "json_valid(payload) AND json_extract(payload, '$.tenant_id') = ?" +
  " AND ((json_extract(payload, '$.record_id') = ? AND json_extract(payload, '$.entity') = 'lead')" +
  " OR json_extract(payload, '$.lead_id') = ?)" +
  " AND event_type NOT LIKE '%\\_SENT' ESCAPE '\\'" +
  " AND (" + DETAIL_PATHS.map((p) => `json_type(payload, '${p}') IS NOT NULL`).join(" OR ") + ")";

/** How many of the lead's events still hold a copy of its details (the dry run). */
export async function countLeadEventCopies(tenantId: string, leadId: string): Promise<number> {
  const found = await getTursoClient().execute({
    sql: `SELECT count(*) AS n FROM agent_events WHERE ${WHERE}`,
    args: [tenantId, leadId, leadId],
  });
  return Number(found.rows[0]?.n ?? 0);
}

/** Remove the lead's details from its events; the rows stay. Idempotent. */
export async function removeLeadEventCopies(tenantId: string, leadId: string): Promise<number> {
  const removePaths = DETAIL_PATHS.map((p) => `'${p}'`).join(", ");
  const done = await getTursoClient().execute({
    sql: `UPDATE agent_events SET payload = json_set(json_remove(payload, ${removePaths}), '$.details_removed', 'lead_deleted') WHERE ${WHERE}`,
    args: [tenantId, leadId, leadId],
  });
  return done.rowsAffected;
}

/**
 * The other half of the delete's cleanup, for an event written while the
 * record was being deleted (a stage change racing an owner's Delete lead,
 * Codex on #674): called right after the event is inserted, it removes the
 * copy when the record is already gone. With the delete removing copies after
 * the row goes, every interleaving ends with no copy: an event written before
 * the delete's cleanup is caught by it, and one written after finds the row gone.
 */
export async function removeCopiesIfRecordGone(tenantId: string, recordId: string): Promise<number> {
  const raw = getTursoClient();
  const exists = await raw.execute({
    sql: "SELECT 1 FROM tenant_records WHERE tenant_id = ? AND id = ? LIMIT 1",
    args: [tenantId, recordId],
  });
  if (exists.rows.length) return 0;
  return removeLeadEventCopies(tenantId, recordId);
}
