/**
 * V6.9.3 — field-permission enforcement tests (lib/role-gates.ts).
 *
 * Covers the three-state semantics from ADR-0004: undefined = full access,
 * empty array = no access, populated = scoped read/write with default-deny
 * on entities that have ANY entry.
 */

import assert from "node:assert/strict";
import {
  resolveAllowedFields,
  applyFieldReadFilter,
  findDisallowedWriteFields,
} from "@/lib/role-gates";

// ---------------------------------------------------------------------------
// resolveAllowedFields — three-state semantics
// ---------------------------------------------------------------------------

// undefined → null (no restriction)
assert.equal(resolveAllowedFields(undefined, "lead", "read"), null);

// empty array → [] (zero access; declared-but-empty = locked, per ADR-0004)
assert.deepEqual(resolveAllowedFields([], "lead", "read"), []);

// populated with entry for this entity → scoped list
const palette = [
  { entity_type: "lead", fields: ["name", "phone"], mode: "read" as const },
  { entity_type: "lead", fields: ["status"], mode: "write" as const },
];
assert.deepEqual(
  resolveAllowedFields(palette, "lead", "read")?.sort(),
  ["name", "phone", "status"].sort(),
  "read inherits write fields (write is a superset)",
);
assert.deepEqual(resolveAllowedFields(palette, "lead", "write"), ["status"]);

// populated, NO entry for this entity → default-deny ([])
assert.deepEqual(resolveAllowedFields(palette, "application", "read"), []);
assert.deepEqual(resolveAllowedFields(palette, "application", "write"), []);

// ---------------------------------------------------------------------------
// applyFieldReadFilter — filter record data
// ---------------------------------------------------------------------------

const record = { name: "Acme", phone: "555-0100", ssn_last4: "1234", revenue: 50000 };

// null allowed → unchanged
assert.deepEqual(applyFieldReadFilter(record, null), record);

// [] allowed → empty object (no access)
assert.deepEqual(applyFieldReadFilter(record, []), {});

// populated → only listed fields
assert.deepEqual(
  applyFieldReadFilter(record, ["name", "phone"]),
  { name: "Acme", phone: "555-0100" },
);

// listed field that doesn't exist on record → skipped silently
assert.deepEqual(
  applyFieldReadFilter(record, ["name", "nonexistent"]),
  { name: "Acme" },
);

// ---------------------------------------------------------------------------
// findDisallowedWriteFields — reject inbound writes outside the palette
// ---------------------------------------------------------------------------

const writeBody = { name: "New", ssn_last4: "9999", status: "qualified" };

// null allowed → empty list (anything goes — full access)
assert.deepEqual(findDisallowedWriteFields(writeBody, null), []);

// [] allowed → every key is disallowed (zero-access state)
assert.deepEqual(
  findDisallowedWriteFields(writeBody, []).sort(),
  ["name", "ssn_last4", "status"].sort(),
);

// populated → only the keys NOT in allowed
assert.deepEqual(
  findDisallowedWriteFields(writeBody, ["name", "status"]),
  ["ssn_last4"],
);

// All keys allowed → empty
assert.deepEqual(
  findDisallowedWriteFields({ name: "X" }, ["name", "phone"]),
  [],
);

console.log("role-gates field permissions: all assertions passed");
