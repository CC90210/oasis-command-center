/**
 * env-fallback-oasis-only.test.ts — a tenant never borrows another account's
 * credentials (P0-1, docs/os-revamp/02 §2; decrypt fail-closed, 03 F3 / §a.4).
 *
 * Every env value in ENV_FALLBACKS is an account OASIS operates: its Stripe,
 * Gmail, Telegram, Twilio, the send-gateway HMAC, and the Kixie/TextTorrent
 * lanes it hosted for SunBiz. Until this change only Stripe was gated, so any
 * other tenant with no key of its own texted, emailed and notified through
 * OASIS's accounts, and a stored credential that failed to decrypt silently
 * resolved to the env account instead. This test walks EVERY (service, field)
 * in ENV_FALLBACKS — a service added later is covered automatically — and
 * checks, for the value, bundle and both status helpers:
 *   - an OASIS tenant (by id) gets the env value;
 *   - a non-OASIS tenant, an unknown id, "" and a tenant that claims an OASIS
 *     slug under another id all get nothing;
 *   - a stored credential that will not decrypt is null + a loud error, never
 *     the env value, and status reports it unavailable rather than configured;
 *   - an unreadable credential table is null + an error, never env.
 * The store runs for real against a local libSQL file; nothing is stubbed.
 *
 * Run: node --conditions=react-server --import tsx tests/env-fallback-oasis-only.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "env-fallback-oasis-only-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "test-only-field-encryption-passphrase";

const OASIS_AI_CC = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const OASIS_WEBDEV = "42423fde-be8b-454f-932a-750e8c9b743d";
const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const CLIENT = "c1c1c1c1-0000-4000-8000-0000000000c1";
const CLIENT_OWN_KEYS = "c2c2c2c2-0000-4000-8000-0000000000c2";
// A workspace that took the historical "oasis" slug. Slug is display text; the
// old Stripe gate trusted it, so this tenant would have received OASIS's key.
const SLUG_SPOOF = "5f5f5f5f-0000-4000-8000-00000000005f";
const UNKNOWN = "9f9f9f9f-0000-4000-8000-00000000009f";

const NON_OASIS = [SUNBIZ, CLIENT, SLUG_SPOOF, UNKNOWN, "", OASIS_AI_CC.toUpperCase()];

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

/** Runs fn with console.error recorded (not printed); returns what was logged. */
async function capturingErrors(fn: () => Promise<void>): Promise<string[]> {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(
      args
        .map((a) => {
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" "),
    );
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return logged;
}

/** Flip one byte of the GCM ciphertext: same shape as a value sealed under another key. */
function tamper(packed: string): string {
  const [iv, tag, ct] = packed.split(".");
  const bytes = Buffer.from(ct, "base64");
  bytes[0] ^= 0xff;
  return `${iv}.${tag}.${bytes.toString("base64")}`;
}

async function main() {
  console.log("env-fallback-oasis-only:");
  const store = await import("../lib/tenant-integration-store");
  const { encryptField } = await import("../lib/field-encryption");
  const { TENANT_ID_BRAND } = await import("../lib/email/brand-for-tenant");
  const { WEBDEV_TENANT_ID } = await import("../lib/web-leads/tenant");
  const { TENANT_MANUALLY_EDITABLE_INTEGRATION_SCHEMAS } = await import("../lib/tenant-integration-schemas");

  // One row per (service, field), each with its own env value so a wrong
  // lookup cannot pass by coincidence. Aliases (Telegram's OASIS_* names) are
  // cleared so the process's own environment cannot leak into the result.
  const matrix = Object.entries(store.ENV_FALLBACKS).flatMap(([service, fields]) =>
    Object.entries(fields).map(([fieldKey, envName]) => ({
      service,
      fieldKey,
      envName,
      envValue: `env-value:${envName}`,
    })),
  );
  assert.ok(matrix.length >= 30, `expected the full ENV_FALLBACKS table, got ${matrix.length} rows`);
  for (const { service, fieldKey } of matrix) {
    for (const name of store.envKeysFor(service, fieldKey)) delete process.env[name];
  }
  for (const { envName, envValue } of matrix) process.env[envName] = envValue;

  const seed = createClient({ url: `file:${dbFile}` });
  await seed.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT);
    CREATE TABLE tenant_integration_credentials (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, service TEXT NOT NULL, field_key TEXT NOT NULL,
      encrypted_value TEXT NOT NULL, last_tested_at TEXT, last_test_ok INTEGER, last_test_error TEXT,
      created_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await seed.execute({
    sql: `INSERT INTO tenants (id, slug) VALUES (?, 'oasis-ai-cc'), (?, 'oasis-webdev'), (?, 'submissions'),
          (?, 'client-co'), (?, 'client-own'), (?, 'oasis')`,
    args: [OASIS_AI_CC, OASIS_WEBDEV, SUNBIZ, CLIENT, CLIENT_OWN_KEYS, SLUG_SPOOF],
  });
  await seed.batch(
    matrix.map(({ service, fieldKey }) => ({
      sql: `INSERT INTO tenant_integration_credentials (id, tenant_id, service, field_key, encrypted_value)
            VALUES (?, ?, ?, ?, ?)`,
      args: [`own-${service}-${fieldKey}`, CLIENT_OWN_KEYS, service, fieldKey, encryptField(`own:${service}:${fieldKey}`)],
    })),
    "write",
  );

  await check("the allowlist is exactly OASIS's own tenant ids", async () => {
    const oasisBrandIds = Object.entries(TENANT_ID_BRAND)
      .filter(([, brand]) => brand === "oasis")
      .map(([id]) => id)
      .sort();
    assert.deepEqual([...store.OASIS_ENV_CREDENTIAL_TENANT_IDS].sort(), oasisBrandIds);
    assert.deepEqual([...store.OASIS_ENV_CREDENTIAL_TENANT_IDS].sort(), [OASIS_WEBDEV, OASIS_AI_CC].sort());
    assert.ok(
      store.tenantMayUseEnvFallback(WEBDEV_TENANT_ID),
      "the web-leads book (reps' daily workspace) must keep OASIS's accounts",
    );
    for (const tenantId of [...NON_OASIS, null, undefined]) {
      assert.equal(store.tenantMayUseEnvFallback(tenantId), false, `tenant ${String(tenantId)}`);
    }
  });

  await check("an OASIS tenant resolves every service's env value", async () => {
    for (const tenantId of [OASIS_AI_CC, OASIS_WEBDEV]) {
      for (const { service, fieldKey, envValue } of matrix) {
        assert.equal(
          await store.getTenantIntegrationValue(tenantId, service, fieldKey),
          envValue,
          `${tenantId} ${service}.${fieldKey}`,
        );
      }
    }
  });

  await check("an OASIS tenant's bundle and status see every env field", async () => {
    for (const service of Object.keys(store.ENV_FALLBACKS)) {
      const rows = matrix.filter((m) => m.service === service);
      const bundle = await store.getTenantIntegrationBundle(OASIS_WEBDEV, service);
      for (const { fieldKey, envValue } of rows) assert.equal(bundle[fieldKey], envValue, `${service}.${fieldKey}`);
      const presence = await store.getTenantIntegrationPresenceForStatus(
        OASIS_WEBDEV,
        service,
        rows.map((m) => m.fieldKey),
      );
      for (const { fieldKey } of rows) assert.equal(presence[fieldKey], true, `${service}.${fieldKey}`);
    }
    const listed = await store.listTenantIntegrationStatus(OASIS_WEBDEV);
    for (const schema of TENANT_MANUALLY_EDITABLE_INTEGRATION_SCHEMAS) {
      for (const field of schema.fields) {
        if (store.envKeysFor(schema.service, field.key).length === 0) continue;
        const row = listed.find((r) => r.service === schema.service && r.field_key === field.key);
        assert.equal(row?.source, "environment", `${schema.service}.${field.key}`);
        assert.equal(row?.has_value, true, `${schema.service}.${field.key}`);
      }
    }
  });

  await check("allowEnvFallback:false still withholds env from an OASIS bundle", async () => {
    for (const service of Object.keys(store.ENV_FALLBACKS)) {
      assert.deepEqual(
        await store.getTenantIntegrationBundle(OASIS_AI_CC, service, { allowEnvFallback: false }),
        {},
        service,
      );
    }
  });

  await check("a non-OASIS, unknown, empty or slug-spoofing tenant gets no env value", async () => {
    for (const tenantId of NON_OASIS) {
      for (const { service, fieldKey } of matrix) {
        assert.equal(
          await store.getTenantIntegrationValue(tenantId, service, fieldKey),
          null,
          `${JSON.stringify(tenantId)} ${service}.${fieldKey}`,
        );
      }
    }
  });

  await check("a non-OASIS tenant's bundle and status report not connected", async () => {
    for (const tenantId of [SUNBIZ, CLIENT, SLUG_SPOOF, UNKNOWN]) {
      for (const service of Object.keys(store.ENV_FALLBACKS)) {
        const fields = matrix.filter((m) => m.service === service).map((m) => m.fieldKey);
        assert.deepEqual(await store.getTenantIntegrationBundle(tenantId, service), {}, `${tenantId} ${service}`);
        assert.deepEqual(
          await store.getTenantIntegrationPresenceForStatus(tenantId, service, fields),
          Object.fromEntries(fields.map((f) => [f, false])),
          `${tenantId} ${service}`,
        );
      }
      assert.deepEqual(await store.listTenantIntegrationStatus(tenantId), [], `${tenantId} list`);
    }
  });

  await check("a non-OASIS tenant that stores its own keys gets its own keys, sourced 'stored'", async () => {
    for (const { service, fieldKey } of matrix) {
      assert.equal(
        await store.getTenantIntegrationValue(CLIENT_OWN_KEYS, service, fieldKey),
        `own:${service}:${fieldKey}`,
        `${service}.${fieldKey}`,
      );
    }
    for (const service of Object.keys(store.ENV_FALLBACKS)) {
      const bundle = await store.getTenantIntegrationBundle(CLIENT_OWN_KEYS, service);
      for (const [fieldKey, value] of Object.entries(bundle)) {
        assert.equal(value, `own:${service}:${fieldKey}`, `${service}.${fieldKey}`);
      }
    }
    const listed = await store.listTenantIntegrationStatus(CLIENT_OWN_KEYS);
    assert.equal(listed.length, matrix.length);
    assert.ok(listed.every((r) => r.source === "stored" && r.has_value), "no env-sourced row for a client");
  });

  // The outbound gate must agree with the resolver: env counts as "configured"
  // only where the resolver would hand it out, or a client's send is admitted
  // and then fails on an empty bundle instead of holding cleanly.
  await check("the outbound provider gate counts env credentials only for OASIS tenants", async () => {
    const { loadProviderAvailability } = await import("../lib/routing/provider-availability");
    const oasis = await loadProviderAvailability(OASIS_AI_CC);
    const envConfigured = Object.entries(oasis).filter(([, v]) => v.configured).map(([p]) => p);
    assert.ok(envConfigured.length > 0, "anti-vacuity: OASIS must see at least one env-configured provider");
    for (const tenantId of [CLIENT, SUNBIZ, SLUG_SPOOF, ""]) {
      const avail = await loadProviderAvailability(tenantId);
      for (const [provider, v] of Object.entries(avail)) {
        assert.equal(v.configured, false, `${tenantId || "(empty)"} reads ${provider} as configured from OASIS's env`);
      }
    }
    const { readFileSync } = await import("node:fs");
    const twilioInbound = readFileSync("app/api/webhooks/twilio/sms-inbound/route.ts", "utf8");
    assert.ok(
      !/process\.env\.TWILIO_AUTH_TOKEN/.test(twilioInbound),
      "the Twilio inbound webhook must verify with the tenant's bundle token, never OASIS's raw env token",
    );
  });

  // Corrupt a stored row for EVERY field of OASIS's agency tenant. Env is still
  // set and this tenant is allowlisted, so a fall-through would return env.
  await seed.batch(
    matrix.map(({ service, fieldKey }, i) => ({
      sql: `INSERT INTO tenant_integration_credentials (id, tenant_id, service, field_key, encrypted_value)
            VALUES (?, ?, ?, ?, ?)`,
      args: [
        `bad-${service}-${fieldKey}`,
        OASIS_AI_CC,
        service,
        fieldKey,
        // Mostly a real ciphertext that fails authentication; one malformed blob.
        i === 0 ? "not-a-ciphertext" : tamper(encryptField(`stored:${service}:${fieldKey}`)),
      ],
    })),
    "write",
  );

  await check("a stored credential that will not decrypt is null + a loud error, never env", async () => {
    for (const { service, fieldKey } of matrix) {
      let value: string | null = "unset";
      const logged = await capturingErrors(async () => {
        value = await store.getTenantIntegrationValue(OASIS_AI_CC, service, fieldKey);
      });
      assert.equal(value, null, `${service}.${fieldKey}`);
      assert.ok(
        logged.some((line) => line.includes("decrypt failed") && line.includes(service) && line.includes(fieldKey)),
        `${service}.${fieldKey} must log a decrypt error naming the field, got ${JSON.stringify(logged)}`,
      );
    }
  });

  await check("an unreadable field stays absent from the bundle (never env-filled)", async () => {
    for (const service of Object.keys(store.ENV_FALLBACKS)) {
      let bundle: Record<string, string> = { sentinel: "unset" };
      const logged = await capturingErrors(async () => {
        bundle = await store.getTenantIntegrationBundle(OASIS_AI_CC, service);
      });
      assert.deepEqual(bundle, {}, service);
      assert.ok(logged.some((line) => line.includes("decrypt failed")), `${service} must log`);
    }
  });

  await check("status reports an unreadable credential as unavailable, not configured", async () => {
    for (const service of Object.keys(store.ENV_FALLBACKS)) {
      const fields = matrix.filter((m) => m.service === service).map((m) => m.fieldKey);
      await capturingErrors(async () => {
        await assert.rejects(
          store.getTenantIntegrationPresenceForStatus(OASIS_AI_CC, service, fields),
          /tenant_integration_status_decrypt_failed/,
          service,
        );
      });
    }
    await capturingErrors(async () => {
      await assert.rejects(
        store.listTenantIntegrationStatus(OASIS_AI_CC),
        /tenant_integration_status_decrypt_failed/,
      );
    });
  });

  // Codex review 2026-09-28: the gate counted stored rows by field NAME, so a
  // complete set of corrupt rows read as configured and the send was admitted,
  // then failed in the resolver. The gate must hold instead, env or no env.
  await check("the outbound provider gate holds a provider whose stored credentials will not decrypt", async () => {
    const { loadProviderAvailability } = await import("../lib/routing/provider-availability");
    let corrupted: Record<string, { configured: boolean }> = {};
    await capturingErrors(async () => {
      corrupted = await loadProviderAvailability(OASIS_AI_CC);
    });
    for (const [provider, v] of Object.entries(corrupted)) {
      assert.equal(v.configured, false, `${provider} reads as configured from unreadable stored credentials`);
    }
    const clean = await loadProviderAvailability(OASIS_WEBDEV);
    assert.ok(
      Object.values(clean).some((v) => v.configured),
      "anti-vacuity: OASIS's uncorrupted workspace must still see its env-configured providers",
    );
  });

  await check("corruption is per tenant: OASIS's other workspace still resolves env", async () => {
    for (const { service, fieldKey, envValue } of matrix) {
      assert.equal(await store.getTenantIntegrationValue(OASIS_WEBDEV, service, fieldKey), envValue);
    }
  });

  await check("an unreadable credential table is null + an error, never env", async () => {
    await seed.execute("DROP TABLE tenant_integration_credentials");
    const { service, fieldKey } = matrix.find((m) => m.service === "stripe")!;
    let value: string | null = "unset";
    let bundle: Record<string, string> = { sentinel: "unset" };
    const logged = await capturingErrors(async () => {
      value = await store.getTenantIntegrationValue(OASIS_WEBDEV, service, fieldKey);
      bundle = await store.getTenantIntegrationBundle(OASIS_WEBDEV, service);
      await assert.rejects(store.getTenantIntegrationPresenceForStatus(OASIS_WEBDEV, service, [fieldKey]));
      await assert.rejects(store.listTenantIntegrationStatus(OASIS_WEBDEV));
    });
    assert.equal(value, null);
    assert.deepEqual(bundle, {});
    assert.ok(logged.some((line) => line.includes("lookup failed")), `must log, got ${JSON.stringify(logged)}`);
  });

  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log(`env fallback tests passed (${matrix.length} service fields)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
