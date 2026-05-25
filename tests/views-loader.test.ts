/**
 * V6.9.1 — views loader pure-function tests.
 *
 * Scope: mapOperator (10 ViewFilterOperator values → Supabase filter ops)
 * and applyViewToQuery (chained .filter/.order calls against a stub query).
 * DB-dependent paths (loadView, loadViewsForObject, loadDefaultView) are
 * deferred to integration tests once migration 071 is applied.
 */

import assert from "node:assert/strict";
import {
  mapOperator,
  applyViewToQuery,
  type LoadedView,
  type ViewFilterOperator,
} from "@/lib/views/loader";

// ---------------------------------------------------------------------------
// 1. mapOperator — all 10 ViewFilterOperator values map to a Supabase op.
// ---------------------------------------------------------------------------
const allOps: ViewFilterOperator[] = [
  "eq", "neq", "gt", "lt", "gte", "lte", "contains", "starts_with", "in", "is_null",
];
for (const op of allOps) {
  const got = mapOperator(op);
  assert.ok(got !== null && got.length > 0, `mapOperator("${op}") returned null/empty`);
}
assert.equal(mapOperator("eq"), "eq");
assert.equal(mapOperator("contains"), "ilike");
assert.equal(mapOperator("starts_with"), "ilike");
assert.equal(mapOperator("is_null"), "is");

// ---------------------------------------------------------------------------
// 2. applyViewToQuery — chains .filter and .order calls.
// ---------------------------------------------------------------------------

type QueryCall = { method: "filter" | "order"; args: unknown[] };
type StubQuery = {
  calls: QueryCall[];
  filter: (col: string, op: string, val: unknown) => StubQuery;
  order: (col: string, opts: { ascending: boolean }) => StubQuery;
};

function makeStub(): StubQuery {
  const stub: StubQuery = {
    calls: [],
    filter(col, op, val) {
      this.calls.push({ method: "filter", args: [col, op, val] });
      return this;
    },
    order(col, opts) {
      this.calls.push({ method: "order", args: [col, opts] });
      return this;
    },
  };
  return stub;
}

const view: LoadedView = {
  id: "view-1",
  tenant_id: "tenant-1",
  object_metadata_id: "object-1",
  slug: "hot-leads",
  name: "Hot Leads",
  kind: "table",
  owner_user_id: null,
  is_default: true,
  kanban_field_name: null,
  description: null,
  fields: [],
  filters: [
    { id: "f1", field_metadata_id: "fm-1", field_name: "stage", operator: "eq", value: "qualified", conjunction: "AND", position: 0 },
    { id: "f2", field_metadata_id: "fm-2", field_name: "revenue", operator: "gte", value: 50000, conjunction: "AND", position: 1 },
  ],
  sorts: [
    { id: "s1", field_metadata_id: "fm-3", field_name: "ai_score", direction: "DESC", position: 0 },
  ],
};

const stub = makeStub();
const result = applyViewToQuery(stub, view);
assert.strictEqual(result, stub, "applyViewToQuery returned chained query");
assert.equal(stub.calls.length, 3, "expected 2 filters + 1 sort = 3 calls");
assert.deepEqual(stub.calls[0].args, [`data->>"stage"`, "eq", "qualified"]);
assert.deepEqual(stub.calls[1].args, [`data->>"revenue"`, "gte", 50000]);
assert.deepEqual(stub.calls[2].args, [`data->>"ai_score"`, { ascending: false }]);

// Empty view → no calls
const emptyView = { ...view, filters: [], sorts: [] };
const stub2 = makeStub();
applyViewToQuery(stub2, emptyView);
assert.equal(stub2.calls.length, 0);

console.log("views-loader: all assertions passed");
