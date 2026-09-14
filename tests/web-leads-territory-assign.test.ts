/**
 * tests/web-leads-territory-assign.test.ts
 *
 * Build B — territory assignment. Covers:
 *   1. Route source: admin-only enforcement, tenant mismatch -> 403, and the
 *      order of checks (both routes fail closed before any read/write).
 *   2. assignTerritory() against a fake PostgREST-shaped client: propagation
 *      hits only the right leads and preserves their other data fields,
 *      partial batch failure is reported rather than hidden, and -- the
 *      rule that matters most -- unassigning a territory NEVER writes to
 *      tenant_records, so a rep's in-progress leads keep their owner.
 *   3. The pure helpers (chunk, withAssignedTo, isUuid) in isolation.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assignTerritory,
  chunk,
  isTerritoryAssignmentEligible,
  withAssignedTo,
  isUuid,
} from "@/lib/web-leads/assign";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

const TENANT = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const TERRITORY = "11111111-1111-4111-8111-111111111111";
const OTHER_TERRITORY = "99999999-9999-4999-8999-999999999999";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";
const SOURCE_REP = "44444444-4444-4444-8444-444444444444";

// ---------------------------------------------------------------------------
// 1. Route source assertions -- same style as tests/web-leads-guards.test.ts.
// ---------------------------------------------------------------------------
{
  const assignRoute = "app/api/web-leads/territories/[id]/assign/route.ts";
  const src = read(assignRoute);
  assert.match(src, /resolveSessionContext/, `${assignRoute} must resolve the caller`);
  assert.match(src, /if\s*\(\s*!\s*session\.ok\s*\)/, `${assignRoute} must branch on session.ok`);
  assert.match(src, /status:\s*401/, `${assignRoute} must fail closed on an unresolved caller`);
  assert.match(
    src,
    /session\.tenantId\s*!==\s*WEBDEV_TENANT_ID/,
    `${assignRoute} must reject a caller resolved to a different tenant`,
  );
  assert.match(
    src,
    /!\s*session\.isAdmin/,
    `${assignRoute} must be admin-only -- reps must not assign territories to themselves or others`,
  );
  // Ordering: unauthenticated (401) must be checked before the tenant check,
  // which must be checked before the admin check, which must be checked
  // before the body is ever parsed. A route that reads the body first could
  // be used to probe validation before authorization.
  const iSession = src.indexOf("session.ok");
  const iTenant = src.indexOf("session.tenantId !== WEBDEV_TENANT_ID");
  const iAdmin = src.indexOf("!session.isAdmin");
  const iBody = src.indexOf("req.json()");
  assert.ok(iSession >= 0 && iTenant > iSession, "session check must precede the tenant check");
  assert.ok(iAdmin > iTenant, "admin check must precede body parsing setup");
  assert.ok(iBody > iAdmin, "body must not be read until after every auth check");
  assert.match(
    src,
    /assignTerritory\(\{\s*territoryId:\s*id,\s*assignedTo,\s*actorUserId:\s*session\.userId,?\s*\}\)/,
    "the authenticated actor must be passed into per-lead audit entries",
  );

  const listRoute = "app/api/web-leads/territories/route.ts";
  const listSrc = read(listRoute);
  assert.match(listSrc, /session\.tenantId\s*!==\s*WEBDEV_TENANT_ID/, `${listRoute} must reject other tenants`);
  assert.match(listSrc, /!\s*session\.isAdmin/, `${listRoute} must be admin-only`);
}

// ---------------------------------------------------------------------------
// 2. Fake PostgREST-shaped client. Chainable AND awaitable/maybeSingle-able,
//    matching the exact call shapes lib/web-leads/assign.ts makes.
// ---------------------------------------------------------------------------
type Call = {
  table: string;
  mode: "select" | "update" | "insert";
  eqs: Record<string, unknown>;
  filters: [string, string, unknown][];
  ors: string[];
  cols?: string;
  opts?: { count?: string; head?: boolean };
  payload?: Record<string, unknown> | Record<string, unknown>[];
  limit?: number;
};
type Responder = (call: Call) => { data: unknown; error: { message: string } | null; count?: number };

function makeFakeDb(responder: Responder) {
  const calls: Call[] = [];
  function from(table: string) {
    const state: Call = { table, mode: "select", eqs: {}, filters: [], ors: [] };
    function terminal() {
      calls.push(JSON.parse(JSON.stringify(state)));
      return Promise.resolve(responder(state));
    }
    const chain = {
      select(cols?: string, opts?: { count?: string; head?: boolean }) {
        state.cols = cols;
        state.opts = opts;
        return chain;
      },
      update(payload: Record<string, unknown>) {
        state.mode = "update";
        state.payload = payload;
        return chain;
      },
      insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
        state.mode = "insert";
        state.payload = payload;
        return terminal();
      },
      eq(c: string, v: unknown) {
        state.eqs[c] = v;
        return chain;
      },
      filter(c: string, op: string, v: unknown) {
        state.filters.push([c, op, v]);
        return chain;
      },
      or(predicate: string) {
        state.ors.push(predicate);
        return chain;
      },
      limit(n: number) {
        state.limit = n;
        return chain;
      },
      maybeSingle() {
        return terminal();
      },
      then(onfulfilled: (v: unknown) => unknown, onrejected?: (e: unknown) => unknown) {
        return terminal().then(onfulfilled, onrejected);
      },
    };
    return chain;
  }
  return { from, calls } as unknown as SupabaseClient & { calls: Call[] };
}

const LEADS = [
  {
    id: "lead-a",
    updated_at: "2026-09-14T10:00:00.000Z",
    data: { webdev_territory_id: TERRITORY, business_name: "A Salon", assigned_to: null },
  },
  {
    id: "lead-b",
    updated_at: "2026-09-14T10:01:00.000Z",
    data: {
      webdev_territory_id: TERRITORY,
      business_name: "B Salon",
      assigned_to: null,
      stage: "researched",
      lead_source_track: "self",
    },
  },
  {
    id: "lead-c",
    updated_at: "2026-09-14T10:02:00.000Z",
    data: {
      webdev_territory_id: TERRITORY,
      business_name: "C Salon",
      assigned_to: "old-rep",
      stage: "qualified",
      lead_source_track: "self",
      claimed_at: "2026-09-01T00:00:00.000Z",
    },
  },
  { id: "lead-d", updated_at: "2026-09-14T10:03:00.000Z", data: { webdev_territory_id: TERRITORY, assigned_to: "old-rep", stage: "won" } },
  { id: "lead-e", updated_at: "2026-09-14T10:04:00.000Z", data: { webdev_territory_id: TERRITORY, assigned_to: "builder", stage: "in_build" } },
  { id: "lead-f", updated_at: "2026-09-14T10:05:00.000Z", data: { webdev_territory_id: TERRITORY, assigned_to: "old-rep", stage: "lost" } },
  { id: "lead-g", updated_at: "2026-09-14T10:06:00.000Z", data: { webdev_territory_id: TERRITORY, assigned_to: null, stage: "researched", dnc: true } },
];

/** Standard responder: territory + member exist, tenant_records read returns LEADS. */
function baseResponder(overrides: Partial<Record<string, Responder>> = {}): Responder {
  return (call) => {
    if (overrides[call.table]) return overrides[call.table]!(call);
    if (call.table === "leadgen_territories" && call.mode === "update") {
      return { data: [{ id: TERRITORY }], error: null };
    }
    if (call.table === "user_profiles") {
      return { data: { auth_user_id: AGENT }, error: null };
    }
    if (call.table === "tenant_records" && call.mode === "select" && call.opts?.head) {
      return { data: null, error: null, count: 2 };
    }
    if (call.table === "tenant_records" && call.mode === "select") {
      return { data: LEADS, error: null };
    }
    if (call.table === "tenant_records" && call.mode === "update") {
      return { data: [{ id: call.eqs.id }], error: null };
    }
    if (call.table === "lead_interactions" && call.mode === "insert") {
      return { data: null, error: null };
    }
    throw new Error(`unexpected call: ${call.table}/${call.mode}`);
  };
}

async function main() {
  // ---- Assign: propagation hits only the matching leads, preserving data ---
  {
    const db = makeFakeDb(baseResponder());
    const result = await assignTerritory({ territoryId: TERRITORY, assignedTo: AGENT.toUpperCase(), actorUserId: ACTOR }, db);
    assert.equal(result.ok, true);
    if (result.ok && result.mode === "assigned") {
      assert.equal(result.assignedTo, AGENT, "assignee must be normalized to lowercase");
      assert.equal(result.leadsMatched, 7);
      assert.equal(result.leadsUpdated, 2);
      assert.equal(result.leadsSkipped, 5);
      assert.equal(result.leadsRaced, 0);
      assert.equal(result.leadsFailed, 0);
      assert.equal(result.trackingFailed, 0);
    } else {
      assert.fail("expected an 'assigned' result");
    }

    const territoryUpdate = db.calls.find((c) => c.table === "leadgen_territories" && c.mode === "update");
    assert.ok(territoryUpdate, "must write leadgen_territories.assigned_to");
    assert.equal(territoryUpdate!.payload!.assigned_to, AGENT, "territory write must carry the normalized id");

    const leadRead = db.calls.find((c) => c.table === "tenant_records" && c.mode === "select" && !c.opts?.head);
    assert.ok(leadRead, "must read the territory's leads");
    assert.deepEqual(leadRead!.filters, [["data->>webdev_territory_id", "eq", TERRITORY]], "must scope the read to this territory only");
    assert.equal(leadRead!.eqs.tenant_id, TENANT, "lead read must pin the tenant");
    assert.equal(leadRead!.eqs.entity_type, "lead", "lead read must be scoped to entity_type=lead");

    const leadWrites = db.calls.filter((c) => c.table === "tenant_records" && c.mode === "update");
    assert.equal(leadWrites.length, 2, "only untouched pool rows may be written");
    for (const w of leadWrites) {
      assert.equal(w.payload!.data && (w.payload!.data as Record<string, unknown>).assigned_to, AGENT);
      assert.equal(w.eqs.tenant_id, TENANT);
      assert.equal(w.eqs.entity_type, "lead");
      assert.equal(
        w.eqs.updated_at,
        LEADS.find((lead) => lead.id === w.eqs.id)!.updated_at,
        "the write must compare-and-swap the exact row version read",
      );
      assert.deepEqual(
        w.ors,
        ['data->>assigned_to.is.null,data->>assigned_to.eq.""'],
        "the write must also prove the row is still unowned",
      );
    }
    // Other fields on an eligible pool lead survive, while stale source credit
    // is reset because the new rep did not originate the lead.
    const bWrite = leadWrites.find((w) => w.eqs.id === "lead-b")!;
    assert.equal((bWrite.payload!.data as Record<string, unknown>).business_name, "B Salon");
    assert.equal((bWrite.payload!.data as Record<string, unknown>).stage, "assigned");
    assert.equal((bWrite.payload!.data as Record<string, unknown>).lead_source_track, "company");

    assert.equal(
      leadWrites.some((w) => w.eqs.id === "lead-c"),
      false,
      "territory propagation must not reassign an active self-sourced lead",
    );
    assert.deepEqual(
      LEADS.find((lead) => lead.id === "lead-c")!.data,
      {
        webdev_territory_id: TERRITORY,
        business_name: "C Salon",
        assigned_to: "old-rep",
        stage: "qualified",
        lead_source_track: "self",
        claimed_at: "2026-09-01T00:00:00.000Z",
      },
      "skipped active rows must retain owner, stage, and self-source provenance",
    );

    const auditCalls = db.calls.filter((c) => c.table === "lead_interactions" && c.mode === "insert");
    assert.equal(auditCalls.length, 1, "successful territory intake must write an audit batch");
    const auditRows = auditCalls[0].payload as Record<string, unknown>[];
    assert.deepEqual(auditRows.map((row) => row.lead_id).sort(), ["lead-a", "lead-b"]);
    for (const row of auditRows) {
      assert.equal(row.tenant_id, TENANT);
      assert.equal(row.actor_user_id, ACTOR);
      assert.equal(row.agent_source, "web_leads_territory_assign");
      const metadata = row.metadata as Record<string, unknown>;
      assert.equal(metadata.assigned_to, AGENT);
      assert.equal(metadata.lead_source_track, "company");
      assert.equal(metadata.to_stage, "assigned");
    }
  }

  // ---- Assign: a failed batch is reported, not swallowed ------------------
  {
    const db = makeFakeDb(
      baseResponder({
        tenant_records: (call) => {
          if (call.mode === "select") return { data: LEADS, error: null };
          // One of the two eligible pool writes fails; skipped active rows are
          // never attempted and therefore are not misreported as failures.
          if (call.eqs.id === "lead-b") return { data: null, error: { message: "conflict" } };
          return { data: [{ id: call.eqs.id }], error: null };
        },
      }),
    );
    const result = await assignTerritory({ territoryId: TERRITORY, assignedTo: AGENT, actorUserId: ACTOR }, db);
    assert.equal(result.ok, true);
    if (result.ok && result.mode === "assigned") {
      assert.equal(result.leadsMatched, 7);
      assert.equal(result.leadsUpdated, 1, "the eligible lead that succeeded must still count as updated");
      assert.equal(result.leadsSkipped, 5, "protected rows are reported separately from failed writes");
      assert.equal(result.leadsRaced, 0);
      assert.equal(result.leadsFailed, 1, "the failed lead must be counted, never silently dropped");
      assert.equal(result.trackingFailed, 0);
      assert.match(result.message, /1 failed/, "the response must say a batch partially failed");
    } else {
      assert.fail("expected an 'assigned' result");
    }
  }

  // ---- Assign: a lead claimed after the read loses the CAS, not its owner ---
  {
    const db = makeFakeDb(
      baseResponder({
        tenant_records: (call) => {
          if (call.mode === "select") return { data: LEADS, error: null };
          if (call.eqs.id === "lead-b") return { data: [], error: null };
          return { data: [{ id: call.eqs.id }], error: null };
        },
      }),
    );
    const result = await assignTerritory({ territoryId: TERRITORY, assignedTo: AGENT, actorUserId: ACTOR }, db);
    assert.equal(result.ok, true);
    if (result.ok && result.mode === "assigned") {
      assert.equal(result.leadsUpdated, 1);
      assert.equal(result.leadsSkipped, 5);
      assert.equal(result.leadsRaced, 1, "a concurrent claim must be counted as a lost race");
      assert.equal(result.leadsFailed, 0, "a clean CAS miss is not a database failure");
      assert.equal(result.trackingFailed, 0);
      assert.match(result.message, /1 changed while assigning/i);
    } else {
      assert.fail("expected an 'assigned' result");
    }
  }

  // ---- Assign: audit failure is surfaced without inventing history ---------
  {
    const db = makeFakeDb(
      baseResponder({
        lead_interactions: () => ({ data: null, error: { message: "audit unavailable" } }),
      }),
    );
    const result = await assignTerritory({ territoryId: TERRITORY, assignedTo: AGENT, actorUserId: ACTOR }, db);
    assert.equal(result.ok, true);
    if (result.ok && result.mode === "assigned") {
      assert.equal(result.leadsUpdated, 2);
      assert.equal(result.trackingFailed, 2, "each successful ownership write without an audit row must be counted");
      assert.match(result.message, /2 audit entr/i);
    } else {
      assert.fail("expected an 'assigned' result");
    }
  }

  // ---- Unassign: NEVER writes to tenant_records ----------------------------
  {
    const db = makeFakeDb(baseResponder());
    const result = await assignTerritory({ territoryId: TERRITORY, assignedTo: null, actorUserId: ACTOR }, db);
    assert.equal(result.ok, true);
    if (result.ok && result.mode === "unassigned") {
      assert.equal(result.assignedTo, null);
      assert.equal(result.leadsPreserved, 2);
      assert.match(result.message, /keep their current owner/);
    } else {
      assert.fail("expected an 'unassigned' result");
    }

    const territoryUpdate = db.calls.find((c) => c.table === "leadgen_territories" && c.mode === "update");
    assert.ok(territoryUpdate, "must still clear leadgen_territories.assigned_to");
    assert.equal(territoryUpdate!.payload!.assigned_to, null);

    const leadWrites = db.calls.filter((c) => c.table === "tenant_records" && c.mode === "update");
    assert.equal(leadWrites.length, 0, "unassigning must NEVER write to a lead's own data.assigned_to");

    const memberChecks = db.calls.filter((c) => c.table === "user_profiles");
    assert.equal(memberChecks.length, 0, "unassign needs no assignee membership check");
  }

  // ---- Territory not found: 404, no lead reads/writes attempted -----------
  {
    const db = makeFakeDb(
      baseResponder({
        leadgen_territories: () => ({ data: [], error: null }),
      }),
    );
    const result = await assignTerritory({ territoryId: OTHER_TERRITORY, assignedTo: AGENT, actorUserId: ACTOR }, db);
    assert.deepEqual(result, { ok: false, status: 404, error: "territory_not_found" });
    assert.equal(db.calls.filter((c) => c.table === "tenant_records").length, 0, "must not touch leads for a territory that doesn't exist");
  }

  // ---- Assignee not a tenant member: rejected before any territory write --
  {
    const db = makeFakeDb(
      baseResponder({
        user_profiles: () => ({ data: null, error: null }),
      }),
    );
    const result = await assignTerritory({ territoryId: TERRITORY, assignedTo: AGENT, actorUserId: ACTOR }, db);
    assert.deepEqual(result, { ok: false, status: 400, error: "assignee_not_in_tenant" });
    assert.equal(
      db.calls.filter((c) => c.table === "leadgen_territories" && c.mode === "update").length,
      0,
      "an invalid assignee must never be partially applied to the territory row",
    );
  }

  // ---- Bad input shapes -----------------------------------------------------
  {
    const db = makeFakeDb(baseResponder());
    assert.deepEqual(
      await assignTerritory({ territoryId: "not-a-uuid", assignedTo: null, actorUserId: ACTOR }, db),
      { ok: false, status: 400, error: "invalid_territory_id" },
    );
    assert.deepEqual(
      await assignTerritory({ territoryId: TERRITORY, assignedTo: "not-a-uuid", actorUserId: ACTOR }, db),
      { ok: false, status: 400, error: "invalid_assigned_to" },
    );
  }

  // ---- Pure helpers ---------------------------------------------------------
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 5), []);
  assert.equal(isTerritoryAssignmentEligible({}), true);
  assert.equal(isTerritoryAssignmentEligible({ stage: "researched" }), true);
  assert.equal(isTerritoryAssignmentEligible({ stage: "unassigned" }), true);
  assert.equal(isTerritoryAssignmentEligible({ stage: "assigned" }), false);
  assert.equal(isTerritoryAssignmentEligible({ stage: "researched", dnc: true }), false);
  const assignedAt = "2026-09-14T12:00:00.000Z";
  assert.deepEqual(withAssignedTo({ business_name: "X", stage: "researched" }, AGENT, assignedAt), {
    business_name: "X",
    assigned_to: AGENT,
    assigned_at: assignedAt,
    claimed_at: assignedAt,
    sales_program: "website_sales_v1",
    sales_motion: "cold_outbound",
    lead_source_track: "company",
    sourced_by_user_id: null,
    last_contacted_at: assignedAt,
    last_call_at: null,
    lost_at: null,
    stage: "assigned",
    stage_entered_at: assignedAt,
  });
  assert.equal(isUuid(TERRITORY), true);
  assert.equal(isUuid("nope"), false);
  assert.equal(isUuid(null), false);

  console.log("web-leads-territory-assign ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// ---------------------------------------------------------------------------
// A TERRITORY ASSIGNMENT MUST MAKE THE LEAD VISIBLE TO THE REP IT WAS GIVEN TO.
// Added 2026-08-26 after a live report: "an issue with the actual data being
// transferred to the pipeline".
//
// withAssignedTo() used to return `{ ...data, assigned_to }` and nothing else.
// filterWebsiteSalesRows drops every row not stamped `website_sales_v1`, so a
// lead assigned through a TERRITORY was owned in Web Leads and simply ABSENT
// from /pipeline -- no error, no empty state, nothing to reason about. Two live
// leads were in that state when this was found (Lakeside Montessori School and
// Silverthorne, same rep, 2026-08-24/25). The CLAIM path always stamped it; only
// this door did not, so the two doors disagreed about what ownership means.
{
  // 1. THE FIX FIRES: a fresh, unstamped lead becomes pipeline-eligible.
  const out = withAssignedTo({ business_name: "Silverthorne" }, "rep-1", "2026-08-26T00:00:00.000Z");
  assert.equal(out.assigned_to, "rep-1");
  assert.equal(out.sales_program, "website_sales_v1", "without this the lead never reaches /pipeline");
  assert.equal(out.sales_motion, "cold_outbound", "without this the lead is rejected by the OASIS pipeline query");
  assert.equal(out.lead_source_track, "company", "territory-fed work is company sourced");
  assert.equal(out.stage, "assigned");
  assert.equal(out.claimed_at, "2026-08-26T00:00:00.000Z");
  assert.equal(out.assigned_at, "2026-08-26T00:00:00.000Z");
  assert.equal(out.stage_entered_at, "2026-08-26T00:00:00.000Z");
}
{
  // 2. Territory propagation is intake-only. An active self-sourced row is
  //    returned byte-for-byte unchanged, including owner and source credit.
  const active = {
      business_name: "X",
      assigned_to: "rep-1",
      lead_source_track: "self",
      stage: "qualified",
      stage_entered_at: "2026-08-01T00:00:00.000Z",
      last_contacted_at: "2026-08-09T00:00:00.000Z",
      last_call_at: "2026-08-10T00:00:00.000Z",
      lost_at: "2026-08-11T00:00:00.000Z",
  };
  const out = withAssignedTo(active, "rep-2", "2026-08-26T00:00:00.000Z");
  assert.deepEqual(out, active);
}
for (const stage of ["lost", "in_build"] as const) {
  const history = {
    stage,
    stage_entered_at: "2026-07-01T00:00:00.000Z",
    last_contacted_at: "2026-07-02T00:00:00.000Z",
    last_call_at: "2026-07-03T00:00:00.000Z",
    lost_at: stage === "lost" ? "2026-07-04T00:00:00.000Z" : null,
  };
  const out = withAssignedTo(history, "rep-history", "2026-08-26T00:00:00.000Z");
  assert.deepEqual(out, history, `${stage}: territory assignment must leave the row untouched`);
}
{
  // 3. A blank-string stage counts as absent, not as a stage. A whitespace value
  //    would otherwise be preserved as "in flight" and keep the lead invisible.
  const out = withAssignedTo({ stage: "   " }, "rep-3", "2026-08-26T00:00:00.000Z");
  assert.equal(out.stage, "assigned");
}
{
  // 4. DNC rows never enter a rep's calling book, even while still researched.
  const out = withAssignedTo({ business_name: "Y", phone: "555", dnc: true }, "rep-4", "2026-08-26T00:00:00.000Z");
  assert.equal(out.business_name, "Y");
  assert.equal(out.phone, "555");
  assert.equal(out.dnc, true);
  assert.equal(out.assigned_to, undefined);
}
{
  // A malformed legacy self flag without a durable source identity fails
  // closed to company. A real frozen source identity survives assignment; the
  // payout engine decides whether that source is also the closer.
  const self = withAssignedTo({ lead_source_track: "self" }, "rep-5", "2026-08-26T00:00:00.000Z");
  assert.equal(self.lead_source_track, "company");
  const invalid = withAssignedTo({ lead_source_track: "partner" }, "rep-5", "2026-08-26T00:00:00.000Z");
  assert.equal(invalid.lead_source_track, "company");
  const frozen = withAssignedTo(
    { stage: "researched", assigned_to: null, lead_source_track: "self", sourced_by_user_id: SOURCE_REP },
    AGENT,
    "2026-08-26T00:00:00.000Z",
  );
  assert.equal(frozen.lead_source_track, "self");
  assert.equal(frozen.sourced_by_user_id, SOURCE_REP);
}

console.log("web-leads-territory-assign pipeline-visibility ok");
