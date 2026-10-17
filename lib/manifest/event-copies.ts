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
 * tenant_id column; its workspace is correlation_id.
 *
 * Turso only (raw SQL); the delete itself runs only there.
 */
import { getTursoClient } from "../turso";

// Where each producer keeps a lead's details: the stage change's whole record
// (data), queued messages (to_email, to_phone), Kixie call webhooks (number,
// recording_url) and SMS handoffs (customer_message). A new producer that
// stores lead details under another name belongs here (Codex on #674).
const DETAIL_PATHS = [
  "$.data", "$.to_email", "$.to_phone", "$.email", "$.phone", "$.name",
  "$.number", "$.recording_url", "$.customer_message",
] as const;

// Sent history keeps its recipient: every *_SENT event, and outbound.recorded,
// which is how /api/outbound/log records a confirmed send (lib/turso-rpc-shim.ts).
const SENT_EVENT_TYPES = ["outbound.recorded"] as const;

// The workspace is correlation_id, agent_events' canonical tenancy
// (docs/SECURITY_POSTURE.md); a row whose payload names another workspace is
// never touched, and one whose payload names none is still cleaned (Codex on
// #674, third pass). record_id names any manifest record (an application, an
// offer), so only a lead's status events match on it; lead_id is always a lead.
const WHERE =
  "correlation_id = ? AND json_valid(payload)" +
  " AND (json_extract(payload, '$.tenant_id') IS NULL OR json_extract(payload, '$.tenant_id') = ?)" +
  " AND ((json_extract(payload, '$.record_id') = ? AND json_extract(payload, '$.entity') = 'lead')" +
  " OR json_extract(payload, '$.lead_id') = ?)" +
  " AND event_type NOT LIKE '%\\_SENT' ESCAPE '\\'" +
  " AND event_type NOT IN (" + SENT_EVENT_TYPES.map((t) => `'${t}'`).join(", ") + ")" +
  " AND (" + DETAIL_PATHS.map((p) => `json_type(payload, '${p}') IS NOT NULL`).join(" OR ") + ")";

/** How many of the lead's events still hold a copy of its details (the dry run). */
export async function countLeadEventCopies(tenantId: string, leadId: string): Promise<number> {
  const found = await getTursoClient().execute({
    sql: `SELECT count(*) AS n FROM agent_events WHERE ${WHERE}`,
    args: [tenantId, tenantId, leadId, leadId],
  });
  return Number(found.rows[0]?.n ?? 0);
}

/** Remove the lead's details from its events; the rows stay. Idempotent. */
export async function removeLeadEventCopies(tenantId: string, leadId: string): Promise<number> {
  const removePaths = DETAIL_PATHS.map((p) => `'${p}'`).join(", ");
  const done = await getTursoClient().execute({
    sql: `UPDATE agent_events SET payload = json_set(json_remove(payload, ${removePaths}), '$.details_removed', 'lead_deleted') WHERE ${WHERE}`,
    args: [tenantId, tenantId, leadId, leadId],
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
