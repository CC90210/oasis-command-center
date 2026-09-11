/**
 * tests/manifest-slug-claim-guard.test.ts — a slug with no tenant_manifests
 * row is not automatically free.
 *
 * WHY THIS EXISTS
 * ---------------
 * crossTenantGuard treated "no row" as "first writer claims it". OASIS has
 * never written a row for its own seed slug oasis-ai-cc, so any tenant admin,
 * SunBiz's included, could POST /api/manifest/oasis-ai-cc and take OASIS's
 * namespace; resolveDataTenant would then deny OASIS its own slug. oasis-webdev
 * is not even a seed, so the wizard would hand it to anyone.
 *
 * Real guard, real adapter, on-disk libSQL.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const WEBDEV = "42423fde-be8b-454f-932a-750e8c9b743d";
const SIGNUP = "11111111-2222-4333-8444-555555555555"; // any self-signup tenant

const dbFile = join(mkdtempSync(join(tmpdir(), "manifest-claim-")), "claim.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;

const seed = createClient({ url: `file:${dbFile}` });

async function main() {
  await seed.batch(
    [
      `CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT UNIQUE, custom_fields TEXT)`,
      `CREATE TABLE tenant_manifests (
         id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT UNIQUE, manifest TEXT,
         version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT)`,
      // The live slugs of these tenants.
      `INSERT INTO tenants VALUES ('${SUNBIZ}', 'submissions', NULL)`,
      `INSERT INTO tenants VALUES ('${OASIS}', 'oasis-ai-cc', NULL)`,
      `INSERT INTO tenants VALUES ('${WEBDEV}', 'oasis-webdev', NULL)`,
      `INSERT INTO tenants VALUES ('${SIGNUP}', 'acme-roofing', NULL)`,
    ],
    "write",
  );

  const { crossTenantGuard, manifestWriteGuards } = await import("../lib/manifest/guards");
  const claims = (slug: string, tenant: string) => crossTenantGuard(slug, tenant);

  // ── The door: another tenant's row-less slug ─────────────────────────────
  {
    const r = await claims("oasis-ai-cc", SUNBIZ);
    assert.equal(r.ok, false, "SunBiz must not be able to claim OASIS's seed slug");
    assert.equal(!r.ok && r.status, 403);
    assert.equal(!r.ok && r.error, "cross_tenant_forbidden");
  }
  {
    const r = await manifestWriteGuards("oasis-ai-cc", SIGNUP);
    assert.equal(r.ok, false, "nor may a self-signup tenant, through the composite the routes call");
  }
  {
    const r = await claims("oasis-webdev", SUNBIZ);
    assert.equal(r.ok, false, "oasis-webdev is not a seed, but it is another tenant's slug");
  }

  // ── Legitimate claims keep working ───────────────────────────────────────
  assert.deepEqual(await claims("oasis-ai-cc", OASIS), { ok: true }, "OASIS can claim its own slug");
  assert.deepEqual(await claims("oasis-webdev", WEBDEV), { ok: true }, "the webdev workspace can claim its own slug");
  assert.deepEqual(await claims("acme-roofing", SIGNUP), { ok: true }, "a tenant can claim its own tenant slug");
  assert.deepEqual(await claims("brand-new-name", SIGNUP), { ok: true }, "an unreserved slug is still first-come");

  // ── Existing-row behaviour is unchanged ──────────────────────────────────
  // A real manifest body. getManifestRow parses it, and the guard reads a row
  // that fails to parse as "no row", so a junk fixture would test the wrong
  // branch without failing.
  const { getManifestRow } = await import("../lib/manifest/persistence");
  const { parseManifest } = await import("../lib/manifest/schema");
  const { finalizeManifestFromWizard } = await import("../lib/manifest/wizard-finalize");
  // Built the way the wizard builds the rows it stores. The code seeds are not
  // valid stored rows (their root page has an empty path).
  const manifestBody = JSON.stringify(
    parseManifest(finalizeManifestFromWizard({ template: "custom", slug: "sunbiz", answers: {} })),
  );
  for (const [id, tenant, slug] of [
    ["m1", SUNBIZ, "sunbiz"],
    ["m2", null, "legacy-seed"],
  ] as const) {
    await seed.execute({
      sql: "INSERT INTO tenant_manifests VALUES (?, ?, ?, ?, 1, 1, '2026-01-01', '2026-01-01')",
      args: [id, tenant, slug, manifestBody],
    });
  }
  assert.ok(await getManifestRow("sunbiz"), "the fixture row must load, or the checks below prove nothing");
  assert.deepEqual(await claims("sunbiz", SUNBIZ), { ok: true }, "the owner keeps editing its own manifest");
  assert.equal((await claims("sunbiz", OASIS)).ok, false, "another tenant's row is still refused");
  assert.deepEqual(await claims("legacy-seed", SIGNUP), { ok: true }, "a row with no tenant keeps the legacy claim path");

  // ── Fails closed when it cannot tell who owns the name ───────────────────
  await seed.execute("ALTER TABLE tenants RENAME TO tenants_offline");
  {
    const r = await claims("oasis-ai-cc", SUNBIZ);
    assert.equal(r.ok, false, "a failed owner lookup must not wave the claim through");
    assert.equal(!r.ok && r.status, 503);
  }
  await seed.execute("ALTER TABLE tenants_offline RENAME TO tenants");

  // ── The wizard (the CREATE path) runs the same check ─────────────────────
  const wizard = readFileSync("app/api/onboarding/wizard/route.ts", "utf8");
  assert.match(
    wizard,
    /await crossTenantGuard\(slug, profile\.tenant_id\)/,
    "the onboarding wizard must run crossTenantGuard, or oasis-webdev stays claimable there",
  );
}

main().then(
  () => console.log("manifest-slug-claim-guard: all assertions passed"),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
