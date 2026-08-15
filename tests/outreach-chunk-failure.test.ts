/**
 * A failed cold-outreach chunk must never vanish quietly.
 *
 * The route used to drop the whole chunk on any insert error, justified by
 * "Partial failures are tolerated — daemon retries pending rows on next tick".
 * Both halves were false, and both were checked before this test was written:
 *
 *   1. No such daemon. `cold_outreach_recipients` is referenced by this route,
 *      the sibling recipients route, and a backup script that only enumerates
 *      table names — nothing else in any repo, and no cron_engine job touches
 *      cold_outreach at all.
 *   2. A failed INSERT leaves no row. "Retries pending rows" cannot recover
 *      recipients that were never written.
 *
 * So the operator's campaign silently had fewer people in it than they chose,
 * total_recipients under-reported, and nothing anywhere recorded it.
 *
 * This asserts the SOURCE contract rather than executing the route, which needs
 * a session, a tenant and a live database. The properties are structural: what
 * the failure branch does, and that it cannot return before writing its audit
 * row. Each assertion was run against the original code and observed to fail.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { REPO_ROOT } from "./_tree";

const ROUTE = `${REPO_ROOT}/app/api/manifest/[slug]/cold-outreach/campaigns/route.ts`;
const SRC = readFileSync(ROUTE, "utf8");

/** Source with comments stripped — the prose quotes the old defect verbatim. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the route still exists and inserts recipients — otherwise this suite is vacuous", () => {
  assert.match(CODE, /from\("cold_outreach_recipients"\)/);
  assert.match(CODE, /\.insert\(chunk\)/);
});

test("no claim of a daemon retrying pending rows survives in the code", () => {
  // The comment may DISCUSS the old lie; the code must not restate it as fact.
  assert.doesNotMatch(
    CODE,
    /daemon retries pending rows/i,
    "the daemon this cited does not exist in any repo",
  );
});

test("a failed chunk is retried row by row rather than discarded", () => {
  assert.match(
    CODE,
    /for \(const row of chunk\)/,
    "one bad row must not cost the other 499",
  );
  assert.match(CODE, /failed_pending_retry/, "salvaged rows must be marked for a human");
});

test("every chunk failure writes an agent_events row", () => {
  assert.match(CODE, /event_type:\s*"outreach_chunk_failed"/);
  assert.match(CODE, /from\("agent_events"\)/);
});

test("the audit row carries what recovery actually needs", () => {
  for (const field of ["tenant_id", "campaign_id", "chunk_index", "lost_cold_lead_ids", "error"]) {
    assert.ok(
      new RegExp(`${field}\\s*:`).test(CODE),
      `agent_events payload must carry ${field} — without it the row cannot be acted on`,
    );
  }
});

test("agent_events is scoped by correlation_id, since the table has no tenant_id column", () => {
  assert.match(CODE, /correlation_id:\s*context\.tenantId/);
});

test("severity is one the CHECK constraint allows", () => {
  // agent_events_severity_check: info | warn | error | critical
  const severities = [...CODE.matchAll(/severity:\s*(?:lost\w*\.length\s*\?\s*)?"(\w+)"(?:\s*:\s*"(\w+)")?/g)]
    .flatMap((m) => [m[1], m[2]])
    .filter(Boolean);
  assert.ok(severities.length > 0, "no severity found — the detector is broken");
  for (const s of severities) {
    assert.ok(["info", "warn", "error", "critical"].includes(s), `"${s}" violates the CHECK`);
  }
});

test("a failure to write the audit row is logged, not swallowed", () => {
  assert.match(CODE, /console\.error\(/, "if even the audit row fails, it must reach the log");
});

test("raw driver messages are redacted before they are persisted or logged", () => {
  // Turso driver errors can carry the database URL. redactAll (lib/secret-redaction)
  // strips env-var secret VALUES and URL key params, and this text goes into a
  // persisted agent_events row and the server log.
  assert.match(CODE, /error:\s*redactAll\(rErr\.message\)/);
  assert.match(CODE, /redactAll\(evErr\.message\)/);
  assert.match(CODE, /redactAll\(countErr\.message\)/);
});

test("no raw driver text reaches the HTTP response", () => {
  // Redaction scrubs secrets, not PII — a UNIQUE violation names the conflicting
  // VALUE, and here that is contact_address: a lead's email or phone. The client
  // gets counts; the detail stays server-side in agent_events.
  assert.doesNotMatch(
    CODE,
    /chunk_errors:/,
    "the response must not carry driver messages, redacted or otherwise",
  );
  assert.match(CODE, /chunks_failed:\s*chunkFailures\.length/);
});

test("a failed total_recipients update is captured, not awaited bare", () => {
  // It used to be `await db...update(...)` with no error binding, so a failed
  // write left the campaign row on a stale count while the response said ok:true.
  assert.match(CODE, /const \{ error: countErr \} = await db/);
  assert.match(CODE, /event_type:\s*"outreach_count_update_failed"/);
  assert.match(CODE, /count_persisted:\s*false/);
});

test("the response distinguishes a partial failure from a clean run", () => {
  assert.match(CODE, /lost_recipients/);
  assert.match(CODE, /flagged_for_retry/);
  assert.match(CODE, /chunks_failed/);
});

test("total_recipients counts the rows that exist, including flagged ones", () => {
  assert.match(CODE, /const recipientTotal = totalInserted \+ flaggedForRetry;/);
  assert.match(CODE, /total_recipients: recipientTotal/);
});
