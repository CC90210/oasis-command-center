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
import { assignTerritory, chunk, withAssignedTo, isUuid } from "@/lib/web-leads/assign";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

const TENANT = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const TERRITORY = "11111111-1111-4111-8111-111111111111";
const OTHER_TERRITORY = "99999999-9999-4999-8999-999999999999";
const AGENT = "22222222-2222-4222-8222-222222222222";

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
  mode: "select" | "update";
  eqs: Record<string, unknown>;
  filters: [string, string, unknown][];
  cols?: string;
  opts?: { count?: string; head?: boolean };
  payload?: Record<string, unknown>;
  limit?: number;
};
type Responder = (call: Call) => { data: unknown; error: { message: string } | null; count?: number };

function makeFakeDb(responder: Responder) {
  const calls: Call[] = [];
  function from(table: string) {
    const state: Call = { table, mode: "select", eqs: {}, filters: [] };
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
      eq(c: string, v: unknown) {
        state.eqs[c] = v;
        return chain;
      },
      filter(c: string, op: string, v: unknown) {
        state.filters.push([c, op, v]);
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
  { id: "lead-a", data: { webdev_territory_id: TERRITORY, business_name: "A Salon", assigned_to: null } },
  { id: "lead-b", data: { webdev_territory_id: TERRITORY, business_name: "B Salon", assigned_to: "old-rep" } },
  { id: "lead-c", data: { webdev_territory_id: TERRITORY, business_name: "C Salon", assigned_to: null } },
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
    throw new Error(`unexpected call: ${call.table}/${call.mode}`);
  };
}

async function main() {
  // ---- Assign: propagation hits only the matching leads, preserving data ---
  {
    const db = makeFakeDb(baseResponder());
    const result = await assignTerritory({ territoryId: TERRITORY, assignedTo: AGENT.toUpperCase() }, db);
    assert.equal(result.ok, true);
    if (result.ok && result.mode === "assigned") {
      assert.equal(result.assignedTo, AGENT, "assignee must be normalized to lowercase");
      assert.equal(result.leadsMatched, 3);
      assert.equal(result.leadsUpdated, 3);
      assert.equal(result.leadsFailed, 0);
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
    assert.equal(leadWrites.length, 3, "one write per matched lead");
    for (const w of leadWrites) {
      assert.equal(w.payload!.data && (w.payload!.data as Record<string, unknown>).assigned_to, AGENT);
      assert.equal(w.eqs.tenant_id, TENANT);
      assert.equal(w.eqs.entity_type, "lead");
    }
    // Other fields on the lead must survive the write untouched.
    const bWrite = leadWrites.find((w) => w.eqs.id === "lead-b")!;
    assert.equal((bWrite.payload!.data as Record<string, unknown>).business_name, "B Salon");
  }

  // ---- Assign: a failed batch is reported, not swallowed ------------------
  {
    const db = makeFakeDb(
      baseResponder({
        tenant_records: (call) => {
          if (call.mode === "select") return { data: LEADS, error: null };
          // lead-b's write fails; the others still succeed.
          if (call.eqs.id === "lead-b") return { data: null, error: { message: "conflict" } };
          return { data: [{ id: call.eqs.id }], error: null };
        },
      }),
    );
    const result = await assignTerritory({ territoryId: TERRITORY, assignedTo: AGENT }, db);
    assert.equal(result.ok, true);
    if (result.ok && result.mode === "assigned") {
      assert.equal(result.leadsMatched, 3);
      assert.equal(result.leadsUpdated, 2, "the two leads that succeeded must still count as updated");
      assert.equal(result.leadsFailed, 1, "the failed lead must be counted, never silently dropped");
      assert.match(result.message, /1 failed/, "the response must say a batch partially failed");
    } else {
      assert.fail("expected an 'assigned' result");
    }
  }

  // ---- Unassign: NEVER writes to tenant_records ----------------------------
  {
    const db = makeFakeDb(baseResponder());
    const result = await assignTerritory({ territoryId: TERRITORY, assignedTo: null }, db);
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
    const result = await assignTerritory({ territoryId: OTHER_TERRITORY, assignedTo: AGENT }, db);
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
    const result = await assignTerritory({ territoryId: TERRITORY, assignedTo: AGENT }, db);
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
      await assignTerritory({ territoryId: "not-a-uuid", assignedTo: null }, db),
      { ok: false, status: 400, error: "invalid_territory_id" },
    );
    assert.deepEqual(
      await assignTerritory({ territoryId: TERRITORY, assignedTo: "not-a-uuid" }, db),
      { ok: false, status: 400, error: "invalid_assigned_to" },
    );
  }

  // ---- Pure helpers ---------------------------------------------------------
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 5), []);
  // UPDATED 2026-08-26: this previously asserted that withAssignedTo adds
  // `assigned_to` and NOTHING else, which is exactly the bug it encoded -- a
  // territory-assigned lead was never stamped into the website-sales program, so
  // filterWebsiteSalesRows dropped it and the rep who had just been given the
  // lead could not see it on /pipeline. `sales_program` is now always stamped.
  //
  // `stage: "researched"` is still expected to survive verbatim, and that is the
  // other half of the contract: an existing stage is never rewound. See the
  // dedicated cases at the end of this file.
  assert.deepEqual(withAssignedTo({ business_name: "X", stage: "researched" }, AGENT), {
    business_name: "X",
    stage: "researched",
    assigned_to: AGENT,
    sales_program: "website_sales_v1",
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
  assert.equal(out.stage, "assigned");
  assert.equal(out.stage_entered_at, "2026-08-26T00:00:00.000Z");
}
{
  // 2. AND IT MUST NOT REWIND WORK IN FLIGHT. Re-assigning a lead already at
  //    `qualified` may never reset it to `assigned`: that destroys the rep's
  //    recorded progress, and because `lost` drives the 90-day recycle in
  //    claim.ts, rewinding stage can recycle a deliberately closed lead.
  const out = withAssignedTo(
    { business_name: "X", stage: "qualified", stage_entered_at: "2026-08-01T00:00:00.000Z" },
    "rep-2",
    "2026-08-26T00:00:00.000Z",
  );
  assert.equal(out.stage, "qualified", "an in-flight stage must survive re-assignment");
  assert.equal(out.stage_entered_at, "2026-08-01T00:00:00.000Z", "and keep its original clock");
  assert.equal(out.sales_program, "website_sales_v1", "membership is still stamped, idempotently");
}
{
  // 3. A blank-string stage counts as absent, not as a stage. A whitespace value
  //    would otherwise be preserved as "in flight" and keep the lead invisible.
  const out = withAssignedTo({ stage: "   " }, "rep-3", "2026-08-26T00:00:00.000Z");
  assert.equal(out.stage, "assigned");
}
{
  // 4. Every other field is still carried through untouched -- the original
  //    reason this function was written as a merge.
  const out = withAssignedTo({ business_name: "Y", phone: "555", dnc: true }, "rep-4", "2026-08-26T00:00:00.000Z");
  assert.equal(out.business_name, "Y");
  assert.equal(out.phone, "555");
  assert.equal(out.dnc, true);
}

console.log("web-leads-territory-assign pipeline-visibility ok");
