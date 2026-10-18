/**
 * integrations-health-read.test.ts — a failed heartbeat read is unknown, never
 * "every service unconfigured", and retired bridge services stay absent.
 *
 * integrationsHealth (lib/queries.ts) expands the services a read did not list
 * into "unconfigured" placeholders. It used to ignore the read's error, so a
 * failed query rendered every integration as unconfigured on /health instead
 * of reaching the page's "could not be read" state. Driven against a real
 * local libSQL file.
 *
 * Run: node --conditions=react-server --import tsx tests/integrations-health-read.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "integrations-health-read-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;

async function main() {
  const { integrationsHealth } = await import("../lib/queries");
  const { KNOWN_INTEGRATIONS } = await import("../lib/integrations-registry");
  const registryRoute = await import("../app/api/integrations/registry/route");
  const agentToolsSource = readFileSync("lib/agent-tools.ts", "utf8");

  // No table yet: the read fails, and the failure reaches the caller.
  await assert.rejects(() => integrationsHealth("tenant-a"), /integrations_health read failed/);

  const db = createClient({ url: `file:${dbFile}` });
  await db.execute(
    `CREATE TABLE integrations_health (
       id TEXT PRIMARY KEY, profile_id TEXT, tenant_id TEXT, service TEXT, status TEXT,
       last_ping_at TEXT, last_error TEXT, metadata TEXT, updated_at TEXT)`,
  );
  await db.execute(
    `INSERT INTO integrations_health (id, tenant_id, service, status, last_ping_at, metadata)
     VALUES ('h-a', 'tenant-a', 'telegram', 'healthy', '2026-09-29T00:00:00Z', '{}'),
            ('h-b', 'tenant-b', 'gws', 'healthy', '2026-09-29T00:00:00Z', '{}')`,
  );

  // A successful read: listed services come back as stored, the rest are placeholders.
  const rows = await integrationsHealth("tenant-a");
  const telegram = rows.find((r) => r.service === "telegram");
  assert.equal(telegram?.status, "healthy");
  assert.equal(telegram?.id, "h-a");
  const gws = rows.find((r) => r.service === "gws");
  assert.equal(gws?.status, "unconfigured", "tenant-b's gws heartbeat is not tenant-a's");
  assert.ok(rows.every((r) => r.tenant_id === "tenant-a"));

  // The newest row per service wins (2026-09-30). OASIS carries stale
  // profile_id NULL duplicates beside the bridge's live rows; the old read
  // kept whichever row came last, so a month-old duplicate inserted after the
  // live row hid a heartbeat from a minute ago.
  await db.execute(
    `INSERT INTO integrations_health (id, profile_id, tenant_id, service, status, last_ping_at, metadata)
     VALUES ('s-new', 'p-1', 'tenant-a', 'stripe', 'healthy', '2026-09-29T12:00:00Z', '{}'),
            ('s-old', NULL, 'tenant-a', 'stripe', 'down', '2026-08-15T00:00:00Z', '{}')`,
  );
  const stripe = (await integrationsHealth("tenant-a")).filter((r) => r.service === "stripe");
  assert.equal(stripe.length, 1, "one card per service");
  assert.equal(stripe[0].id, "s-new", "the newest heartbeat wins over a stale duplicate");

  // Retired services never return, even when an old row still has a fresh ping.
  const retired = [
    "supabase", "vercel", "text_torrent", "kixie", "whisper", "ffmpeg",
    "remotion", "playwright", "browser_harness", "obsidian", "notion", "openai_codex",
    "n8n_inbound",
  ];
  const values = retired.map((service, index) => `('r-${index}', 'tenant-a', '${service}', 'healthy', '2026-09-29T12:00:00Z', '{}')`).join(",");
  await db.execute(
    `INSERT INTO integrations_health (id, tenant_id, service, status, last_ping_at, metadata) VALUES ${values}`,
  );
  const services = new Set((await integrationsHealth("tenant-a")).map((r) => r.service));
  for (const service of retired) assert.ok(!services.has(service), `${service} still returned`);

  // The bridge catalog and its public API payload are the same pruned list.
  const known = new Set(KNOWN_INTEGRATIONS.map((entry) => entry.service));
  for (const service of retired) assert.ok(!known.has(service), `${service} remains in KNOWN_INTEGRATIONS`);
  assert.match(agentToolsSource, /integrationsHealth\(ctx\.tenantId\)/, "the chat tool uses the tenant-scoped newest-row reader");
  assert.doesNotMatch(agentToolsSource, /from\("integrations_health"\)/, "the chat tool does not return retired raw rows");

  const response = await registryRoute.GET();
  const payload = (await response.json()) as { count: number; entries: Array<{ service: string }> };
  assert.equal(payload.count, KNOWN_INTEGRATIONS.length);
  const apiServices = new Set(payload.entries.map((entry) => entry.service));
  for (const service of retired) assert.ok(!apiServices.has(service), `${service} remains in /api/integrations/registry`);

  const placeholders = new Set((await integrationsHealth(null)).map((r) => r.service));
  for (const service of retired) assert.ok(!placeholders.has(service), `${service} has a placeholder`);

  console.log("integrations-health-read: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
