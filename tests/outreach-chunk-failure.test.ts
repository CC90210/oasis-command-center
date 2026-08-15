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

test("every chunk failure publishes an agent_events row", () => {
  // The event NAME and the publisher, not the call shape. This assertion has
  // now been broken twice by behaviour-preserving refactors — first extracting
  // a local envelope, then delegating to the shared publisher — because it
  // pinned `event_type:` as a literal property and then `from("agent_events")`
  // as a literal call. Both times the row was still written. A contract test
  // that goes red on a refactor teaches people to weaken tests instead of
  // trusting them, so it now asserts the thing that actually has to be true.
  assert.match(CODE, /"outreach_chunk_failed"/);
  assert.match(CODE, /publishAgentEvent\(/);
});

test("audit rows go through the shared publisher, not a hand-rolled insert", () => {
  // lib/manifest/events.publishAgentEvent already knows this table's quirks —
  // no tenant_id column, correlation_id for scope, payload nesting — and logs
  // its own insert failures. I re-derived all of it by hand before noticing it
  // existed one directory over. A second copy is how the two drift apart.
  assert.doesNotMatch(
    CODE,
    /from\("agent_events"\)/,
    "use publishAgentEvent from @/lib/manifest/events instead of inserting directly",
  );
  assert.match(CODE, /from "@\/lib\/manifest\/events"/);
});

test("the audit row carries what recovery actually needs", () => {
  for (const field of ["tenant_id", "campaign_id", "chunk_index", "lost_cold_lead_ids", "error"]) {
    assert.ok(
      new RegExp(`${field}\\s*:`).test(CODE),
      `agent_events payload must carry ${field} — without it the row cannot be acted on`,
    );
  }
});

test("EVERY publisher call is tenant-scoped, not just one of them", () => {
  // Counted, not matched.
  //
  // The first version asserted `tenantId: context.tenantId` appears. It does —
  // twice — so breaking ONE call still left the other for the regex to find,
  // and a break-probe caught the assertion passing against code it was supposed
  // to reject. An existence check over a repeated construct tests the first
  // occurrence and nothing else.
  //
  // agent_events has no tenant_id column: the route hands tenantId to
  // publishAgentEvent and the helper stamps correlation_id. A call that forgets
  // it writes an unscoped audit row.
  const calls = (CODE.match(/publishAgentEvent\(\{/g) || []).length;
  const scoped = (CODE.match(/tenantId:\s*context\.tenantId/g) || []).length;
  assert.ok(calls > 0, "no publishAgentEvent calls found — the detector is broken");
  assert.equal(scoped, calls, `${calls} publisher call(s) but only ${scoped} pass tenantId`);
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

test("a failed write reaches the log, not just the response", () => {
  // The count-update failure logs here. The audit-row failure logs inside
  // publishAgentEvent, which is the helper's documented guarantee — see its
  // comment about a failed publish otherwise looking identical to a successful
  // one. Neither path is silent; they just log from different places now.
  assert.match(CODE, /console\.error\(/);
});

test("raw driver messages are redacted before they are persisted or logged", () => {
  // Turso driver errors can carry the database URL. redactAll (lib/secret-redaction)
  // strips env-var secret VALUES and URL key params, and this text goes into a
  // persisted agent_events row and the server log.
  assert.match(CODE, /error:\s*redactAll\(rErr\.message\)/);
  assert.match(CODE, /redactAll\(countErr\.message\)/);
  // No evErr assertion any more, and that is correct rather than a gap: the
  // route no longer inspects the audit insert's own error, because
  // publishAgentEvent is best-effort by design and logs its failures itself.
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
  // Bounded recovery: one retry, then a loud give-up. Not unbounded — that
  // turns a genuinely broken write into a hung request.
  assert.match(CODE, /let countErr = await writeCount\(\);/);
  assert.match(CODE, /if \(countErr\) countErr = await writeCount\(\);/);
  assert.match(CODE, /attempts: 2/);
  assert.match(CODE, /"outreach_count_update_failed"/);
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
