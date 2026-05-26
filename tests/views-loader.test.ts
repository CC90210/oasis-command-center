/**
 * V6.9.5 — views loader pure-function tests (rewritten after Codex audit).
 *
 * Prior version's `applyViewToQuery` test was a false positive — it
 * asserted on output that matched the (buggy) implementation rather than
 * actual Supabase semantics. Rewritten to assert against the correct
 * shape: PostgREST JSONB syntax (`data->>field` no quotes), ilike
 * wildcards for contains/starts_with, `.is()` for is_null, in/comma-list
 * for `in`, and OR conjunction skipped (V6.9.5.x deferred) with no call.
 *
 * Scope: mapOperator + applyViewToQuery against a stub query. DB paths
 * (loadView / loadViewsForObject / loadDefaultView) are integration
 * tests; deferred to when migration 071 is applied.
 */

import assert from "node:assert/strict";
import {
  mapOperator,
  applyViewToQuery,
  type LoadedView,
  type ViewFilterOperator,
} from "@/lib/views/loader";

// ---------------------------------------------------------------------------
// 1. mapOperator — 9 of 10 → Postgrest op; is_null → null (handled via .is()).
// ---------------------------------------------------------------------------
const tableOps: Array<[ViewFilterOperator, string | null]> = [
  ["eq", "eq"],
  ["neq", "neq"],
  ["gt", "gt"],
  ["lt", "lt"],
  ["gte", "gte"],
  ["lte", "lte"],
  ["contains", "ilike"],
  ["starts_with", "ilike"],
  ["in", "in"],
  ["is_null", null],
];
for (const [op, expected] of tableOps) {
  assert.equal(mapOperator(op), expected, `mapOperator(${op})`);
}

// ---------------------------------------------------------------------------
// 2. applyViewToQuery — chain shape with correct PostgREST values.
// ---------------------------------------------------------------------------

type QueryCall = { method: "filter" | "order" | "is"; args: unknown[] };
type StubQuery = {
  calls: QueryCall[];
  filter: (col: string, op: string, val: unknown) => StubQuery;
  order: (col: string, opts: { ascending: boolean }) => StubQuery;
  is: (col: string, val: null) => StubQuery;
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
    is(col, val) {
      this.calls.push({ method: "is", args: [col, val] });
      return this;
    },
  };
  return stub;
}

function view(overrides: Partial<LoadedView>): LoadedView {
  return {
    id: "v1",
    tenant_id: "t1",
    object_metadata_id: "obj1",
    slug: "test",
    name: "Test",
    kind: "table",
    owner_user_id: null,
    is_default: false,
    kanban_field_name: null,
    description: null,
    fields: [],
    filters: [],
    sorts: [],
    ...overrides,
  };
}

// eq + gte + DESC sort → 3 calls with correct JSONB column syntax (no quotes).
const stub1 = makeStub();
applyViewToQuery(
  stub1,
  view({
    filters: [
      { id: "f1", field_metadata_id: "fm1", field_name: "stage", operator: "eq", value: "qualified", conjunction: "AND", position: 0 },
      { id: "f2", field_metadata_id: "fm2", field_name: "revenue", operator: "gte", value: 50000, conjunction: "AND", position: 1 },
    ],
    sorts: [
      { id: "s1", field_metadata_id: "fm3", field_name: "ai_score", direction: "DESC", position: 0 },
    ],
  }),
);
assert.equal(stub1.calls.length, 3);
assert.deepEqual(stub1.calls[0], { method: "filter", args: ["data->>stage", "eq", "qualified"] });
assert.deepEqual(stub1.calls[1], { method: "filter", args: ["data->>revenue", "gte", 50000] });
assert.deepEqual(stub1.calls[2], { method: "order", args: ["data->>ai_score", { ascending: false }] });

// contains wraps with `%`. starts_with appends `%`.
const stub2 = makeStub();
applyViewToQuery(
  stub2,
  view({
    filters: [
      { id: "f1", field_metadata_id: "fm1", field_name: "name", operator: "contains", value: "Acme", conjunction: "AND", position: 0 },
      { id: "f2", field_metadata_id: "fm2", field_name: "dba", operator: "starts_with", value: "Sun", conjunction: "AND", position: 1 },
    ],
  }),
);
assert.deepEqual(stub2.calls[0], { method: "filter", args: ["data->>name", "ilike", "%Acme%"] });
assert.deepEqual(stub2.calls[1], { method: "filter", args: ["data->>dba", "ilike", "Sun%"] });

// is_null routes through `.is(col, null)`, not `.filter(col, 'is', ...)`.
const stub3 = makeStub();
applyViewToQuery(
  stub3,
  view({
    filters: [
      { id: "f1", field_metadata_id: "fm1", field_name: "closed_at", operator: "is_null", value: null, conjunction: "AND", position: 0 },
    ],
  }),
);
assert.equal(stub3.calls.length, 1);
assert.deepEqual(stub3.calls[0], { method: "is", args: ["data->>closed_at", null] });

// `in` uses PostgREST `(a,b,c)` string format.
const stub4 = makeStub();
applyViewToQuery(
  stub4,
  view({
    filters: [
      { id: "f1", field_metadata_id: "fm1", field_name: "stage", operator: "in", value: ["new", "qualified", "won"], conjunction: "AND", position: 0 },
    ],
  }),
);
assert.deepEqual(stub4.calls[0], { method: "filter", args: ["data->>stage", "in", "(new,qualified,won)"] });

// OR conjunction — SKIPPED with no call (V6.9.5.x deferred).
const stub5 = makeStub();
const warns: unknown[] = [];
const origWarn = console.warn;
console.warn = (...args) => { warns.push(args); };
try {
  applyViewToQuery(
    stub5,
    view({
      filters: [
        { id: "f1", field_metadata_id: "fm1", field_name: "stage", operator: "eq", value: "hot", conjunction: "OR", position: 0 },
        { id: "f2", field_metadata_id: "fm2", field_name: "stage", operator: "eq", value: "warm", conjunction: "OR", position: 1 },
      ],
    }),
  );
} finally {
  console.warn = origWarn;
}
assert.equal(stub5.calls.length, 0, "OR filters must be skipped, not silently AND-applied");
assert.ok(warns.length >= 2, "console.warn should fire once per OR-skipped filter");

// Empty view → no calls.
const stub6 = makeStub();
applyViewToQuery(stub6, view({}));
assert.equal(stub6.calls.length, 0);

console.log("views-loader: all assertions passed");
