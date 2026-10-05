import assert from "node:assert/strict";
import { lastTouchIso, lastTouchIsoFlat, latestTouchIso } from "../lib/lead-staleness";

// Nested-data shape (TenantRecord / pipeline rows).

assert.equal(
  lastTouchIso({
    data: { last_contacted_at: "2026-05-20T00:00:00Z" },
    created_at: "2026-01-01T00:00:00Z",
  }),
  "2026-05-20T00:00:00Z",
  "last_contacted_at wins",
);

assert.equal(
  lastTouchIso({
    data: { last_touch_at: "2026-05-15T00:00:00Z" },
    created_at: "2026-01-01T00:00:00Z",
  }),
  "2026-05-15T00:00:00Z",
  "last_touch_at when no last_contacted_at",
);

assert.equal(
  lastTouchIso({
    data: { submitted_at: "2026-04-01T00:00:00Z" },
    created_at: "2026-01-01T00:00:00Z",
  }),
  "2026-04-01T00:00:00Z",
  "submitted_at outranks created_at (SunBiz intake stamp)",
);

assert.equal(
  lastTouchIso({
    data: {},
    created_at: "2026-01-01T00:00:00Z",
  }),
  "2026-01-01T00:00:00Z",
  "created_at fallback when nothing else is set",
);

// The bug class this helper exists to prevent:
assert.equal(
  lastTouchIso({
    data: { last_contacted_at: null },
    created_at: "2026-01-01T00:00:00Z",
    // @ts-expect-error — verifying updated_at is NOT honored even if passed
    updated_at: "2026-05-30T00:00:00Z",
  }),
  "2026-01-01T00:00:00Z",
  "updated_at is NOT in the ladder (the bug we're fixing)",
);

// Empty + null safety.
assert.equal(lastTouchIso({}), null, "empty row → null");
assert.equal(lastTouchIso({ data: null, created_at: null }), null, "null-everywhere → null");
assert.equal(
  lastTouchIso({ data: { last_contacted_at: "" }, created_at: "2026-01-01T00:00:00Z" }),
  "2026-01-01T00:00:00Z",
  "empty-string fields skip to next tier",
);

// Flat variant (LeadsTableClient row shape).
assert.equal(
  lastTouchIsoFlat({
    last_contacted_at: "2026-05-20T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
  }),
  "2026-05-20T00:00:00Z",
  "flat: last_contacted_at wins",
);

assert.equal(
  lastTouchIsoFlat({
    last_contacted_at: null,
    created_at: "2026-01-01T00:00:00Z",
  }),
  "2026-01-01T00:00:00Z",
  "flat: created_at fallback (NOT updated_at)",
);

assert.equal(lastTouchIsoFlat({}), null, "flat: empty → null");

assert.equal(
  latestTouchIso("2026-08-24T16:00:00.000Z", "2026-08-24T15:00:00.000Z"),
  "2026-08-24T16:00:00.000Z",
  "a delayed webhook cannot move Last Touch backwards",
);
assert.equal(
  latestTouchIso("2026-08-24T15:00:00.000Z", "2026-08-24T16:00:00.000Z"),
  "2026-08-24T16:00:00.000Z",
  "a newer contact advances Last Touch",
);
assert.equal(
  latestTouchIso("not-a-date", "2026-08-24T16:00:00.000Z"),
  "2026-08-24T16:00:00.000Z",
  "invalid legacy data cannot block a valid contact",
);

console.log("lead-staleness ok (10 cases)");
