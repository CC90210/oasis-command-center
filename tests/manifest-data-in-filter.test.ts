import assert from "node:assert/strict";
import { normalizeRecordWhereIn } from "../lib/manifest/data";

assert.deepEqual(normalizeRecordWhereIn(undefined), []);
assert.deepEqual(normalizeRecordWhereIn({ assigned_to: [" rep-b ", "rep-a", "rep-b"] }), [
  ["assigned_to", ["rep-b", "rep-a"]],
]);

for (const input of [
  { assigned_to: [] },
  { assigned_to: [""] },
  { assigned_to: ["   "] },
  { "assigned_to);drop table tenant_records": ["rep-a"] },
] as Array<Record<string, string[]>>) {
  assert.throws(
    () => normalizeRecordWhereIn(input),
    /in-filter/,
    "authorization-scoped IN filters must reject empty or invalid input",
  );
}

assert.throws(
  () => normalizeRecordWhereIn({ assigned_to: Array.from({ length: 501 }, (_, index) => `rep-${index}`) }),
  /exceeds 500 values/,
);

console.log("manifest data IN filter: ok");
