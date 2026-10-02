/**
 * tests/clients-blank-start.test.ts — the one-off Clients cleanup
 * (scripts/clients-blank-start.ts) does exactly what its dry run says, and
 * nothing when it is only asked.
 *
 * WHY. CC, 2026-10-02: "It says that SunBiz and Breeze are clients, and
 * they're not." The script archives the BreezeAdvance client record and
 * retires the two seed deals behind it, in production, at the merge gate. It
 * is run twice there: dry, then with --apply. This runs it against a local
 * libSQL copy of the same rows (the live ids, stages, tags and links as read on
 * 2026-10-02) through the app's real code paths, and pins:
 *   - the dry run writes NOTHING (every table byte-identical) and lists the
 *     five changes it would make;
 *   - --apply makes exactly those: the record archived (lifecycle and contact
 *     kept), both deals lost through manual_archive with their
 *     BRAVO_LEAD_AUTO_BUMPED events, a dated correction, the active-client tag
 *     gone, `notes` untouched, and the SunBiz deal naming the retired tenant;
 *   - nothing is deleted, and afterwards Clients is a blank start: no listed
 *     record, no deal to convert, the SunBiz deal refused if anyone tries;
 *   - a second --apply changes nothing.
 *
 * Run: node --conditions=react-server --import tsx tests/clients-blank-start.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "clients-blank-start-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const CC = "c88bdce9-b11c-4731-bdc8-4357f96f820c";
const CUSTOMER = "4fe4b614-0200-45ff-904a-b77d49293eae";
const CONTACT = "19ca3463-1b8c-42e2-8291-dff06deeadae";
const BREEZE_LEAD = "349ad3d2-72bf-4874-9134-b815fc2e5181";
const SUNBIZ_LEAD = "db0d4123-9e92-4647-965f-9f8776249504";
const BREEZE_NOTES = "Active client. Breeze and SunBiz are the current OASIS client portfolio and pay $10,000/month collectively.";
const SUNBIZ_NOTES = "Active client. SunBiz and Breeze pay OASIS $10,000/month collectively.";
const NOW = new Date("2026-10-02T15:00:00.000Z");

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  const migration = (f: string) => readFileSync(join(__dirname, "..", "database", "turso", f), "utf8");
  await db.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT, team_role TEXT,
      is_owner INTEGER DEFAULT 0, full_name TEXT, deactivated_at TEXT);
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT,
      created_by TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE agent_events (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), event_type TEXT,
      publisher_agent TEXT, severity TEXT, target_agent TEXT, payload TEXT, correlation_id TEXT,
      published_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE delivery_projects (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT, updated_at TEXT);
    CREATE TABLE support_tickets (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT, client_email TEXT,
      status TEXT, created_at TEXT, updated_at TEXT);
  `);
  for (const f of ["bravo__188_os_customers.sql", "bravo__190_ledger_core.sql", "bravo__195_customers_links.sql"]) {
    await db.executeMultiple(migration(f));
  }
  // The rows as production holds them (read-only SELECTs, 2026-10-02).
  const lead = (company: string, name: string, tag: string, notes: string) =>
    JSON.stringify({
      company, name, stage: "launched", status: "active", tags: [tag, "active-client", "retainer"], value: 5000, notes,
      stage_backfilled_from: "active_client",
    });
  await db.batch(
    [
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI'), (?, 'submissions', 'SunBiz')", args: [OASIS, SUNBIZ] },
      {
        sql: "INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name) VALUES ('p-cc', ?, 'conaugh@oasisai.work', ?, 'owner', 1, 'Conaugh McKenna')",
        args: [CC, OASIS],
      },
      {
        sql: `INSERT INTO tenant_records (id, tenant_id, entity_type, data, created_at, updated_at) VALUES
                (?, ?, 'lead', ?, '2026-06-21T00:15:34.203663+00:00', '2026-08-25T14:43:19.999Z'),
                (?, ?, 'lead', ?, '2026-07-21T21:40:41.024452+00:00', '2026-08-25T14:43:19.999Z')`,
        args: [
          BREEZE_LEAD, OASIS, lead("BreezeAdvance", "David", "breeze", BREEZE_NOTES),
          SUNBIZ_LEAD, OASIS, lead("SunBiz", "Ezra", "sunbiz", SUNBIZ_NOTES),
        ],
      },
      {
        sql: `INSERT INTO customers (id, tenant_id, display_name, company_name, lifecycle, owner_user_id, source_lead_id, tags, custom_fields, created_at, updated_at)
              VALUES (?, ?, 'BreezeAdvance', 'BreezeAdvance', 'active', ?, ?, '[]', '{}', '2026-09-30T04:11:06.759Z', '2026-09-30T04:11:06.759Z')`,
        args: [CUSTOMER, OASIS, CC, BREEZE_LEAD],
      },
      {
        sql: `INSERT INTO customer_contacts (id, tenant_id, customer_id, name, created_at, updated_at)
              VALUES (?, ?, ?, 'David', '2026-09-30T04:11:06.759Z', '2026-09-30T04:11:06.759Z')`,
        args: [CONTACT, OASIS, CUSTOMER],
      },
    ],
    "write",
  );

  const snapshot = async () => {
    const out: Record<string, unknown> = {};
    for (const t of ["customers", "customer_contacts", "tenant_records", "agent_events", "outcome_events", "tenants"]) {
      out[t] = (await db.execute(`SELECT * FROM ${t} ORDER BY 1`)).rows.map((r) => ({ ...r }));
    }
    return JSON.parse(JSON.stringify(out));
  };
  const leadData = async (id: string) =>
    JSON.parse(String((await db.execute({ sql: "SELECT data FROM tenant_records WHERE id = ?", args: [id] })).rows[0].data)) as Record<string, unknown>;

  const { clientsBlankStart } = await import("../scripts/clients-blank-start");
  console.log("clients-blank-start:");

  const original = await snapshot();
  await check("the dry run writes nothing and lists the five changes it would make", async () => {
    const steps = await clientsBlankStart({ apply: false, db, now: NOW });
    assert.deepEqual(steps.map((s) => [s.step, s.state]), [
      ["archive customer", "would_change"],
      ["retire deal", "would_change"],
      ["correct deal", "would_change"],
      ["retire deal", "would_change"],
      ["correct deal", "would_change"],
    ]);
    assert.match(steps[0].detail, /archived_at null -> now; contact 19ca3463-1b8c-42e2-8291-dff06deeadae kept/);
    assert.match(steps[1].detail, /stage launched -> lost \(manual_archive, operator_archived_lead\)/);
    assert.match(steps[2].detail, /tags \["breeze","active-client","retainer"\] -> \["breeze","retainer"\]/);
    assert.doesNotMatch(steps[2].detail, /client_tenant_id/, "the BreezeAdvance deal names no workspace");
    assert.match(steps[4].detail, new RegExp(`client_tenant_id \\(none\\) -> "${SUNBIZ}"`));
    assert.deepEqual(await snapshot(), original, "a dry run changed a row");
  });

  await check("--apply archives the record (lifecycle and contact kept) and retires both deals through manual_archive", async () => {
    const steps = await clientsBlankStart({ apply: true, db, now: NOW });
    assert.deepEqual(steps.map((s) => s.state), ["changed", "changed", "changed", "changed", "changed"]);
    const c = (await db.execute({ sql: "SELECT * FROM customers WHERE id = ?", args: [CUSTOMER] })).rows[0];
    assert.equal(c.archived_at, NOW.toISOString());
    assert.equal(c.lifecycle, "active", "archived, not moved to Past");
    assert.equal(c.display_name, "BreezeAdvance");
    assert.equal(c.source_lead_id, BREEZE_LEAD);
    const contact = (await db.execute({ sql: "SELECT * FROM customer_contacts WHERE id = ?", args: [CONTACT] })).rows[0];
    assert.equal(contact?.customer_id, CUSTOMER, "the contact row is kept");
    for (const id of [BREEZE_LEAD, SUNBIZ_LEAD]) assert.equal((await leadData(id)).stage, "lost");
    const bumps = (await db.execute("SELECT payload FROM agent_events WHERE event_type = 'BRAVO_LEAD_AUTO_BUMPED' ORDER BY 1")).rows
      .map((r) => JSON.parse(String(r.payload)) as Record<string, unknown>)
      .map((p) => [p.lead_id, p.from, p.to, p.reason, p.via]);
    assert.deepEqual(
      bumps.sort(),
      [
        [BREEZE_LEAD, "launched", "lost", "operator_archived_lead", "manual_archive"],
        [SUNBIZ_LEAD, "launched", "lost", "operator_archived_lead", "manual_archive"],
      ].sort(),
    );
  });

  await check("--apply corrects each deal: a dated note, active-client dropped, notes kept, SunBiz names the retired tenant", async () => {
    const breeze = await leadData(BREEZE_LEAD);
    const sunbiz = await leadData(SUNBIZ_LEAD);
    assert.equal(breeze.notes, BREEZE_NOTES, "the original notes are untouched");
    assert.equal(sunbiz.notes, SUNBIZ_NOTES, "the original notes are untouched");
    assert.match(String(breeze.notes_correction), /^2026-10-02: Not an OASIS client \(CC\)\./);
    assert.match(String(sunbiz.notes_correction), /^2026-10-02: Not an OASIS client \(CC\)\. SunBiz is a business OASIS retired on 2026-09-28/);
    assert.deepEqual(breeze.tags, ["breeze", "retainer"]);
    assert.deepEqual(sunbiz.tags, ["sunbiz", "retainer"]);
    assert.equal(sunbiz.client_tenant_id, SUNBIZ);
    assert.equal(breeze.client_tenant_id, undefined, "BreezeAdvance has no workspace to name");
    assert.equal(breeze.status, "active", "fields outside the plan are left as they were");
    assert.equal(breeze.stage_backfilled_from, "active_client");
  });

  await check("nothing is deleted, and Clients is a blank start: no listed record, no deal to convert, SunBiz refused", async () => {
    const now = await snapshot();
    for (const t of ["customers", "customer_contacts", "tenant_records", "tenants"]) {
      assert.equal((now[t] as unknown[]).length, (original[t] as unknown[]).length, `${t} lost a row`);
    }
    const store = await import("../lib/os/customers/store");
    assert.deepEqual((await store.listCustomers(db, OASIS, {})).rows, [], "a listed client record");
    assert.deepEqual((await store.listCustomers(db, OASIS, { includeArchived: true })).rows.map((r) => r.display_name), ["BreezeAdvance"]);
    const { buildClientRows } = await import("../components/os/landings/clients-model");
    const leads = [BREEZE_LEAD, SUNBIZ_LEAD].map(async (id) => ({ id, data: await leadData(id) }));
    const built = buildClientRows({ leads: await Promise.all(leads), projects: [], tickets: [] });
    assert.deepEqual([built.rows, built.past], [[], []], "a deal left to convert or to file under Past");
    // Even moved back to a client stage by hand, the SunBiz deal can never become a record.
    await db.execute({ sql: "UPDATE tenant_records SET data = json_set(data, '$.stage', 'launched') WHERE id = ?", args: [SUNBIZ_LEAD] });
    try {
      assert.deepEqual(await store.convertLeadToCustomer(db, OASIS, SUNBIZ_LEAD, CC, NOW), { ok: false, status: 409, error: "retired_business" });
    } finally {
      await db.execute({ sql: "UPDATE tenant_records SET data = json_set(data, '$.stage', 'lost') WHERE id = ?", args: [SUNBIZ_LEAD] });
    }
  });

  await check("a second --apply changes nothing", async () => {
    const before = await snapshot();
    const steps = await clientsBlankStart({ apply: true, db, now: new Date(NOW.getTime() + 60_000) });
    assert.deepEqual(steps.map((s) => s.state), ["already_done", "already_done", "already_done", "already_done", "already_done"]);
    assert.deepEqual(await snapshot(), before);
  });

  if (failures) {
    console.log(`clients-blank-start: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("clients-blank-start: ok");
  process.exit(0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
