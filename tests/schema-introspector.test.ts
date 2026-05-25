/**
 * V6.9.0 — schema-introspector pure-function tests.
 *
 * Scope: the inline-type → field_metadata_type mapping and the manifest-
 * field → IntrospectedField transformation. DB-dependent paths
 * (loadObjectFromDb / loadObjectMetadata / loadFieldMetadata) are not
 * covered here — they require a live Supabase connection and an applied
 * migration 070. Add those as integration tests when V6.9.4 lands the
 * editor surface.
 */

import assert from "node:assert/strict";
import { __test__, type FieldType, type IntrospectedField } from "@/lib/schema-introspector";
import type { ManifestEntityField } from "@/lib/manifest/schema";

const { mapInlineFieldType, manifestFieldToIntrospected } = __test__;

// ---------------------------------------------------------------------------
// 1. mapInlineFieldType — 7 inline types → 16-type enum (lossless)
// ---------------------------------------------------------------------------

const inlineToTyped: Array<[ManifestEntityField["type"], FieldType]> = [
  ["string", "text"],
  ["number", "number"],
  ["boolean", "boolean"],
  ["date", "date"],
  ["datetime", "datetime"],
  ["enum", "enum"],
  ["json", "json"],
];

for (const [inline, expected] of inlineToTyped) {
  const got = mapInlineFieldType(inline);
  assert.equal(got, expected, `mapInlineFieldType("${inline}") expected "${expected}", got "${got}"`);
}

// ---------------------------------------------------------------------------
// 2. manifestFieldToIntrospected — full transformation including position,
//    required, enum_values lift into options, default passthrough.
// ---------------------------------------------------------------------------

const inputBasic: ManifestEntityField = {
  name: "first_name",
  type: "string",
  required: true,
};
const outBasic = manifestFieldToIntrospected(inputBasic, 0);
assert.equal(outBasic.id, null, "manifest fallback fields must have id=null");
assert.equal(outBasic.source, "manifest", "source must be 'manifest' for fallback fields");
assert.equal(outBasic.name, "first_name");
assert.equal(outBasic.label, "first_name", "label defaults to name when not provided");
assert.equal(outBasic.type, "text", "string inline → text typed");
assert.equal(outBasic.is_required, true);
assert.equal(outBasic.position, 0);
assert.equal(outBasic.is_unique, false);
assert.equal(outBasic.is_system, false);
assert.equal(outBasic.is_active, true);
assert.deepEqual(outBasic.options, {}, "no enum_values → empty options");
assert.equal(outBasic.default_value, null, "missing default → null");

const inputEnum: ManifestEntityField = {
  name: "stage",
  type: "enum",
  required: true,
  enum_values: ["new", "qualified", "won"],
  default: "new",
};
const outEnum = manifestFieldToIntrospected(inputEnum, 5);
assert.equal(outEnum.type, "enum");
assert.equal(outEnum.position, 5);
assert.deepEqual(outEnum.options, { enum_values: ["new", "qualified", "won"] });
assert.equal(outEnum.default_value, "new");

const inputDefault: ManifestEntityField = {
  name: "score",
  type: "number",
  default: 0,
};
const outDefault = manifestFieldToIntrospected(inputDefault, 2);
assert.equal(outDefault.type, "number");
assert.equal(outDefault.is_required, false, "missing required → false");
assert.equal(outDefault.default_value, 0, "0 default must pass through (not coerced to null)");

// ---------------------------------------------------------------------------
// 3. Shape contract — every IntrospectedField has the required keys.
// ---------------------------------------------------------------------------

function assertFieldShape(f: IntrospectedField): void {
  const required: Array<keyof IntrospectedField> = [
    "id",
    "name",
    "label",
    "type",
    "is_required",
    "is_unique",
    "is_system",
    "is_active",
    "position",
    "default_value",
    "options",
    "source",
  ];
  for (const key of required) {
    assert.ok(key in f, `IntrospectedField missing key "${String(key)}"`);
  }
}

assertFieldShape(outBasic);
assertFieldShape(outEnum);
assertFieldShape(outDefault);

console.log("schema-introspector: all assertions passed");
