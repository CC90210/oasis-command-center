/**
 * The canonical engine row keeps the exact pairing and fallback for both the
 * workspace and a person. Personal inheritance is deletion, not a fourth
 * engine value.
 *
 * Run: node --conditions=react-server --import tsx tests/agent-engine-store-binding.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "engine-binding-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.BRAVO_SUPABASE_URL;
delete process.env.BRAVO_SUPABASE_SERVICE_ROLE_KEY;

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL);
    CREATE TABLE agent_model_config (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL,
      user_id TEXT,
      agent_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      encrypted_api_key TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      computer_pairing_id TEXT,
      fallback_policy TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_agent_model_config_default_per_agent
      ON agent_model_config (tenant_id, agent_key) WHERE user_id IS NULL;
    CREATE UNIQUE INDEX idx_agent_model_config_engine_per_user
      ON agent_model_config (tenant_id, user_id, agent_key)
      WHERE user_id IS NOT NULL AND agent_key = '__engine__';
  `);
  await db.execute("INSERT INTO tenants (id, slug) VALUES ('tenant-1', 'client-one')");

  const store = await import("../lib/ai/agent-engine-store");
  const workspace = { kind: "cli", cli: "codex", pairingId: "pair-owner", fallback: "none" } as const;
  await store.saveAgentEngine("tenant-1", workspace);
  assert.deepEqual(await store.readAgentEngine("tenant-1"), workspace);

  const person = { kind: "local", model: "ollama/llama3.3", pairingId: "pair-member", fallback: "workspace_api" } as const;
  await store.savePersonAgentEngine("tenant-1", "user-1", person);
  assert.deepEqual(await store.readPersonAgentEngine("tenant-1", "user-1"), person);
  assert.deepEqual(await store.readEffectiveAgentEngine("tenant-1", "user-1"), {
    source: "person",
    engine: person,
    legacyUnbound: false,
  });

  await store.clearPersonEngine("tenant-1", "user-1");
  assert.deepEqual(await store.readEffectiveAgentEngine("tenant-1", "user-1"), {
    source: "workspace",
    engine: workspace,
    legacyUnbound: false,
  });

  // Old personal rows remain readable but are explicitly unbound so the UI
  // and dispatcher require a computer choice before calling them ready.
  await store.savePersonEngine("tenant-1", "legacy-user", { kind: "computer" });
  assert.deepEqual(await store.readEffectiveAgentEngine("tenant-1", "legacy-user"), {
    source: "person",
    engine: { kind: "cli", cli: "claude" },
    legacyUnbound: true,
  });

  assert.equal(
    await store.bindLegacyEngineIfUnchanged({
      tenantId: "tenant-1",
      userId: "legacy-user",
      engine: { kind: "cli", cli: "claude" },
      pairingId: "pair-legacy",
    }),
    true,
  );
  assert.deepEqual(await store.readEffectiveAgentEngine("tenant-1", "legacy-user"), {
    source: "person",
    engine: { kind: "cli", cli: "claude", pairingId: "pair-legacy", fallback: "none" },
    legacyUnbound: false,
  });
  const boundPersonal = await db.execute({
    sql: "SELECT provider, model, computer_pairing_id, fallback_policy FROM agent_model_config WHERE tenant_id = ? AND user_id = ? AND agent_key = '__engine__'",
    args: ["tenant-1", "legacy-user"],
  });
  assert.deepEqual(
    {
      provider: boundPersonal.rows[0].provider,
      model: boundPersonal.rows[0].model,
      pairingId: boundPersonal.rows[0].computer_pairing_id,
      fallback: boundPersonal.rows[0].fallback_policy,
    },
    { provider: "cli", model: "claude", pairingId: "pair-legacy", fallback: "none" },
    "the upgrade canonicalizes the old personal vocabulary and persists both binding columns",
  );

  await store.saveAgentEngine("tenant-1", { kind: "local", model: "ollama/llama3.3" });
  assert.equal(
    await store.bindLegacyEngineIfUnchanged({
      tenantId: "tenant-1",
      userId: null,
      engine: { kind: "local", model: "ollama/llama3.3" },
      pairingId: "pair-local",
    }),
    true,
  );
  assert.deepEqual(await store.readAgentEngine("tenant-1"), {
    kind: "local",
    model: "ollama/llama3.3",
    pairingId: "pair-local",
    fallback: "none",
  });

  await store.saveAgentEngine("tenant-1", { kind: "cli", cli: "codex" });
  assert.equal(
    await store.bindLegacyEngineIfUnchanged({
      tenantId: "tenant-1",
      userId: null,
      engine: { kind: "cli", cli: "claude" },
      pairingId: "pair-stale",
    }),
    false,
    "a concurrent engine change wins over the background legacy upgrade",
  );
  assert.deepEqual(await store.readAgentEngine("tenant-1"), { kind: "cli", cli: "codex", fallback: "none" });

  await db.execute("INSERT INTO tenants (id, slug) VALUES ('tenant-oasis', 'oasis')");
  assert.deepEqual(await store.readEffectiveAgentEngine("tenant-oasis", "owner"), {
    source: "workspace",
    engine: { kind: "cli", cli: "claude" },
    legacyUnbound: true,
  });
  assert.equal(
    await store.bindLegacyEngineIfUnchanged({
      tenantId: "tenant-oasis",
      userId: null,
      engine: { kind: "cli", cli: "claude" },
      pairingId: "pair-oasis",
    }),
    true,
    "the implicit OASIS default becomes an explicit bound engine row",
  );
  assert.deepEqual(await store.readAgentEngine("tenant-oasis"), {
    kind: "cli",
    cli: "claude",
    pairingId: "pair-oasis",
    fallback: "none",
  });

  console.log("agent-engine-store-binding: canonical binding assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
