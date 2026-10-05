/**
 * create-from-lead-deactivated-owner.test.ts — an application generated from a
 * lead never becomes NEW ownership for a deactivated teammate.
 *
 * createApplicationFromLead copied the lead's assigned_to onto the new
 * application unconditionally. The lead is history and stays the retired rep's,
 * but the application is new work, so it must not land on them. Every door that
 * generates an application runs through this helper: "Run underwriting",
 * promote, decline, and the dropped-document autofill (POST
 * /api/leads/[id]/autofill-application queues the job; /api/internal/apply-extraction
 * applies it through applyExtractedApplication, which calls this helper).
 *
 * Now the owner's standing is read first:
 *   active       -> copied, exactly as before
 *   deactivated  -> the application is created UNOWNED (an admin assigns it
 *                   through the checked assign route) and a warning is logged
 *   not_member   -> copied as before, with a warning (never blocks creation)
 *   read error   -> copied as before, with a warning (never blocks creation)
 *
 * Driven for real against a local libSQL database: the real data layer, the
 * real standing read and the real extraction apply. Nothing is stubbed.
 *
 * Run: node --conditions=react-server --import tsx tests/create-from-lead-deactivated-owner.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "create-from-lead-deactivated-owner-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;

const TENANT = "6e6e6e6e-0000-4000-8000-00000000006e";
const OTHER_TENANT = "7f7f7f7f-0000-4000-8000-00000000007f";
const AGENT = "2c2c2c2c-0000-4000-8000-000000000001";
const RETIRED = "2c2c2c2c-0000-4000-8000-000000000002";
const DUPLICATE = "2c2c2c2c-0000-4000-8000-000000000003";
const STRANGER = "2c2c2c2c-0000-4000-8000-000000000004";
const RETIRED_AT = "2026-09-24T12:00:00Z";
const WARN_TAG = "[applications.create-from-lead]";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n")[0]}`);
  }
}

/**
 * Runs fn with console.warn captured; returns what fn returned + the tagged
 * warnings. The autofill apply ends with a best-effort PDF regeneration that
 * has no storage in this fixture; its "[app_doc" logs are muted, nothing else.
 */
async function capturingWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  const muted = (args: unknown[]) => typeof args[0] === "string" && args[0].startsWith("[app_doc");
  console.warn = (...args: unknown[]) => {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (first.startsWith(WARN_TAG)) warnings.push(first);
    else if (!muted(args)) originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    if (!muted(args)) originalError(...args);
  };
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
}

async function main() {
  console.log("create-from-lead-deactivated-owner:");
  const seed = createClient({ url: `file:${dbFile}` });
  const NOW_SQL = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
  await seed.executeMultiple(`
    CREATE TABLE user_profiles (
      id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      full_name TEXT, display_name TEXT, invited_by TEXT, manager_user_id TEXT,
      joined_at TEXT, deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT
    );
    CREATE TABLE tenant_records (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT ${NOW_SQL}, updated_at TEXT DEFAULT ${NOW_SQL}
    );
    CREATE TABLE agent_events (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      event_type TEXT, publisher_agent TEXT, severity TEXT, payload TEXT,
      correlation_id TEXT, created_at TEXT DEFAULT ${NOW_SQL}
    );
  `);

  const profile = (id: string, authId: string, email: string, tenant: string, deactivatedAt?: string) => ({
    sql: `INSERT INTO user_profiles
            (id, auth_user_id, email, tenant_id, team_role, full_name, joined_at,
             deactivated_at, deactivation_reason)
          VALUES (?, ?, ?, ?, 'agent', ?, '2026-09-01T00:00:00Z', ?, ?)`,
    args: [
      id, authId, email, tenant, email.split("@")[0],
      deactivatedAt ?? null, deactivatedAt ? "Sales team retired" : null,
    ],
  });
  await seed.batch(
    [
      profile("p-agent", AGENT, "agent@sun.test", TENANT),
      profile("p-retired", RETIRED, "retired@sun.test", TENANT, RETIRED_AT),
      // Still active on another tenant; standing is tenant-scoped.
      profile("p-retired-elsewhere", RETIRED, "retired@elsewhere.test", OTHER_TENANT),
      // One person, two rows here: an old retired row and a live one.
      profile("p-dup-old", DUPLICATE, "dup-old@sun.test", TENANT, RETIRED_AT),
      profile("p-dup-new", DUPLICATE, "dup@sun.test", TENANT),
      // Active, but only on another tenant: never a member here.
      profile("p-stranger", STRANGER, "stranger@elsewhere.test", OTHER_TENANT),
    ],
    "write",
  );

  const { createApplicationFromLead } = await import("../lib/applications/create-from-lead");
  const { applyExtractedApplication } = await import("../lib/applications/apply-extracted");

  let seq = 0;
  const seedLead = async (owner?: string) => {
    seq += 1;
    const id = `9a9a9a9a-0000-4000-8000-${String(seq).padStart(12, "0")}`;
    const data: Record<string, unknown> = {
      business_name: `Merchant ${seq} LLC`,
      email: `merchant-${seq}@client.test`,
      ...(owner === undefined ? {} : { assigned_to: owner }),
    };
    await seed.execute({
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
      args: [id, TENANT, JSON.stringify(data)],
    });
    return id;
  };
  const recordData = async (id: string) => {
    const r = await seed.execute({ sql: "SELECT data FROM tenant_records WHERE id = ?", args: [id] });
    assert.equal(r.rows.length, 1, `record ${id} not found`);
    return JSON.parse(String(r.rows[0].data)) as Record<string, unknown>;
  };
  const create = async (leadId: string) => {
    const { result, warnings } = await capturingWarnings(() => createApplicationFromLead({ tenantId: TENANT, leadId }));
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.created, true, "a fresh lead must get a NEW application");
    return { applicationId: result.applicationId, app: await recordData(result.applicationId), warnings };
  };

  // ── createApplicationFromLead ──────────────────────────────────────────
  await check("an ACTIVE owner is copied onto the new application, silently, exactly as before", async () => {
    const leadId = await seedLead(AGENT);
    const { app, warnings } = await create(leadId);
    assert.equal(app.assigned_to, AGENT);
    assert.equal(app.lead_id, leadId);
    assert.equal(app.status, "application_in");
    assert.equal(app.created_via, "manual_lead_underwriting");
    assert.deepEqual(warnings, [], "an active owner must not log anything");
  });

  await check("a person with a live row here is active despite a retired duplicate row", async () => {
    const { app, warnings } = await create(await seedLead(DUPLICATE));
    assert.equal(app.assigned_to, DUPLICATE);
    assert.deepEqual(warnings, []);
  });

  await check("a lead with no owner still produces an unowned application", async () => {
    const { app, warnings } = await create(await seedLead());
    assert.equal("assigned_to" in app, false, JSON.stringify(app));
    assert.deepEqual(warnings, []);
  });

  await check("a DEACTIVATED owner: the application is created UNOWNED and a warning is logged", async () => {
    const leadId = await seedLead(RETIRED);
    const { app, warnings } = await create(leadId);
    assert.equal("assigned_to" in app, false, `the new application went to the retired rep: ${JSON.stringify(app)}`);
    assert.equal(app.lead_id, leadId, "the application must still be created and linked");
    assert.equal(app.status, "application_in");
    assert.deepEqual(warnings, [`${WARN_TAG} owner deactivated`]);
    assert.equal((await recordData(leadId)).assigned_to, RETIRED, "the lead is history and keeps its owner");
  });

  await check("standing is tenant-scoped: retired HERE, active elsewhere, is still deactivated here", async () => {
    // RETIRED holds an ACTIVE row on OTHER_TENANT; only this tenant's rows count.
    const { app, warnings } = await create(await seedLead(RETIRED));
    assert.equal("assigned_to" in app, false);
    assert.deepEqual(warnings, [`${WARN_TAG} owner deactivated`]);
  });

  await check("a NON-MEMBER owner keeps today's copy, with a warning (never blocks creation)", async () => {
    const { app, warnings } = await create(await seedLead(STRANGER));
    assert.equal(app.assigned_to, STRANGER);
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.ok(warnings[0].startsWith(`${WARN_TAG} owner is not a member`), warnings[0]);
  });

  await check("a FAILED standing read keeps today's copy, with a warning (never blocks creation)", async () => {
    const leadId = await seedLead(RETIRED);
    await seed.execute("ALTER TABLE user_profiles RENAME COLUMN deactivation_reason TO deactivation_reason_offline");
    let out: Awaited<ReturnType<typeof create>>;
    try {
      out = await create(leadId);
    } finally {
      await seed.execute("ALTER TABLE user_profiles RENAME COLUMN deactivation_reason_offline TO deactivation_reason");
    }
    assert.equal(out.app.assigned_to, RETIRED, "a failed check must not change what gets written today");
    assert.equal(out.warnings.length, 1, JSON.stringify(out.warnings));
    assert.ok(out.warnings[0].startsWith(`${WARN_TAG} owner standing check failed`), out.warnings[0]);
  });

  await check("a second call REUSES the existing application and leaves it untouched", async () => {
    const leadId = await seedLead(RETIRED);
    const first = await create(leadId);
    const { result, warnings } = await capturingWarnings(() => createApplicationFromLead({ tenantId: TENANT, leadId }));
    assert.deepEqual(result, { ok: true, applicationId: first.applicationId, created: false });
    assert.deepEqual(warnings, [], "reuse must not re-read standing");
    assert.equal("assigned_to" in (await recordData(first.applicationId)), false);
  });

  // ── dropped-document autofill onto an existing lead ────────────────────
  // POST /api/leads/[id]/autofill-application queues the job with the lead's
  // owner; the apply step passes it here with the lead id already set.
  const autofill = async (leadId: string, assignedTo: string) =>
    capturingWarnings(() =>
      applyExtractedApplication({
        tenantId: TENANT,
        leadId,
        rawFields: { business_name: "Dropped Form LLC", monthly_revenue: 42000 },
        assignedTo,
        uploadedBy: "extraction_daemon",
        originalFile: null,
      }),
    );

  await check("autofill: an ACTIVE lead owner owns the generated application, as before", async () => {
    const leadId = await seedLead(AGENT);
    const { result, warnings } = await autofill(leadId, AGENT);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.createdLead, false);
    const app = await recordData(result.applicationId);
    assert.equal(app.assigned_to, AGENT);
    assert.equal(app.monthly_revenue, 42000, "the extracted fields still land");
    assert.deepEqual(warnings, []);
  });

  await check("autofill: a DEACTIVATED lead owner does NOT own the generated application", async () => {
    const leadId = await seedLead(RETIRED);
    const { result, warnings } = await autofill(leadId, RETIRED);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const app = await recordData(result.applicationId);
    assert.equal("assigned_to" in app, false, `autofill handed the retired rep a new application: ${JSON.stringify(app)}`);
    assert.equal(app.monthly_revenue, 42000, "the extracted fields still land");
    assert.deepEqual(warnings, [`${WARN_TAG} owner deactivated`]);
    assert.equal((await recordData(leadId)).assigned_to, RETIRED, "the lead is history and keeps its owner");
  });

  if (failures > 0) {
    console.log(`create-from-lead-deactivated-owner: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("create-from-lead-deactivated-owner: OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
