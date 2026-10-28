import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// The objection catalog's tenant and approval tripwires.
//
// 2026-10-28: the per-lead objection console (its two routes under
// /api/web-leads/[id]/objections, lib/web-leads/objections/events.ts and the
// battle card's ObjectionCard / ObjectionConsole) retired with the Prospects
// surface. What stays is the catalog the library (/objections) and the
// practice trainer read, moved to lib/objections/. libSQL has no row-level
// security, so the tenant pin in catalog.ts IS the boundary -- there is no
// second line behind it.
//
// LIMITATION, STATED UP FRONT: these are source-text tripwires. They catch a
// deletion or a loosening that changes the vocabulary of the file. They are
// not a substitute for the runtime coverage in tests/objection-catalog.test.ts.
// ---------------------------------------------------------------------------

const CATALOG = "lib/objections/catalog.ts";
const MIGRATION = "database/turso/171_objection_engine.turso.sql";
const PREMISE_MIGRATION = "database/turso/172_objection_website_premise.turso.sql";

const catalog = read(CATALOG);

// ---------------------------------------------------------------------------
// 1. TENANT PINNING ON EVERY QUERY. Asserted structurally rather than by
// counting a string, so a new `.from(` added later without a pin fails HERE
// and names itself.
// ---------------------------------------------------------------------------
{
  const code = stripComments(catalog);
  const froms = [...code.matchAll(/\.from\("([a-z_]+)"\)/g)];
  assert.ok(froms.length >= 2, `${CATALOG}: expected several table accesses to check, found ${froms.length}`);
  for (const [i, match] of froms.entries()) {
    const table = match[1];
    // The window runs to the NEXT `.from(`, never a fixed character count: a
    // fixed window overlaps the following query, so deleting one pin is
    // covered by its neighbour's and the check silently passes.
    const start = match.index ?? 0;
    const end = i + 1 < froms.length ? (froms[i + 1].index ?? code.length) : code.length;
    const window = code.slice(start, end);
    assert.ok(
      /\.eq\("tenant_id", WEBDEV_TENANT_ID\)/.test(window) || /tenant_id:\s*WEBDEV_TENANT_ID/.test(window),
      `${CATALOG}: the query on "${table}" must pin WEBDEV_TENANT_ID -- libSQL has no row-level security, this pin IS the boundary`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. THE APPROVAL FILTER is the catalog's most important rule, and it must be
// enforced in the PURE projection as well as in the query builder -- a rule
// that lives only in a `.eq()` is a rule a refactor of the query deletes with
// nothing noticing. The behavioural half is tests/objection-catalog.test.ts.
// ---------------------------------------------------------------------------
{
  const code = stripComments(catalog);
  assert.match(code, /if \(o\.status !== "approved"\) continue;/, `${CATALOG}: assembleCatalog must drop non-approved OBJECTIONS`);
  assert.match(code, /if \(r\.status !== "approved"\) continue;/, `${CATALOG}: assembleCatalog must drop non-approved ANSWERS`);
  assert.match(code, /\.eq\("status", "approved"\)/, `${CATALOG}: the catalog query must also filter on approved`);
}

// ---------------------------------------------------------------------------
// 3. Both migrations carry the pin and the shape the catalog relies on.
// ---------------------------------------------------------------------------
{
  const migration = read(MIGRATION);
  assert.match(migration, /tenant_id\s+text not null/, `${MIGRATION} must make tenant_id mandatory on every table`);
  assert.match(
    read(PREMISE_MIGRATION),
    /ALTER TABLE objection_catalog ADD COLUMN website_premise text/,
    `${PREMISE_MIGRATION} must add the ranking premise column`,
  );
}

// ---------------------------------------------------------------------------
// 4. No em dashes in anything a rep can read (project rule: they flag
// AI-generated text). Comments are stripped first. `--` is not the workaround
// either: seeded copy renders verbatim, so a literal double hyphen reaches a
// rep as two hyphens.
// ---------------------------------------------------------------------------
{
  const dashes = stripComments(catalog).match(/.{0,50}[—–].{0,50}/g) || [];
  assert.deepEqual(dashes, [], `em/en dash found in ${CATALOG}: ${dashes.join(" | ")}`);
}
{
  const seed = read("scripts/seed-objection-catalog.ts");
  // Single-line double-quoted literals only: a pattern allowing newlines runs
  // through the file's template-literal error messages and reports whatever
  // `--` it finds in a comment or an argv flag as rep-facing copy.
  const repFacing = [...stripComments(seed).matchAll(/"((?:[^"\\\n]|\\.){40,})"/g)].map((m) => m[1]);
  assert.ok(repFacing.length >= 10, `expected the seed's rep-facing copy strings, found ${repFacing.length}`);
  for (const copy of repFacing) {
    assert.ok(!copy.includes("--"), `seeded rep-facing copy must not use "--" as a dash substitute: ${copy.slice(0, 80)}`);
    assert.ok(!/[—–]/.test(copy), `seeded rep-facing copy must not contain an em/en dash: ${copy.slice(0, 80)}`);
  }
}

console.log("objection-guards: OK");
