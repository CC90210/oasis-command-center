/**
 * stripe-env-fallback-oasis-only.test.ts — the Worker's STRIPE_SECRET_KEY is
 * OASIS's own full live key, so only an OASIS tenant may fall back to it.
 *
 * Before this guard, getTenantIntegrationValue answered the env key to ANY
 * tenant with no stored key. The website-sales route admits a lead whose data
 * carries the website-sales marker even on a non-OASIS tenant, and then asks
 * for the SESSION tenant's Stripe key — so a SunBiz session could create
 * payment links in OASIS's account. The store runs for real against a local
 * libSQL file; nothing is stubbed.
 *
 * Run: node --conditions=react-server --import tsx tests/stripe-env-fallback-oasis-only.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "stripe-env-fallback-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "test-only-field-encryption-passphrase";
process.env.STRIPE_SECRET_KEY = "sk_test_oasis_env_key";
process.env.N8N_OUTBOUND_URL = "https://n8n.example.test/hook";

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const WEBDEV = "0a0a0a0a-0000-4000-8000-00000000000a";
const SUNBIZ = "5b5b5b5b-0000-4000-8000-00000000005b";
const SUNBIZ_OWN_KEY = "5c5c5c5c-0000-4000-8000-00000000005c";
const UNKNOWN = "9f9f9f9f-0000-4000-8000-00000000009f";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
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
  console.log("stripe-env-fallback-oasis-only:");
  const seed = createClient({ url: `file:${dbFile}` });
  await seed.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT);
    CREATE TABLE tenant_integration_credentials (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, service TEXT NOT NULL, field_key TEXT NOT NULL,
      encrypted_value TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const { encryptField } = await import("../lib/field-encryption");
  await seed.batch([
    { sql: `INSERT INTO tenants (id, slug) VALUES (?, 'oasis-ai-cc'), (?, 'oasis-webdev'), (?, 'submissions'), (?, 'sunbiz-own')`, args: [OASIS, WEBDEV, SUNBIZ, SUNBIZ_OWN_KEY] },
    {
      sql: `INSERT INTO tenant_integration_credentials (id, tenant_id, service, field_key, encrypted_value) VALUES ('c1', ?, 'stripe', 'secret_key', ?)`,
      args: [SUNBIZ_OWN_KEY, encryptField("sk_test_sunbiz_own_key")],
    },
  ], "write");

  const store = await import("../lib/tenant-integration-store");

  await check("an OASIS tenant falls back to the Worker's Stripe key", async () => {
    assert.equal(await store.getTenantIntegrationValue(OASIS, "stripe", "secret_key"), "sk_test_oasis_env_key");
    assert.equal(await store.getTenantIntegrationValue(WEBDEV, "stripe", "secret_key"), "sk_test_oasis_env_key");
  });

  await check("a non-OASIS tenant never receives OASIS's Stripe key", async () => {
    assert.equal(await store.getTenantIntegrationValue(SUNBIZ, "stripe", "secret_key"), null);
    assert.equal((await store.getTenantIntegrationBundle(SUNBIZ, "stripe")).secret_key, undefined);
    assert.deepEqual(await store.getTenantIntegrationPresenceForStatus(SUNBIZ, "stripe", ["secret_key"]), { secret_key: false });
  });

  await check("an unknown tenant id is refused, not defaulted to OASIS", async () => {
    assert.equal(await store.getTenantIntegrationValue(UNKNOWN, "stripe", "secret_key"), null);
  });

  await check("a non-OASIS tenant that stores its own key still gets its own key", async () => {
    assert.equal(await store.getTenantIntegrationValue(SUNBIZ_OWN_KEY, "stripe", "secret_key"), "sk_test_sunbiz_own_key");
    assert.equal((await store.getTenantIntegrationBundle(SUNBIZ_OWN_KEY, "stripe")).secret_key, "sk_test_sunbiz_own_key");
  });

  await check("the OASIS bundle and status still see the env key", async () => {
    assert.equal((await store.getTenantIntegrationBundle(OASIS, "stripe")).secret_key, "sk_test_oasis_env_key");
    assert.deepEqual(await store.getTenantIntegrationPresenceForStatus(OASIS, "stripe", ["secret_key"]), { secret_key: true });
  });

  await check("other services keep their platform-wide env fallback", async () => {
    assert.equal(await store.getTenantIntegrationValue(SUNBIZ, "n8n", "outbound_url"), "https://n8n.example.test/hook");
  });

  await check("a failed tenant lookup refuses the Stripe fallback (fails closed)", async () => {
    await seed.execute("DROP TABLE tenants");
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.equal(await store.getTenantIntegrationValue(OASIS, "stripe", "secret_key"), null);
    } finally {
      console.error = originalError;
    }
  });

  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("stripe env fallback tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
