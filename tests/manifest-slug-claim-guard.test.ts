/**
 * tests/manifest-slug-claim-guard.test.ts — a slug with no tenant_manifests
 * row is not automatically free, and neither is a row with no owner.
 *
 * WHY THIS EXISTS
 * ---------------
 * crossTenantGuard treated "no row" as "first writer claims it". OASIS has
 * never written a row for its own seed slug oasis-ai-cc, so any tenant admin,
 * SunBiz's included, could POST /api/manifest/oasis-ai-cc and take OASIS's
 * namespace; resolveDataTenant would then deny OASIS its own slug, and the
 * claimer's manifest would render as CC's workspace. oasis-webdev is not even
 * a seed, so the wizard would hand it to anyone. (Ported from b478c58b on
 * fix/tenant-boundary-guards, 2026-09-11.)
 *
 * 2026-09-28 (P0-3) adds three more doors:
 *   - a row with tenant_id NULL was "the legacy claim path": anyone could
 *     write it, and the save kept it NULL, so it stayed claimable. Refused.
 *   - the row lookup swallowed errors AND unparseable bodies as "no row", and
 *     saveManifest keeps the prior row's owner, so a foreign row with a broken
 *     body was writable. The guard now reads the owner column raw and refuses
 *     with a 503 when it cannot read it.
 *   - PROTECTED_SLUGS gains the live slugs of OASIS's and SunBiz's own
 *     workspaces and the unprovisioned placeholder.
 *
 * Real guard, real adapter, on-disk libSQL.
 *
 * Run: node --conditions=react-server --import tsx tests/manifest-slug-claim-guard.test.ts
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
const OTHER = "22222222-3333-4444-8555-666666666666"; // another client workspace

const dbFile = join(mkdtempSync(join(tmpdir(), "manifest-claim-")), "claim.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;

const seed = createClient({ url: `file:${dbFile}` });

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(error);
  }
}

async function main() {
  console.log("manifest-slug-claim-guard:");
  await seed.batch(
    [
      `CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT UNIQUE, custom_fields TEXT)`,
      `CREATE TABLE tenant_manifests (
         id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT UNIQUE, manifest TEXT,
         version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT)`,
      // The live slugs of these tenants. SunBiz's profile slug is "sun".
      `INSERT INTO tenants VALUES ('${SUNBIZ}', 'submissions', '{"command_center_profile_slug":"sun"}')`,
      `INSERT INTO tenants VALUES ('${OASIS}', 'oasis-ai-cc', NULL)`,
      `INSERT INTO tenants VALUES ('${WEBDEV}', 'oasis-webdev', NULL)`,
      `INSERT INTO tenants VALUES ('${SIGNUP}', 'acme-roofing', NULL)`,
      `INSERT INTO tenants VALUES ('${OTHER}', 'globex', NULL)`,
    ],
    "write",
  );

  const { crossTenantGuard, manifestWriteGuards, protectedSlugGuard, PROTECTED_SLUGS } =
    await import("../lib/manifest/guards");
  const { UNPROVISIONED_SLUG } = await import("../lib/manifest/seeds");
  const claims = (slug: string, tenant: string) => crossTenantGuard(slug, tenant);

  // ── The door: another tenant's row-less slug ─────────────────────────────
  await check("a row-less seed slug belongs to its owner, not the first writer", async () => {
    const r = await claims("oasis-ai-cc", SUNBIZ);
    assert.equal(r.ok, false, "SunBiz must not be able to claim OASIS's seed slug");
    assert.equal(!r.ok && r.status, 403);
    assert.equal(!r.ok && r.error, "cross_tenant_forbidden");
    assert.equal((await manifestWriteGuards("oasis-ai-cc", SIGNUP)).ok, false, "nor a self-signup, through the composite");
  });
  await check("another tenant's tenants.slug is not claimable either", async () => {
    assert.equal((await claims("oasis-webdev", SUNBIZ)).ok, false, "oasis-webdev is not a seed, but it is OASIS's slug");
    assert.equal((await claims("acme-roofing", OTHER)).ok, false, "a client's own name is not another client's to take");
  });

  // ── Legitimate claims keep working ───────────────────────────────────────
  await check("owners can still claim their own names, and free names stay free", async () => {
    assert.deepEqual(await claims("oasis-ai-cc", OASIS), { ok: true }, "OASIS can claim its own slug");
    assert.deepEqual(await claims("oasis-webdev", WEBDEV), { ok: true }, "the webdev workspace can claim its own slug");
    assert.deepEqual(await claims("acme-roofing", SIGNUP), { ok: true }, "a tenant can claim its own tenant slug");
    assert.deepEqual(await claims("sun", SUNBIZ), { ok: true }, "a custom profile slug counts as the tenant's own");
    assert.deepEqual(await claims("brand-new-name", SIGNUP), { ok: true }, "an unreserved slug is still first-come");
  });

  // ── Existing rows ────────────────────────────────────────────────────────
  // A real manifest body, built the way the wizard builds the rows it stores.
  const { getManifestRow } = await import("../lib/manifest/persistence");
  const { parseManifest } = await import("../lib/manifest/schema");
  const { finalizeManifestFromWizard } = await import("../lib/manifest/wizard-finalize");
  const manifestBody = JSON.stringify(
    parseManifest(finalizeManifestFromWizard({ template: "custom", slug: "sunbiz", answers: {} })),
  );
  for (const [id, tenant, slug, body] of [
    ["m1", SUNBIZ, "sunbiz", manifestBody],
    ["m2", null, "legacy-seed", manifestBody],
    // A foreign row whose body no longer parses. The old lookup read it as
    // "no row"; "broken-row" is nobody's tenants.slug and not a seed, so the
    // no-row check waved it through and saveManifest kept OTHER as the owner.
    ["m3", OTHER, "broken-row", "{not json"],
  ] as const) {
    await seed.execute({
      sql: "INSERT INTO tenant_manifests VALUES (?, ?, ?, ?, 1, 1, '2026-01-01', '2026-01-01')",
      args: [id, tenant, slug, body],
    });
  }

  await check("owner keeps editing; another tenant's row is refused", async () => {
    assert.ok(await getManifestRow("sunbiz"), "the fixture row must load, or this proves nothing");
    assert.deepEqual(await claims("sunbiz", SUNBIZ), { ok: true }, "the owner keeps editing its own manifest");
    const r = await claims("sunbiz", OASIS);
    assert.equal(r.ok, false, "another tenant's row is still refused");
    assert.equal(!r.ok && r.error, "cross_tenant_forbidden");
  });

  await check("a row with no owner is refused, not claimable by whoever writes first", async () => {
    for (const caller of [SIGNUP, OASIS, SUNBIZ]) {
      const r = await claims("legacy-seed", caller);
      assert.equal(r.ok, false, `caller ${caller}`);
      assert.equal(!r.ok && r.status, 403);
      assert.equal(!r.ok && r.error, "unowned_manifest");
    }
  });

  await check("a foreign row with an unparseable body is still that tenant's", async () => {
    await assert.rejects(getManifestRow("broken-row"), "the fixture must be unparseable, or this proves nothing");
    const r = await claims("broken-row", SIGNUP);
    assert.equal(r.ok, false, "a broken body is not an empty slot");
    assert.equal(!r.ok && r.error, "cross_tenant_forbidden");
    assert.deepEqual(await claims("broken-row", OTHER), { ok: true }, "its owner can still write it to repair it");
  });

  // ── Protected slugs ──────────────────────────────────────────────────────
  await check("OASIS's and SunBiz's own names and the placeholder are protected", async () => {
    for (const slug of ["oasis-ai-cc", "oasis-webdev", "submissions", "sunbiz", UNPROVISIONED_SLUG]) {
      assert.ok(PROTECTED_SLUGS.has(slug), `${slug} must be in PROTECTED_SLUGS`);
    }
    for (const slug of ["default", "oasis", "sun", "suga"]) {
      assert.ok(PROTECTED_SLUGS.has(slug), `${slug} stays protected`);
    }
    // Even the owner: these workspaces are defined in code, not by a stored row.
    for (const [slug, owner] of [
      ["oasis-ai-cc", OASIS],
      ["oasis-webdev", WEBDEV],
      ["submissions", SUNBIZ],
      ["sunbiz", SUNBIZ],
      [UNPROVISIONED_SLUG, SIGNUP],
    ] as const) {
      const r = await manifestWriteGuards(slug, owner);
      assert.equal(r.ok, false, `${slug}`);
      assert.equal(!r.ok && r.error, "protected_slug", `${slug}`);
      assert.equal(!r.ok && r.status, 403);
    }
    assert.deepEqual(protectedSlugGuard("acme-roofing"), { ok: true });
  });

  // ── Fails closed when it cannot tell who owns the name ───────────────────
  await check("a failed tenants lookup refuses with 503", async () => {
    await seed.execute("ALTER TABLE tenants RENAME TO tenants_offline");
    try {
      const r = await claims("oasis-ai-cc", SUNBIZ);
      assert.equal(r.ok, false, "a failed owner lookup must not wave the claim through");
      assert.equal(!r.ok && r.status, 503);
      assert.equal(!r.ok && r.error, "slug_owner_unverified");
      assert.equal((await claims("brand-new-name", SIGNUP)).ok, false, "not even for a name that would be free");
    } finally {
      await seed.execute("ALTER TABLE tenants_offline RENAME TO tenants");
    }
  });

  await check("a failed manifest-row lookup refuses with 503", async () => {
    await seed.execute("ALTER TABLE tenant_manifests RENAME TO tenant_manifests_offline");
    try {
      const r = await claims("sunbiz", OASIS);
      assert.equal(r.ok, false, "the row read failing is not the row being absent");
      assert.equal(!r.ok && r.status, 503);
      assert.equal(!r.ok && r.error, "slug_owner_unverified");
    } finally {
      await seed.execute("ALTER TABLE tenant_manifests_offline RENAME TO tenant_manifests");
    }
  });

  // ── The wizard (the CREATE path) reads the same reserved list ────────────
  await check("the onboarding wizard refuses every PROTECTED_SLUGS name", () => {
    const wizard = readFileSync("app/api/onboarding/wizard/route.ts", "utf8");
    assert.match(
      wizard,
      /PROTECTED_SLUGS\.has\(slug\)/,
      "the wizard must consult PROTECTED_SLUGS, or oasis-webdev and submissions stay claimable there",
    );
    assert.match(
      wizard,
      /await crossTenantGuard\(slug, profile\.tenant_id\)/,
      "the wizard must run crossTenantGuard, or a tenant can claim another client's row-less tenants.slug",
    );
  });

  if (failures > 0) {
    throw new Error(`${failures} check(s) failed`);
  }
}

main().then(
  () => console.log("manifest-slug-claim-guard: all assertions passed"),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
