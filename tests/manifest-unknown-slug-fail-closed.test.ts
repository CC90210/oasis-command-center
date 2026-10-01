/**
 * tests/manifest-unknown-slug-fail-closed.test.ts — a slug with no manifest
 * row and no seed of its own renders an empty "being set up" workspace, never
 * OASIS's.
 *
 * WHY THIS EXISTS (P0-4, 2026-09-28)
 * ----------------------------------
 * getSeedManifest answered every slug it did not recognise with OASIS_SEED:
 * CC's own nav (Operations, Automations, Health, Analytics ...), OASIS's lead
 * data model, OASIS's agent roster, the operator chat picker, and local_files
 * + computer_control permissions. 46 self-signup workspaces had no row and no
 * seed, so every one of them rendered CC's workspace. The alias slugs
 * "default" (no slug at all) and "oasis" (historical, held by no tenant) did
 * the same for anyone who reached them.
 *
 * What must stay true alongside the fix: OASIS's real workspaces render
 * exactly what they rendered before. oasis-ai-cc keeps its own seed, and
 * oasis-webdev (no seed, no row) keeps OASIS_SEED, because invite redemption
 * into it reads that seed's agent roster. Every real seed's nav is pinned
 * below by href so a change to any of them is a deliberate test edit.
 *
 * The loader half runs for real against an on-disk libSQL file; nothing is
 * stubbed.
 *
 * Run: node --conditions=react-server --import tsx tests/manifest-unknown-slug-fail-closed.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "manifest-unknown-slug-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const WEBDEV = "42423fde-be8b-454f-932a-750e8c9b743d";
const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const SIGNUP = "11111111-2222-4333-8444-555555555555"; // any self-signup tenant
const FUN = "dfcd3149-3910-477c-a753-c8f9b8b016d8"; // a tenant with its own stored row

// Routes that exist only for OASIS's own operators. An unknown workspace must
// not be offered any of them, even as a dead link.
const OASIS_ONLY_HREFS = ["/founders", "/web-leads", "/commissions", "/operations"];

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

const hrefs = (m: { nav: Array<{ href: string }> }) => m.nav.map((n) => n.href);

async function main() {
  console.log("manifest-unknown-slug-fail-closed:");
  const seeds = await import("../lib/manifest/seeds");
  const {
    getSeedManifest,
    OASIS_SEED,
    OASIS_AI_CC_SEED,
    SUGA_SEED,
    UNPROVISIONED_SEED,
    UNPROVISIONED_SLUG,
    OASIS_SEED_TENANT_IDS,
    isUnprovisionedManifest,
  } = seeds;
  const { CC_NAV, WEBDEV_NAV } = await import("../lib/nav-config");

  // ── The door: an unknown slug ──────────────────────────────────────────────
  await check("an unknown slug gets UNPROVISIONED_SEED, not OASIS's workspace", () => {
    for (const slug of ["anything-new", "acme-roofing", "nghiatran24012", " Brand-New "]) {
      assert.equal(getSeedManifest(slug), UNPROVISIONED_SEED, `slug ${JSON.stringify(slug)}`);
    }
  });

  await check("the unprovisioned seed carries none of OASIS's rows", () => {
    const nav = hrefs(UNPROVISIONED_SEED);
    for (const href of nav) {
      for (const forbidden of OASIS_ONLY_HREFS) {
        assert.ok(
          href !== forbidden && !href.startsWith(`${forbidden}/`),
          `unprovisioned nav must not link ${forbidden} (found ${href})`,
        );
      }
    }
    // Stronger than the four named routes: nothing from CC's navs at all,
    // except the two rows every workspace has.
    const ccHrefs = new Set([...CC_NAV, ...WEBDEV_NAV].map((n) => n.href));
    const shared = nav.filter((h) => ccHrefs.has(h));
    assert.deepEqual(shared, ["/", "/settings"], "only Today and Settings may overlap CC's nav");
    assert.deepEqual(nav, ["/", "/settings"], "Today + Settings, nothing else");
  });

  await check("the unprovisioned seed grants nothing", () => {
    assert.deepEqual(UNPROVISIONED_SEED.agents, [], "no OASIS agent roster");
    assert.deepEqual(UNPROVISIONED_SEED.data_model, [], "no OASIS lead/contact/proposal model");
    assert.deepEqual(UNPROVISIONED_SEED.default_prompts, []);
    assert.deepEqual(UNPROVISIONED_SEED.permissions, {
      local_files: false,
      computer_control: false,
      web_access: false,
    });
    assert.equal(UNPROVISIONED_SEED.ui?.advanced_picker, false, "no operator chat picker");
    assert.equal(UNPROVISIONED_SEED.integrations, undefined);
    assert.notEqual(UNPROVISIONED_SEED.brand.name, OASIS_SEED.brand.name, "not branded as OASIS AI's workspace");
  });

  await check("Today says the workspace is being set up", () => {
    const today = UNPROVISIONED_SEED.pages?.find((p) => p.path === "");
    assert.ok(today, "a root page must exist");
    assert.equal(today.kind, "markdown");
    assert.match(String(today.config?.body), /being set up/i);
    assert.equal(UNPROVISIONED_SEED.tenant_slug, UNPROVISIONED_SLUG);
    assert.equal(isUnprovisionedManifest(UNPROVISIONED_SEED), true);
    assert.equal(isUnprovisionedManifest(OASIS_SEED), false);
    assert.equal(isUnprovisionedManifest(null), false);
    // Survives a JSON round trip (RSC props), which an identity check would not.
    assert.equal(isUnprovisionedManifest(JSON.parse(JSON.stringify(UNPROVISIONED_SEED))), true);
  });

  await check("no persona filter strips Today or Settings from the unprovisioned nav", async () => {
    const { filterNavForPersona } = await import("../lib/role-surfaces");
    for (const persona of ["sales", "manager", "marketing", "builder", "founder", "worker"] as const) {
      assert.deepEqual(
        hrefs({ nav: filterNavForPersona(UNPROVISIONED_SEED.nav, persona) }),
        ["/", "/settings"],
        `persona ${persona}`,
      );
    }
  });

  // ── The aliases: OASIS_SEED only for an OASIS viewer ───────────────────────
  await check("default / oasis / no slug fail closed without an OASIS tenant id", () => {
    for (const slug of ["default", "oasis", "OASIS", null, undefined, ""]) {
      assert.equal(getSeedManifest(slug), UNPROVISIONED_SEED, `slug ${JSON.stringify(slug)}, no viewer`);
      for (const viewer of [SUNBIZ, SIGNUP, "", null]) {
        assert.equal(
          getSeedManifest(slug, viewer),
          UNPROVISIONED_SEED,
          `slug ${JSON.stringify(slug)} for viewer ${JSON.stringify(viewer)}`,
        );
      }
    }
  });

  await check("default / oasis / no slug still render OASIS_SEED for OASIS's own tenants", () => {
    for (const slug of ["default", "oasis", null]) {
      assert.equal(getSeedManifest(slug, OASIS), OASIS_SEED);
      assert.equal(getSeedManifest(slug, WEBDEV), OASIS_SEED);
    }
  });

  await check("OASIS_SEED_TENANT_IDS is exactly the OASIS rows of TENANT_ID_BRAND", async () => {
    const { TENANT_ID_BRAND } = await import("../lib/email/brand-for-tenant");
    const oasisIds = Object.entries(TENANT_ID_BRAND)
      .filter(([, brand]) => brand === "oasis")
      .map(([id]) => id)
      .sort();
    assert.deepEqual([...OASIS_SEED_TENANT_IDS].sort(), oasisIds);
  });

  // ── Real workspaces are untouched ──────────────────────────────────────────
  await check("every real seed still resolves to itself, whoever asks", () => {
    for (const viewer of [undefined, OASIS, SUNBIZ, SIGNUP]) {
      assert.equal(getSeedManifest("oasis-ai-cc", viewer), OASIS_AI_CC_SEED);
      assert.equal(getSeedManifest(" OASIS-AI-CC ", viewer), OASIS_AI_CC_SEED);
      assert.equal(getSeedManifest("suga", viewer), SUGA_SEED);
    }
  });

  // ── The retired SunBiz shell has no seed any more (2026-10-01, OS plan W0) ──
  await check("the retired 'sun' slug has no seed: it is an unknown workspace, whoever asks", () => {
    assert.equal("SUN_SEED" in seeds, false, "SUN_SEED is exported again");
    for (const viewer of [undefined, OASIS, SUNBIZ, SIGNUP]) {
      assert.equal(getSeedManifest("sun", viewer), UNPROVISIONED_SEED, `viewer ${String(viewer)}`);
    }
    assert.equal("sun" in seeds.SEED_MANIFESTS, false, "SEED_MANIFESTS lists sun again");
  });

  await check("oasis-webdev keeps OASIS_SEED (no row, no seed, OASIS's own tenant)", async () => {
    const { OASIS_WEBSITE_TENANT_SLUG } = await import("../lib/website-sales-workflow");
    assert.equal(OASIS_WEBSITE_TENANT_SLUG, "oasis-webdev", "seeds.ts carries this slug as a literal");
    assert.equal(getSeedManifest(OASIS_WEBSITE_TENANT_SLUG), OASIS_SEED);
    assert.deepEqual(
      OASIS_SEED.agents.filter((a) => a.enabled).map((a) => a.slug),
      ["bravo", "atlas", "maven", "aura"],
      "invite redemption into oasis-webdev reads this roster; an empty one throws",
    );
  });

  // Pinned on 2026-09-28 from the tree before this change. A diff here means a
  // seed's nav moved: update the snapshot on purpose, never to make this pass.
  await check("each real seed's nav is unchanged (href snapshot)", () => {
    const CC = [
      "/", "/schedule", "/pipeline", "/forms", "/agent", "/playbook", "/operations",
      "/automations", "/health", "/analytics", "/projects", "/tickets", "/settings",
    ];
    assert.deepEqual(hrefs(OASIS_SEED), CC, "OASIS_SEED");
    assert.deepEqual(
      hrefs(OASIS_AI_CC_SEED),
      [...CC, "/web-leads", "/commissions", "/training", "/objections"],
      "OASIS_AI_CC_SEED",
    );
    assert.deepEqual(
      hrefs(SUGA_SEED),
      [
        "/t/suga", "/agent", "/t/suga/subscribers", "/t/suga/posts", "/t/suga/drafts",
        "/t/suga/merch", "/t/suga/sponsorship", "/team", "/automations", "/settings",
      ],
      "SUGA_SEED",
    );
  });

  // ── The loader, end to end against libSQL ──────────────────────────────────
  const seed = createClient({ url: `file:${dbFile}` });
  await seed.execute(`CREATE TABLE tenant_manifests (
    id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT UNIQUE, manifest TEXT,
    version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT)`);
  const { parseManifest } = await import("../lib/manifest/schema");
  const { finalizeManifestFromWizard } = await import("../lib/manifest/wizard-finalize");
  const funBody = parseManifest(finalizeManifestFromWizard({ template: "custom", slug: "fun", answers: {} }));
  await seed.execute({
    sql: "INSERT INTO tenant_manifests VALUES ('m1', ?, 'fun', ?, 1, 1, '2026-01-01', '2026-01-01')",
    args: [FUN, JSON.stringify(funBody)],
  });

  const { getManifest, manifestExists } = await import("../lib/manifest/loader");

  await check("loader: a stored row still wins over every seed", async () => {
    const m = await getManifest("fun");
    assert.equal(m.tenant_slug, "fun");
    assert.equal(isUnprovisionedManifest(m), false);
  });

  await check("loader: an unknown slug falls back to UNPROVISIONED_SEED", async () => {
    assert.equal(await getManifest("acme-roofing"), UNPROVISIONED_SEED);
    assert.equal(await getManifest(null), UNPROVISIONED_SEED, "no slug is not OASIS");
    assert.equal(await getManifest("oasis"), UNPROVISIONED_SEED);
  });

  await check("loader: the viewer's tenant id reaches the alias gate", async () => {
    assert.equal(await getManifest(null, OASIS), OASIS_SEED);
    assert.equal(await getManifest("default", SUNBIZ), UNPROVISIONED_SEED);
  });

  await check("loader: OASIS's workspaces render what they rendered before", async () => {
    assert.equal(await getManifest("oasis-ai-cc"), OASIS_AI_CC_SEED);
    assert.equal(await getManifest("oasis-webdev"), OASIS_SEED);
  });

  await check("loader: manifestExists is unchanged (unknown slugs still 404)", async () => {
    assert.equal(await manifestExists("acme-roofing"), false);
    assert.equal(await manifestExists(UNPROVISIONED_SLUG), false, "the placeholder is not a routable workspace");
    assert.equal(await manifestExists("fun"), true);
    assert.equal(await manifestExists("oasis-ai-cc"), true);
    assert.equal(await manifestExists("oasis"), true);
    // The retired SunBiz shell: no seed, no row, so /t/sun/* calls notFound()
    // like any unknown slug (every app/t/[slug] page gates on this).
    assert.equal(await manifestExists("sun"), false, "manifestExists('sun') answers true from the in-code seed again");
  });

  // A DB outage used to hand a workspace with a real row CC's nav for the
  // length of the outage. It now gets the empty shell.
  await seed.execute("ALTER TABLE tenant_manifests RENAME TO tenant_manifests_offline");
  await check("loader: a stored-row workspace fails closed when the DB is unreachable", async () => {
    assert.equal(await getManifest("fun"), UNPROVISIONED_SEED);
    assert.equal(await getManifest("oasis-ai-cc"), OASIS_AI_CC_SEED, "OASIS's seed does not need the DB");
  });
  await seed.execute("ALTER TABLE tenant_manifests_offline RENAME TO tenant_manifests");

  // The shell layout is where the viewer's tenant reaches the loader, and where
  // a tenantless visitor's demo cookie picks a seed.
  await check("layout: passes the viewer's tenant to getManifest; the demo cookie selects only 'sun'", async () => {
    const { readFileSync } = await import("node:fs");
    const layout = readFileSync("app/layout.tsx", "utf8");
    assert.match(layout, /getManifest\(manifestSlug, profile\?\.tenant_id \?\? null\)/);
    assert.match(layout, /DEMO_PROFILE_SLUGS: ReadonlySet<string> = new Set\(\["sun"\]\)/);
    assert.match(layout, /DEMO_PROFILE_SLUGS\.has\(normalisedDemo\)/);
  });

  if (failures > 0) {
    throw new Error(`${failures} check(s) failed`);
  }
}

main().then(
  () => console.log("manifest-unknown-slug-fail-closed: all assertions passed"),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
