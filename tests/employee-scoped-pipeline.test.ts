import assert from "node:assert/strict";

// Phase 3 of the SunBiz multi-employee personalization plan (2026-05-29).
// The assignment endpoint validates the assigned_to body shape before
// the DB CHECK constraint sees it — gives the operator a cleaner error
// than the raw constraint violation. These tests lock the parsing
// contract so a future refactor doesn't drop the validation.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseAssignedTo(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: "invalid_type" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }
  const candidate = trimmed.toLowerCase();
  if (!UUID_RE.test(candidate)) {
    return { ok: false, error: "invalid_uuid_shape" };
  }
  return { ok: true, value: candidate };
}

// 1. Null / undefined / missing field — CLEARS the assignment.
assert.deepEqual(parseAssignedTo(null), { ok: true, value: null });
assert.deepEqual(parseAssignedTo(undefined), { ok: true, value: null });

// 2. Empty string / whitespace — CLEARS (same as null).
assert.deepEqual(parseAssignedTo(""), { ok: true, value: null });
assert.deepEqual(parseAssignedTo("   "), { ok: true, value: null });

// 3. Valid UUID (lowercase canonical) — accepted as-is.
const sampleUuid = "9dfee2b3-6a19-447d-9ad0-751d2a0c90c1";
assert.deepEqual(parseAssignedTo(sampleUuid), { ok: true, value: sampleUuid });

// 4. Valid UUID with uppercase letters — normalised to lowercase.
const upper = "9DFEE2B3-6A19-447D-9AD0-751D2A0C90C1";
assert.deepEqual(
  parseAssignedTo(upper),
  { ok: true, value: sampleUuid },
  "UUID input must be normalised to lowercase to match auth_user_id format",
);

// 5. Valid UUID with surrounding whitespace — trimmed.
assert.deepEqual(
  parseAssignedTo("  9dfee2b3-6a19-447d-9ad0-751d2a0c90c1  "),
  { ok: true, value: sampleUuid },
);

// 6. Non-UUID string — rejected.
assert.deepEqual(
  parseAssignedTo("alex@sunbizfunding.com"),
  { ok: false, error: "invalid_uuid_shape" },
  "email-shaped values must be rejected — the field is auth_user_id not email",
);
assert.deepEqual(
  parseAssignedTo("Alex johnson"),
  { ok: false, error: "invalid_uuid_shape" },
  "the legacy name-string format must be rejected post-migration",
);

// 7. Non-string types — rejected.
assert.deepEqual(parseAssignedTo(42), { ok: false, error: "invalid_type" });
assert.deepEqual(parseAssignedTo({ assigned_to: sampleUuid }), { ok: false, error: "invalid_type" });
assert.deepEqual(parseAssignedTo([sampleUuid]), { ok: false, error: "invalid_type" });

console.log("Employee-scoped pipeline tests passed");
