import assert from "node:assert";
import { coerceProfile, type StoredProfile } from "../lib/web-leads/audit";

// THE BUG (independent review, 2026-08-21): lib/turso-postgrest.ts's fromSql()
// auto-decodes any string column that LOOKS like JSON before the row reaches
// calling code, so lib/web-leads/audit.ts's leadgen_site_audits.profile read
// arrives as an already-parsed OBJECT on the live Turso path
// (EMPIRE_DATA_BACKEND=turso_cloud), not the JSON string the column is
// actually stored as. Code that assumed it was always a string ran
// JSON.parse() on that object -- which stringifies to "[object Object]",
// throws, and was silently swallowed into `not_scored` -- so every real,
// correctly-scored lead rendered "Not scored yet" in production. Nothing
// caught this before because no test exercised the adapter's decoding
// behaviour; this file exists to make sure that never regresses silently
// again. See coerceProfile()'s doc comment in lib/web-leads/audit.ts for the
// full mechanism.

const SAMPLE: StoredProfile = {
  composite: 42,
  dimensions: [
    {
      key: "conversion",
      label: "Turning visitors into calls",
      score: 18,
      weight: 0.3,
      checks: [{ code: "tel_link", label: "Tap-to-call number", points: 10, has: false }],
      missing: ["Tap-to-call number"],
    },
  ],
};

// This is what production actually delivers on the Turso path: rowOut()
// already ran the TEXT column through JSON.parse() before audit.ts ever sees
// it, so `profile` arrives as a real object, not a string.
{
  const result = coerceProfile(SAMPLE);
  assert.ok(result, "an already-decoded object must be accepted, not rejected");
  assert.equal(result.composite, 42, "composite must survive the object path unchanged");
  assert.deepEqual(result.dimensions, SAMPLE.dimensions, "dimensions must survive the object path unchanged");
}

// This is what the non-Turso (real supabase-js) fallback path delivers: no
// adapter, so the TEXT column arrives as a raw JSON string that still needs
// parsing. Both paths must produce the SAME data for the SAME underlying row.
{
  const result = coerceProfile(JSON.stringify(SAMPLE));
  assert.ok(result, "a JSON string must still be parsed");
  assert.equal(result.composite, 42, "composite must survive the string path unchanged");
  assert.deepEqual(result.dimensions, SAMPLE.dimensions, "dimensions must survive the string path unchanged");
}

// Malformed input degrades to null (which fetchAudit() turns into the honest
// `not_scored` state), never a thrown exception or a fabricated score.
assert.equal(coerceProfile("{not valid json"), null, "unparseable JSON text must return null, not throw");
assert.equal(coerceProfile(null), null, "null must return null");
assert.equal(coerceProfile(undefined), null, "undefined must return null");
assert.equal(coerceProfile(42), null, "a bare number is neither shape and must return null");

console.log("web-leads-audit ok");
