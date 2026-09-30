/**
 * ledger-core.test.ts — the Business Ledger core (plan §F2.1-F2.3).
 *
 * WHY THIS EXISTS. The ledger is the record every KPI tile, the Feed and the
 * learning loops will read. The failures that matter are silent ones:
 *   - a "corrected" row that rewrote history instead of appending to it;
 *   - an event filed under the wrong workspace, or under none;
 *   - a retry that counted a meeting twice, or a key reused for another fact
 *     that quietly kept the old row;
 *   - an email address or a sentence parked in a payload the Law 25 erasure
 *     will never visit;
 *   - a ledger row with no business write behind it (or the reverse);
 *   - a Python producer writing a workspace it has no business in.
 * Each is driven here against REAL libSQL (a temp file with bravo__190 applied
 * through the same BEGIN/END-aware split scripts/apply_turso_migration.py
 * uses), the real ingest route, and the real approvals store.
 *
 * Run: node --conditions=react-server --import tsx tests/ledger-core.test.ts
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createClient, type Client } from "@libsql/client";

const ROOT = process.cwd();
const dbFile = join(mkdtempSync(join(tmpdir(), "ledger-core-")), "test.db");
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
const BEA_SECRET = "ledger-test-bea-secret-0123456789abcdef";
process.env.LEDGER_INGEST_SECRET_BEA = BEA_SECRET;
delete process.env.LEDGER_INGEST_SECRET_MAVEN;
delete process.env.LEDGER_INGEST_SECRET_ATLAS;

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452"; // oasis-ai-cc
const WEBDEV = "42423fde-be8b-454f-932a-750e8c9b743d"; // oasis-webdev
const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006b"; // a client workspace
const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110"; // retired 2026-09-28
const CC_USER = "0f000000-0000-4000-8000-000000000001";

let failures = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

/** scripts/apply_turso_migration.py split_statements, line for line: a trigger body stays one statement. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let depth = 0;
  for (const line of sql.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("--")) continue;
    buf.push(line);
    const upper = stripped.toUpperCase();
    if (/\bBEGIN\b/.test(upper)) depth += 1;
    if (/\bEND\s*;/.test(upper)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        out.push(buf.join("\n").trim().replace(/;$/, "").trim());
        buf = [];
        continue;
      }
    }
    if (depth === 0 && stripped.endsWith(";")) {
      out.push(buf.join("\n").trim().replace(/;$/, "").trim());
      buf = [];
    }
  }
  const tail = buf.join("\n").trim().replace(/;$/, "").trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

const LEDGER_SQL = readFileSync(join(ROOT, "database", "turso", "bravo__190_ledger_core.sql"), "utf8");
const APPROVALS_SQL = readFileSync(join(ROOT, "database", "turso", "bravo__186_os_approvals.sql"), "utf8");

function sign(body: string, ts: number, secret = BEA_SECRET): string {
  return createHmac("sha256", secret).update(`${ts}.${body}`, "utf8").digest("hex");
}
function ingestRequest(body: unknown, opts: { producer?: string; ts?: number; secret?: string; sig?: string; raw?: string } = {}): Request {
  const raw = opts.raw ?? JSON.stringify(body);
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  return new Request("https://occ.test/api/ledger/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ledger-producer": opts.producer ?? "bea",
      "x-ledger-timestamp": String(ts),
      "x-ledger-signature": opts.sig ?? sign(raw, ts, opts.secret),
    },
    body: raw,
  });
}

async function count(db: Client, sql: string, args: (string | number)[] = []): Promise<number> {
  const rs = await db.execute({ sql, args });
  return Number(rs.rows[0]?.n ?? 0);
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      display_name TEXT, full_name TEXT);
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL,
      data TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE customers (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, display_name TEXT);
    CREATE TABLE cas_probe (id TEXT PRIMARY KEY, status TEXT NOT NULL);
  `);
  for (const s of splitStatements(APPROVALS_SQL)) await db.execute(s);
  const ledgerStatements = splitStatements(LEDGER_SQL);
  for (const s of ledgerStatements) await db.execute(s);
  await db.batch(
    [
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-webdev', 'OASIS Web')", args: [WEBDEV] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-co', 'Client Co')", args: [CLIENT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'submissions', 'SunBiz')", args: [SUNBIZ] },
      ...[
        ["lead-oasis-1", OASIS],
        ["lead-oasis-2", OASIS],
        ["lead-webdev-1", WEBDEV],
        ["lead-client-1", CLIENT],
      ].map(([id, t]) => ({
        sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data, updated_at) VALUES (?, ?, 'lead', '{}', '2026-09-01T00:00:00Z')",
        args: [id, t],
      })),
      { sql: "INSERT INTO customers (id, tenant_id, display_name) VALUES ('cust-oasis-1', ?, 'Harbour Co')", args: [OASIS] },
      { sql: "INSERT INTO customers (id, tenant_id, display_name) VALUES ('cust-client-1', ?, 'Other Co')", args: [CLIENT] },
    ],
    "write",
  );

  const emitMod = await import("../lib/ledger/emit");
  const { emit, emitIfChanged, assertNoPayloadConflicts, findPayloadConflicts, newLedgerId, LedgerValidationError, LedgerConflictError } = emitMod;
  type EmitInput = import("../lib/ledger/emit").EmitInput;
  const catalog = await import("../lib/ledger/catalog");
  const read = await import("../lib/ledger/read");
  const { purgeTenantLedger } = await import("../lib/ledger/purge");
  const ingestMod = await import("../lib/ledger/ingest");
  const route = await import("../app/api/ledger/ingest/route");
  const store = await import("../lib/os/approvals/store");

  // A native emit names the key's owning module as its producer (one writer per key).
  const ownerOf = (key: string) => catalog.LEDGER_CATALOG.get(key)?.owningModule ?? "unknown-module";
  const base = (over: Partial<EmitInput> = {}): EmitInput => ({
    tenantId: OASIS,
    eventKey: "lead.captured",
    eventVersion: 1,
    occurredAt: "2026-09-20T10:00:00.000Z",
    subject: { type: "lead", id: "lead-oasis-1" },
    contactId: "lead-oasis-1",
    actor: { type: "system", id: null },
    source: "native",
    idempotencyKey: "form:sub-1",
    confidence: "verified",
    payload: { capture_channel: "form", form_id: "form-1" },
    producer: ownerOf(over.eventKey ?? "lead.captured"),
    ...over,
  });
  const refused = (fn: () => unknown, code: string, field?: string) => {
    assert.throws(fn, (e: unknown) => {
      assert.ok(e instanceof LedgerValidationError, `expected LedgerValidationError, got ${String(e)}`);
      assert.equal(e.code, code);
      if (field) assert.equal(e.field, field);
      return true;
    });
  };
  const ledgerCount = (where = "1", args: (string | number)[] = []) => count(db, `SELECT COUNT(*) AS n FROM outcome_events WHERE ${where}`, args);

  // ── 1. Migration ─────────────────────────────────────────────────────────
  console.log("migration");
  await check("bravo__190 creates the ledger tables; every outcome_events index leads with tenant_id; re-running is a no-op", async () => {
    for (const t of ["outcome_events", "ledger_dead_letters", "ledger_reconciliation_runs", "ledger_purge_grants"]) {
      assert.equal(await count(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", [t]), 1, t);
    }
    for (const table of ["outcome_events", "ledger_reconciliation_runs"]) {
      const cols = (await db.execute(`PRAGMA table_info(${table})`)).rows;
      assert.equal(Number(cols.find((c) => c.name === "tenant_id")?.notnull), 1, `${table}.tenant_id NOT NULL`);
      const idx = (await db.execute(`PRAGMA index_list(${table})`)).rows.filter((i) => !String(i.name).startsWith("sqlite_autoindex"));
      assert.ok(idx.length > 0, `${table} has indexes`);
      for (const i of idx) {
        const first = (await db.execute(`PRAGMA index_info(${String(i.name)})`)).rows.find((c) => Number(c.seqno) === 0);
        assert.equal(first?.name, "tenant_id", `${table}.${String(i.name)} leads with tenant_id`);
      }
    }
    const uq = (await db.execute("PRAGMA index_list(outcome_events)")).rows.find((i) => i.name === "ux_outcome_events_idem");
    assert.equal(Number(uq?.unique), 1, "UNIQUE(tenant_id, idempotency_key)");
    const uqCols = (await db.execute("PRAGMA index_info(ux_outcome_events_idem)")).rows.map((r) => String(r.name));
    assert.deepEqual(uqCols, ["tenant_id", "idempotency_key"]);
    for (const s of ledgerStatements) await db.execute(s);
    assert.doesNotMatch(LEDGER_SQL.replace(/--.*$/gm, ""), /\bDROP\b|\bALTER\b/i, "additive only");
    // No enum CHECK constraints: the vocabularies live in lib/ledger/catalog.ts.
    assert.doesNotMatch(LEDGER_SQL.replace(/--.*$/gm, ""), /\bCHECK\s*\(/i);
  });

  // ── 2. Append-only and tenant rules ──────────────────────────────────────
  console.log("append-only");
  await db.batch([emit(base())], "write");
  await check("outcome_events: UPDATE of any column aborts (tenant_id included), DELETE aborts", async () => {
    await assert.rejects(db.execute("UPDATE outcome_events SET payload_json = '{}'"), /append-only/);
    await assert.rejects(db.execute({ sql: "UPDATE outcome_events SET tenant_id = ?", args: [CLIENT] }), /append-only/);
    await assert.rejects(db.execute({ sql: "DELETE FROM outcome_events WHERE tenant_id = ?", args: [OASIS] }), /append-only/);
    assert.equal(await ledgerCount("tenant_id = ?", [OASIS]), 1);
  });

  await check("REPLACE cannot rewrite a row: INSERT OR REPLACE / REPLACE INTO on a stored key or id are no-ops", async () => {
    // SQLite fires no DELETE trigger for a REPLACE's delete while recursive_triggers is off.
    assert.equal(Number((await db.execute("PRAGMA recursive_triggers")).rows[0]?.recursive_triggers), 0);
    await db.batch([emit(base({ idempotencyKey: "form:replace-1" }))], "write");
    const stored = async () =>
      (await db.execute({ sql: "SELECT * FROM outcome_events WHERE tenant_id = ? AND idempotency_key = 'form:replace-1'", args: [OASIS] })).rows;
    const [before] = await stored();
    const asReplace = (sql: string, verb: string) => sql.replace(/^INSERT INTO/, verb).replace(/\s*ON CONFLICT[\s\S]*$/, "");
    // The same key, different content and an older time.
    const other = emit(base({ idempotencyKey: "form:replace-1", occurredAt: "2020-01-01T00:00:00.000Z", payload: { capture_channel: "dm" } }));
    for (const verb of ["INSERT OR REPLACE INTO", "REPLACE INTO"]) {
      assert.equal((await db.execute({ sql: asReplace(other.sql, verb), args: other.args })).rowsAffected, 0, `${verb} on the key`);
    }
    // The same id under a new key.
    const sameId = emit(base({ idempotencyKey: "form:replace-2", payload: { capture_channel: "dm" } }));
    const args = [...sameId.args];
    args[0] = before.id;
    assert.equal((await db.execute({ sql: asReplace(sameId.sql, "INSERT OR REPLACE INTO"), args })).rowsAffected, 0, "on the id");
    assert.equal((await db.execute({ sql: "REPLACE INTO outcome_events SELECT * FROM outcome_events WHERE id = ?", args: [before.id] })).rowsAffected, 0);
    assert.deepEqual(await stored(), [before], "the stored row is untouched");
    assert.equal(await ledgerCount("idempotency_key = 'form:replace-2'"), 0);
    // A new key still inserts through the same trigger.
    assert.equal((await db.batch([emit(base({ idempotencyKey: "form:replace-3" }))], "write"))[0].rowsAffected, 1);
  });

  await check("tenant_id is required: emit refuses an empty or blank tenant, and the column refuses NULL", async () => {
    refused(() => emit(base({ tenantId: "" })), "tenant_required", "tenant_id");
    refused(() => emit(base({ tenantId: "   " })), "tenant_required", "tenant_id");
    refused(() => emit(base({ tenantId: undefined as unknown as string })), "tenant_required", "tenant_id");
    const stmt = emit(base({ idempotencyKey: "form:null-tenant" }));
    const args = [...stmt.args];
    args[1] = null;
    await assert.rejects(db.execute({ sql: stmt.sql, args }), /NOT NULL/);
  });

  await check("reconciliation runs and dead letters never change tenant", async () => {
    await db.execute({
      sql: "INSERT INTO ledger_reconciliation_runs (id, tenant_id, kind, started_at) VALUES ('run-1', ?, 'stage_replay', '2026-09-29T00:00:00.000Z')",
      args: [OASIS],
    });
    await db.execute("UPDATE ledger_reconciliation_runs SET finished_at = '2026-09-29T00:01:00.000Z', checked = 5 WHERE id = 'run-1'");
    await assert.rejects(db.execute({ sql: "UPDATE ledger_reconciliation_runs SET tenant_id = ? WHERE id = 'run-1'", args: [CLIENT] }), /immutable/);
    await db.execute(
      "INSERT INTO ledger_dead_letters (id, producer, fingerprint, payload_json, error, first_seen, last_seen) VALUES ('dl-t', 'bea', 'fp-t', '{}', 'x', 't', 't')",
    );
    await db.execute({ sql: "UPDATE ledger_dead_letters SET tenant_hint = ? WHERE id = 'dl-t'", args: [OASIS] });
    await assert.rejects(db.execute({ sql: "UPDATE ledger_dead_letters SET tenant_hint = ? WHERE id = 'dl-t'", args: [CLIENT] }), /immutable/);
    await db.execute("DELETE FROM ledger_dead_letters WHERE id = 'dl-t'");
  });

  await check("purge: only a retired tenant, only through the grant, only that tenant, and the grant does not outlive it", async () => {
    await db.batch(
      [
        emit(base({ tenantId: SUNBIZ, idempotencyKey: "form:sb-1", subject: { type: "lead", id: "sb-lead" }, contactId: "sb-lead" })),
        emit(base({ tenantId: SUNBIZ, idempotencyKey: "form:sb-2", subject: { type: "lead", id: "sb-lead" }, contactId: "sb-lead" })),
      ],
      "write",
    );
    const oasisBefore = await ledgerCount("tenant_id = ?", [OASIS]);
    await assert.rejects(purgeTenantLedger(db, { tenantId: OASIS, operator: "cc", reason: "test", now: new Date() }), /not retired/);
    // A grant for one tenant does not open another tenant's rows.
    await db.execute({ sql: "INSERT INTO ledger_purge_grants VALUES (?, 'cc', 'test', 't')", args: [SUNBIZ] });
    await assert.rejects(db.execute({ sql: "DELETE FROM outcome_events WHERE tenant_id = ?", args: [OASIS] }), /append-only/);
    await db.execute({ sql: "DELETE FROM ledger_purge_grants WHERE tenant_id = ?", args: [SUNBIZ] });
    await assert.rejects(db.execute({ sql: "DELETE FROM outcome_events WHERE tenant_id = ?", args: [SUNBIZ] }), /append-only/);
    const r = await purgeTenantLedger(db, { tenantId: SUNBIZ, operator: "cc", reason: "Law 25 offboard", now: new Date() });
    assert.equal(r.deleted, 2);
    assert.equal(await ledgerCount("tenant_id = ?", [SUNBIZ]), 0);
    assert.equal(await ledgerCount("tenant_id = ?", [OASIS]), oasisBefore, "the other tenant is untouched");
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM ledger_purge_grants"), 0, "no grant survives the purge");
  });

  await check("purge: an id typed in another case purges the stored (lower-case) tenant, never reports 0 over a full ledger", async () => {
    await db.batch(
      [
        emit(base({ tenantId: SUNBIZ, idempotencyKey: "form:sb-3", subject: { type: "lead", id: "sb-lead" }, contactId: "sb-lead" })),
        emit(base({ tenantId: SUNBIZ, idempotencyKey: "form:sb-4", subject: { type: "lead", id: "sb-lead" }, contactId: "sb-lead" })),
      ],
      "write",
    );
    const r = await purgeTenantLedger(db, { tenantId: ` ${SUNBIZ.toUpperCase()} `, operator: "cc", reason: "Law 25 offboard", now: new Date() });
    assert.deepEqual(r, { tenantId: SUNBIZ, deleted: 2 });
    assert.equal(await ledgerCount("tenant_id = ?", [SUNBIZ]), 0);
  });

  // ── 3. Idempotency ───────────────────────────────────────────────────────
  console.log("idempotency");
  await check("the same key and content twice is one row; the conflict check is clean", async () => {
    const a = emit(base({ idempotencyKey: "form:idem-1" }));
    await db.batch([a], "write");
    const b = emit(base({ idempotencyKey: "form:idem-1" }));
    const res = await db.batch([b], "write");
    assert.equal(res[0].rowsAffected, 0, "the re-send inserted nothing");
    assert.equal(await ledgerCount("idempotency_key = 'form:idem-1'"), 1);
    assert.deepEqual(await findPayloadConflicts(db, [a, b]), []);
    await assertNoPayloadConflicts(db, [b]);
    assert.equal(a.ledger.payloadHash, b.ledger.payloadHash, "honest re-send hashes the same (server time is not content)");
  });

  await check("the same key with different content is a loud error, and the first row is kept", async () => {
    const first = emit(base({ idempotencyKey: "form:idem-2" }));
    await db.batch([first], "write");
    const other = emit(base({ idempotencyKey: "form:idem-2", payload: { capture_channel: "dm" } }));
    await db.batch([other], "write");
    await assert.rejects(assertNoPayloadConflicts(db, [other]), (e: unknown) => {
      assert.ok(e instanceof LedgerConflictError);
      assert.equal(e.conflicts.length, 1);
      assert.equal(e.conflicts[0].problem, "payload_mismatch");
      assert.equal(e.conflicts[0].storedHash, first.ledger.payloadHash);
      return true;
    });
    const rs = await db.execute("SELECT payload_json FROM outcome_events WHERE idempotency_key = 'form:idem-2'");
    assert.equal(rs.rows.length, 1);
    assert.match(String(rs.rows[0].payload_json), /"form"/);
  });

  await check("payload_hash covers the fact (when, who, counted where, linked to what) and not how it was recorded", () => {
    const hash = (over: Partial<EmitInput>, now = new Date("2026-09-29T00:00:00.000Z")) =>
      emit(base({ idempotencyKey: "form:hash-1", ...over }), now).ledger.payloadHash;
    const ref = hash({});
    const fact: [string, Partial<EmitInput>][] = [
      ["occurred_at", { occurredAt: "2025-01-01T00:00:00.000Z" }],
      ["department_key", { department: "finance" }],
      ["actor_type", { actor: { type: "agent", id: null } }],
      ["actor_id", { actor: { type: "system", id: "scheduler-1" } }],
      ["touch_id", { touchId: "touch-other" }],
      ["approval_id", { approvalId: "appr-9" }],
      ["routine_run_id", { routineRunId: "run-9" }],
      ["subject_id", { subject: { type: "lead", id: "lead-oasis-2" }, contactId: "lead-oasis-2" }],
      ["contact_id", { contactId: "lead-oasis-2" }],
      ["deal_id", { dealId: "deal-9" }],
      ["customer_id", { customerId: "cust-oasis-1" }],
      ["payload", { payload: { capture_channel: "dm" } }],
    ];
    for (const [field, over] of fact) assert.notEqual(hash(over), ref, `${field} is part of the fact`);
    const recording: [string, Partial<EmitInput>][] = [
      ["source", { source: "import" }],
      ["source_ref", { sourceRef: "row-17" }],
      ["confidence", { confidence: "inferred" }],
      ["causation_id", { causationId: "cause-1" }],
      ["correlation_id", { correlationId: "corr-1" }],
    ];
    for (const [field, over] of recording) assert.equal(hash(over), ref, `${field} describes the recording, not the fact`);
    assert.equal(hash({}, new Date("2027-01-01T00:00:00.000Z")), ref, "server time and the minted id are not content");
    // Changing the list re-hashes every stored key: pinned.
    assert.deepEqual([...emitMod.FACT_COLUMNS].sort(), [
      "actor_id", "actor_type", "approval_id", "contact_id", "currency", "customer_id", "deal_id", "department_key",
      "event_key", "event_version", "occurred_at", "routine_run_id", "subject_id", "subject_type", "touch_id", "value_cents",
    ]);
  });

  await check("an unconditional ledger statement that never ran is reported missing", async () => {
    const orphan = emit(base({ idempotencyKey: "form:never-batched" }));
    await assert.rejects(assertNoPayloadConflicts(db, [orphan]), (e: unknown) => {
      assert.ok(e instanceof LedgerConflictError);
      assert.equal(e.conflicts[0].problem, "missing");
      return true;
    });
  });

  // ── 4. Catalog validation ────────────────────────────────────────────────
  console.log("validation");
  await check("unknown key, unsupported version and a subject the key is not about are refused", () => {
    refused(() => emit(base({ eventKey: "lead.teleported" })), "event_key_unknown", "event_key");
    refused(() => emit(base({ eventVersion: 2 })), "event_version_unsupported", "event_version");
    refused(() => emit(base({ subject: { type: "invoice", id: "inv-1" } })), "subject_type_not_allowed", "subject.type");
    refused(() => emit(base({ contactId: null })), "join_key_required", "contact_id");
    refused(() => emit(base({ occurredAt: "yesterday" })), "occurred_at_invalid", "occurred_at");
  });

  await check("PII-looking values and free text never reach a payload", () => {
    // A sentence where a code belongs.
    refused(() => emit(base({ eventKey: "deal.lost", subject: { type: "deal", id: "deal-1" }, dealId: "deal-1",
      payload: { pipeline_key: "oasis", cycle: 1, lost_reason: "Jane said it was too expensive" } })), "payload_not_a_code", "payload.lost_reason");
    // An email address and an E.164 phone where an id belongs.
    refused(() => emit(base({ payload: { capture_channel: "form", form_id: "jane@harbour.test" } })), "payload_not_an_id", "payload.form_id");
    refused(() => emit(base({ payload: { capture_channel: "form", form_id: "+15145550199" } })), "payload_not_an_id", "payload.form_id");
    // A field the schema does not declare: there is nowhere to put a note.
    refused(() => emit(base({ payload: { capture_channel: "form", note: "called her twice" } })), "payload_field_unknown", "payload.note");
    refused(() => emit(base({ payload: { capture_channel: "fax" } })), "payload_code_unknown", "payload.capture_channel");
    refused(() => emit(base({ subject: { type: "lead", id: "jane@harbour.test" } })), "not_an_id", "subject.id");
    refused(() => emit(base({ actor: { type: "human", id: "Jane Doe" } })), "not_an_id", "actor_id");
  });

  await check("a phone number, a postal code or a name pair is not an id, even in id characters", () => {
    const personal = [
      "5145550199", "15145550199", "514-555-0199", "514.555.0199", "555-0199", "1-514-555-0199",
      "H2X1Y4", "H2X-1Y4", "h2x1y4", "Jane.Doe", "Jean-Tremblay", "Jean_Tremblay", "Marie.Claire.Roy",
    ];
    for (const v of personal) {
      assert.equal(catalog.isLedgerId(v), false, v);
      refused(() => emit(base({ payload: { capture_channel: "form", form_id: v } })), "payload_not_an_id", "payload.form_id");
    }
    refused(() => emit(base({ subject: { type: "lead", id: "5145550199" } })), "not_an_id", "subject.id");
    refused(() => emit(base({ contactId: "514-555-0199" })), "not_an_id", "contact_id");
    refused(() => emit(base({ actor: { type: "human", id: "Jean.Tremblay" } })), "not_an_id", "actor_id");
    refused(() => emit(base({ touchId: "H2X-1Y4" })), "not_an_id", "touch_id");
    // Real ids keep working: uuids, slugs, provider ids, long platform ids, a namespaced numeric id.
    for (const v of [OASIS, "lead-oasis-1", "form-1", "ch_3PabcDEF", "gmail-18f2a", "18f2a3b4c5d6e7f8", "17841400000000000",
      "tg:5165125484", "sales.team", "cust_123456", "1234567", "01J9ZK3M4N5P6Q7R8S9T0V1W2X"]) {
      assert.equal(catalog.isLedgerId(v), true, v);
    }
  });

  await check("a timestamp must carry its zone: a naive one is refused, not read in the server's local time", () => {
    refused(() => emit(base({ occurredAt: "2026-09-20T10:00:00" })), "occurred_at_invalid", "occurred_at");
    refused(() => emit(base({ occurredAt: "2026-09-20T10:00:00.123456" })), "occurred_at_invalid", "occurred_at");
    const at = (occurredAt: string) => emit(base({ idempotencyKey: "form:tz-1", occurredAt })).args[4];
    assert.equal(at("2026-09-20T10:00:00Z"), "2026-09-20T10:00:00.000Z");
    assert.equal(at("2026-09-20T10:00:00.123456+00:00"), "2026-09-20T10:00:00.123Z", "Python's aware isoformat()");
    assert.equal(at("2026-09-20T06:00:00-04:00"), "2026-09-20T10:00:00.000Z");
    const meeting = (startsAt: string) =>
      emit(base({ eventKey: "meeting.booked", subject: { type: "meeting", id: "ev1" }, idempotencyKey: "cal:google:ev1:booked:1",
        payload: { provider: "google", provider_event_id: "ev1", starts_at: startsAt } }));
    refused(() => meeting("2026-10-01T15:00:00"), "payload_not_a_time", "payload.starts_at");
    assert.match(meeting("2026-10-01T15:00:00-04:00").args.at(-2) as string, /"starts_at":"2026-10-01T19:00:00.000Z"/);
  });

  await check("an impossible date or clock is refused, never rolled over into another day (CodeRabbit #481)", () => {
    for (const bad of [
      "2026-02-30T10:00:00Z", // Date.parse would store 2026-03-02
      "2026-04-31T10:00:00Z",
      "2027-02-29T10:00:00Z", // not a leap year
      "2026-13-01T10:00:00Z",
      "2026-00-10T10:00:00Z",
      "2026-09-20T24:30:00Z",
      "2026-09-20T10:60:00Z",
      "2026-09-20T10:00:60Z",
      "2026-09-20T10:00:00+25:00",
      "2026-09-20T10:00:00+05:75",
    ]) {
      assert.equal(catalog.zonedTimeToIso(bad), null, bad);
      refused(() => emit(base({ occurredAt: bad })), "occurred_at_invalid", "occurred_at");
    }
    assert.equal(catalog.zonedTimeToIso("2028-02-29T10:00:00Z"), "2028-02-29T10:00:00.000Z", "a real leap day passes");
    assert.equal(catalog.zonedTimeToIso("2026-09-20T23:59:59+14:00"), "2026-09-20T09:59:59.000Z");
  });

  await check("no two event keys share an idempotency template, so one event can never swallow another's key (CodeRabbit #481)", () => {
    // Two event keys may share a template only when the key can never collide:
    //   - mutually exclusive outcomes of ONE thing (a meeting is held or missed,
    //     a run completes or fails, never both);
    //   - the template ends in the provider's own per-event id, unique for every
    //     event whatever its type (a delivery and a bounce never share one).
    // A counter such as {n} restarts per event type, so it must never be shared.
    const exclusive = new Set(["meeting.held|meeting.no_show", "routine.run_completed|routine.run_failed"]);
    const perEventId = /\{(?:provider_event_id|event_id|approval_event_id)\}$/;
    const byTemplate = new Map<string, string[]>();
    for (const e of catalog.CATALOG_ENTRIES) byTemplate.set(e.idempotency, [...(byTemplate.get(e.idempotency) ?? []), e.key]);
    const collisions = [...byTemplate]
      .filter(([template, keys]) => keys.length > 1 && !perEventId.test(template) && !exclusive.has([...keys].sort().join("|")))
      .map(([template, keys]) => `${keys.join(" and ")} share ${template}`);
    assert.deepEqual(collisions, [], collisions.join("; "));
    assert.match(catalog.LEDGER_CATALOG.get("consent.revoked")!.idempotency, /:revoked:/);
    assert.match(catalog.LEDGER_CATALOG.get("consent.granted")!.idempotency, /:granted:/);
  });

  await check("value_cents is never negative: money going back is refund.issued, not a negative payment", () => {
    const pay = { eventKey: "payment.received", subject: { type: "payment", id: "ch_neg" }, contactId: null,
      payload: { provider_payment_id: "ch_neg" }, source: "stripe" as const, idempotencyKey: "stripe:ch_neg", currency: "CAD" };
    refused(() => emit(base({ ...pay, valueCents: -500000 })), "value_cents_negative", "value_cents");
    refused(() => emit(base({ ...pay, eventKey: "invoice.paid", subject: { type: "invoice", id: "in_1" },
      payload: { invoice_id: "in_1", source_system: "stripe" }, idempotencyKey: "inv:in_1:paid", valueCents: -1 })), "value_cents_negative", "value_cents");
    refused(() => emit(base({ ...pay, eventKey: "refund.issued", subject: { type: "refund", id: "re_1" },
      payload: { provider_refund_id: "re_1" }, idempotencyKey: "stripe:re_1", valueCents: -100 })), "value_cents_negative", "value_cents");
    assert.ok(emit(base({ ...pay, valueCents: 0 })));
    assert.ok(emit(base({ ...pay, valueCents: 500000 })));
  });

  await check("value, vocabulary and backfill rules", () => {
    refused(() => emit(base({ valueCents: 5000, currency: "CAD" })), "value_not_allowed", "value_cents");
    const pay = { eventKey: "payment.received", subject: { type: "payment", id: "ch_1" }, contactId: null,
      payload: { provider_payment_id: "ch_1" }, source: "stripe" as const };
    refused(() => emit(base(pay)), "value_required", "value_cents");
    refused(() => emit(base({ ...pay, valueCents: 5000 })), "currency_required", "currency");
    refused(() => emit(base({ ...pay, valueCents: 5000, currency: "cad" })), "currency_invalid", "currency");
    assert.ok(emit(base({ ...pay, valueCents: 5000, currency: "CAD", idempotencyKey: "stripe:ch_1" })).sql.includes("INSERT"));
    refused(() => emit(base({ actor: { type: "robot" as never } })), "actor_type_unknown", "actor_type");
    refused(() => emit(base({ source: "fax" as never })), "source_unknown", "source");
    refused(() => emit(base({ confidence: "sure" as never })), "confidence_unknown", "confidence");
    refused(() => emit(base({ source: "backfill", confidence: "verified" })), "backfill_must_be_inferred", "confidence");
    assert.ok(emit(base({ source: "backfill", confidence: "inferred", idempotencyKey: "form:backfill-1" })));
    refused(() => emit(base({ department: "legal" as never })), "department_unknown", "department_key");
    refused(() => emit(base({ idempotencyKey: "has a space" })), "idempotency_key_invalid", "idempotency_key");
  });

  // ── 5. emit never writes; emitIfChanged follows the guarded change ───────
  console.log("statements");
  await check("emit and emitIfChanged only build statements: nothing is written until the caller batches them", async () => {
    const before = await ledgerCount();
    const s1 = emit(base({ idempotencyKey: "form:built-only-1" }));
    const s2 = emitIfChanged(base({ idempotencyKey: "form:built-only-2" }));
    assert.equal(typeof s1.sql, "string");
    assert.ok(Array.isArray(s2.args));
    assert.equal(await ledgerCount(), before);
    assert.equal(s1.ledger.conditional, false);
    assert.equal(s2.ledger.conditional, true);
  });

  await check("emitIfChanged writes nothing when the compare-and-swap before it changed nothing, and one row when it did", async () => {
    await db.execute("INSERT INTO cas_probe (id, status) VALUES ('p1', 'open')");
    const lost = await db.batch(
      [
        { sql: "UPDATE cas_probe SET status = 'closed' WHERE id = 'p1' AND status = 'closed-already'", args: [] },
        emitIfChanged(base({ idempotencyKey: "form:cas-lost" })),
      ],
      "write",
    );
    assert.equal(lost[0].rowsAffected, 0);
    assert.equal(await ledgerCount("idempotency_key = 'form:cas-lost'"), 0);
    const won = [
      { sql: "UPDATE cas_probe SET status = 'closed' WHERE id = 'p1' AND status = 'open'", args: [] },
      emitIfChanged(base({ idempotencyKey: "form:cas-won" })),
    ];
    await db.batch(won, "write");
    assert.equal(await ledgerCount("idempotency_key = 'form:cas-won'"), 1);
    // A conditional row that is legitimately absent is not a conflict.
    assert.deepEqual(await findPayloadConflicts(db, [emitIfChanged(base({ idempotencyKey: "form:cas-lost" }))]), []);
  });

  await check("ids are ULIDs that sort in minting order, even inside one millisecond", () => {
    const t = Date.UTC(2026, 8, 29, 12, 0, 0);
    const ids = [newLedgerId(t), newLedgerId(t), newLedgerId(t), newLedgerId(t + 1), newLedgerId(t - 5_000)];
    for (const x of ids) assert.match(x, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.deepEqual([...ids].sort(), ids, "lexical order = minting order");
    assert.equal(new Set(ids).size, ids.length);
  });

  // ── 6. The catalog itself ────────────────────────────────────────────────
  console.log("catalog");
  await check("the catalog: ~55+ unique domain.verb keys, real owners, valid departments, subjects and join keys", () => {
    const keys = catalog.CATALOG_ENTRIES.map((e) => e.key);
    assert.equal(new Set(keys).size, keys.length, "no key twice");
    assert.equal(catalog.LEDGER_CATALOG.size, keys.length);
    assert.ok(keys.length >= 55, `${keys.length} events`);
    for (const e of catalog.CATALOG_ENTRIES) {
      assert.match(e.key, /^[a-z_]+\.[a-z_]+$/, e.key);
      assert.ok(existsSync(join(ROOT, e.owningModule)), `${e.key}: owning module ${e.owningModule} exists`);
      assert.ok(catalog.DEPARTMENT_KEYS.includes(e.department), `${e.key}: department`);
      assert.ok(e.subjectTypes.length > 0 && e.subjectTypes.every((s) => catalog.SUBJECT_TYPES.includes(s)), `${e.key}: subjects`);
      assert.ok(e.requiredJoinKeys.every((k) => catalog.JOIN_KEYS.includes(k)), `${e.key}: join keys`);
      assert.ok(e.idempotency.length > 0 && e.description.length > 0, `${e.key}: documented`);
      if (e.owningModule === "app/api/ledger/ingest/route.ts") assert.ok(e.producers.length > 0, `${e.key}: an ingest-only key has producers`);
    }
    for (const k of ["approval.requested", "approval.approved", "approval.edited", "approval.sent_back", "approval.rejected", "approval.executed"]) {
      assert.ok(catalog.LEDGER_CATALOG.has(k), k);
    }
  });

  await check("one writer per event key: a module that imports the emitter names only the keys it owns", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) files.push(p);
      }
    };
    for (const d of ["lib", "app", "components"]) walk(join(ROOT, d));
    let emitters = 0;
    for (const f of files) {
      const rel = relative(ROOT, f).split("\\").join("/");
      if (rel.startsWith("lib/ledger/")) continue;
      const src = readFileSync(f, "utf8");
      if (!/from\s+["']@\/lib\/ledger\/emit["']/.test(src)) continue;
      emitters += 1;
      for (const m of src.matchAll(/["'`]([a-z_]+\.[a-z_]+)["'`]/g)) {
        const entry = catalog.LEDGER_CATALOG.get(m[1]);
        if (entry) assert.equal(entry.owningModule, rel, `${rel} names ${m[1]}, which ${entry.owningModule} owns`);
      }
    }
    assert.ok(emitters >= 1, "the approvals store emits, so the scan is not vacuous");
  });

  await check("a key with more than one writer declares, per writer, the keys it may build; emit enforces the writer", () => {
    let shared = 0;
    for (const e of catalog.CATALOG_ENTRIES) {
      const writers = [...(e.owningModule === catalog.INGEST_ONLY ? [] : ["native"]), ...e.producers];
      if (writers.length > 1) {
        shared += 1;
        assert.ok(e.writers, `${e.key} has writers ${writers.join(", ")} and no writers declaration`);
      }
      if (e.writers) assert.deepEqual(Object.keys(e.writers).sort(), [...writers].sort(), `${e.key}: one pattern per writer, none for a non-writer`);
    }
    assert.ok(shared > 0, "the check is not vacuous");
    // Every writer's pattern accepts the key its catalog template describes (a typo in a pattern refuses every real event).
    const runKey = (p: string) => `run:${p}:r1`;
    const examples: Record<string, Record<string, string>> = {
      "message.sent": { native: "msg:gmail:18f2a", bea: "msg:gmail:18f2a" },
      "content.published": { native: "post:instagram:17912345678901234", maven: "post:instagram:17912345678901234" },
      "lead.captured": { native: "form:sub-1", bea: "email:18f2a" },
      "meeting.booked": { native: "cal:google:ev1:booked:1", bea: "cal:google:ev1:booked:1" },
      "meeting.rescheduled": { native: "cal:google:ev1:rescheduled:2", bea: "cal:google:ev1:rescheduled:2" },
      "meeting.cancelled": { native: "cal:google:ev1:cancelled:3", bea: "cal:google:ev1:cancelled:3" },
      "consent.revoked": { native: "consent:lead-1:sms:revoked:1", bea: "consent:lead-1:email:revoked:1" },
      "suppression.added": { native: "suppress:sms:sup-1", bea: "suppress:email:sup-2" },
      "routine.run_completed": { bea: runKey("bea"), maven: runKey("maven"), atlas: runKey("atlas") },
      "routine.run_failed": { bea: runKey("bea"), maven: runKey("maven"), atlas: runKey("atlas") },
    };
    for (const e of catalog.CATALOG_ENTRIES) {
      if (!e.writers) continue;
      const ex = examples[e.key];
      assert.ok(ex, `${e.key}: add an example key per writer here`);
      for (const [writer, pattern] of Object.entries(e.writers)) {
        assert.ok(pattern?.test(ex[writer] ?? ""), `${e.key}: ${writer}'s pattern accepts ${ex[writer]}`);
      }
    }
    // A partition is a partition: no writer's example fits another writer's slice.
    for (const key of ["lead.captured", "consent.revoked", "suppression.added", "routine.run_completed", "routine.run_failed"]) {
      const w = catalog.LEDGER_CATALOG.get(key)?.writers ?? {};
      for (const [a, pa] of Object.entries(w)) {
        for (const [b, keyB] of Object.entries(examples[key])) if (a !== b) assert.equal(pa?.test(keyB), false, `${key}: ${a} may not build ${keyB}`);
      }
    }

    // Native: only the owning module, and never for a key that arrives only through ingest.
    refused(() => emit(base({ producer: "lib/drips/send.ts" })), "producer_not_owner", "producer");
    refused(() => emit(base({ eventKey: "message.received", subject: { type: "message", id: "m1" }, contactId: null, producer: catalog.INGEST_ONLY,
      payload: { channel: "email", provider: "gmail", provider_message_id: "m1", intent: "pricing_question" } })), "producer_not_owner", "producer");
    // Ingest: only a listed producer.
    refused(() => emit(base({ producer: "ingest:maven", idempotencyKey: "email:x1" })), "producer_not_allowed_for_event", "producer");
    // Partitioned: the app records form captures; BEA records DM, email and import captures.
    refused(() => emit(base({ idempotencyKey: "email:x1" })), "idempotency_key_off_template", "idempotency_key");
    refused(() => emit(base({ producer: "ingest:bea", idempotencyKey: "form:x1" })), "idempotency_key_off_template", "idempotency_key");
    assert.ok(emit(base({ producer: "ingest:bea:scripts/integrations/email_engine.py", idempotencyKey: "email:x1" })));
    // Shared template: both writers of message.sent build msg:{provider}:{provider_message_id}, so one send lands once.
    const sent = { eventKey: "message.sent", subject: { type: "message", id: "m1" }, payload: { channel: "email", provider: "gmail", provider_message_id: "m1" } };
    refused(() => emit(base({ ...sent, idempotencyKey: "send:appr-1" })), "idempotency_key_off_template", "idempotency_key");
    const native = emit(base({ ...sent, idempotencyKey: "msg:gmail:m1" }));
    const viaBea = emit(base({ ...sent, producer: "ingest:bea", idempotencyKey: "msg:gmail:m1" }));
    assert.equal(native.ledger.payloadHash, viaBea.ledger.payloadHash, "the same send from either writer is the same fact");
    // Routine runs: each harness numbers its own, in its own namespace.
    const run = { eventKey: "routine.run_completed", subject: { type: "routine_run", id: "r1" }, contactId: null, payload: { routine_key: "inbox_sweep" } };
    assert.ok(emit(base({ ...run, producer: "ingest:bea", idempotencyKey: "run:bea:r1" })));
    refused(() => emit(base({ ...run, producer: "ingest:bea", idempotencyKey: "run:maven:r1" })), "idempotency_key_off_template", "idempotency_key");
  });

  // ── 7. Ingest ────────────────────────────────────────────────────────────
  console.log("ingest");
  const received = (over: Record<string, unknown> = {}) => ({
    event_key: "message.received",
    event_version: 1,
    occurred_at: "2026-09-28T14:00:00.000Z",
    tenant_id: OASIS,
    subject: { type: "message", id: "gmail-18f2a" },
    actor: { type: "external", id: null },
    source: "gmail",
    idempotency_key: "gmail:18f2a",
    confidence: "verified",
    payload: { channel: "email", provider: "gmail", provider_message_id: "18f2a", intent: "pricing_question" },
    producer_ref: "scripts/integrations/email_engine.py",
    ...over,
  });
  const captured = (over: Record<string, unknown> = {}) => ({
    event_key: "lead.captured",
    event_version: 1,
    occurred_at: "2026-09-28T14:00:01.000Z",
    subject: { type: "lead", id: "lead-oasis-2" },
    contact_id: "lead-oasis-2",
    actor: { type: "agent", id: "bea" },
    source: "gmail",
    idempotency_key: "email:18f2a",
    confidence: "verified",
    payload: { capture_channel: "email" },
    ...over,
  });
  const post = async (req: Request) => {
    const res = await route.POST(req);
    return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; results?: { status: string; error?: string; field?: string }[] } };
  };
  const deadLetters = () => count(db, "SELECT COUNT(*) AS n FROM ledger_dead_letters");

  await check("a bad signature, a stale timestamp and an unknown producer are 401 and write nothing", async () => {
    const rows = await ledgerCount();
    const letters = await deadLetters();
    const body = { events: [received()] };
    const raw = JSON.stringify(body);
    const now = Math.floor(Date.now() / 1000);
    assert.equal((await post(ingestRequest(body, { sig: "0".repeat(64) }))).status, 401);
    assert.equal((await post(ingestRequest(body, { secret: "some-other-secret-0123456789abcdef" }))).status, 401);
    // Far outside the 300 s window, not at its edge: a clock tick between `now`
    // and the route's own check would pull a +301 s timestamp back inside it.
    const stale = await post(ingestRequest(body, { ts: now - 900, raw }));
    assert.equal(stale.status, 401);
    assert.equal(stale.body.error, "stale_timestamp");
    const future = await post(ingestRequest(body, { ts: now + 900, raw }));
    assert.equal(future.status, 401);
    assert.equal((await post(ingestRequest(body, { producer: "stranger" }))).status, 401);
    // The signature covers the timestamp: a fresh header on an old signature fails.
    assert.equal((await post(ingestRequest(body, { ts: now, sig: sign(raw, now - 400), raw }))).status, 401);
    assert.equal(await ledgerCount(), rows);
    assert.equal(await deadLetters(), letters, "unauthenticated input never reaches the database");
  });

  await check("the signature is over the raw bytes as sent: Python's spaced json.dumps verifies, a re-serialised body does not", async () => {
    // json.dumps() with its default separators: ", " and ": ".
    const pyDumps = (v: unknown): string =>
      Array.isArray(v)
        ? `[${v.map(pyDumps).join(", ")}]`
        : v !== null && typeof v === "object"
          ? `{${Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${JSON.stringify(k)}: ${pyDumps(x)}`).join(", ")}}`
          : JSON.stringify(v);
    const body = { events: [received({ idempotency_key: "gmail:py-spaced-1", payload: { channel: "email", provider: "gmail", provider_message_id: "py1", intent: "pricing_question" } })] };
    const spaced = pyDumps(body);
    assert.notEqual(spaced, JSON.stringify(body));
    const ok = await post(ingestRequest(null, { raw: spaced }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const ts = Math.floor(Date.now() / 1000);
    const signedCompact = await post(ingestRequest(null, { raw: spaced, ts, sig: sign(JSON.stringify(body), ts) }));
    assert.equal(signedCompact.status, 401, "a signature over another serialisation of the same JSON is not this body's");
  });

  await check("a producer may not re-file a department, claim a human did it, or mark it human_confirmed", async () => {
    const rows = await ledgerCount();
    const r = await post(
      ingestRequest({
        events: [
          received({ idempotency_key: "gmail:claim-1", department_key: "finance" }),
          received({ idempotency_key: "gmail:claim-2", actor: { type: "human", id: CC_USER } }),
          received({ idempotency_key: "gmail:claim-3", confidence: "human_confirmed" }),
          received({ idempotency_key: "gmail:claim-4", department_key: "sales" }),
        ],
      }),
    );
    assert.equal(r.status, 422);
    assert.deepEqual(r.body.results?.map((x) => [x.status, x.error ?? null, x.field ?? null]), [
      ["rejected", "department_not_allowed", "department_key"],
      ["rejected", "actor_not_allowed", "actor_type"],
      ["rejected", "confidence_not_allowed", "confidence"],
      ["written", null, null],
    ]);
    assert.equal(await ledgerCount(), rows + 1);
    const row = (await db.execute("SELECT department_key, actor_type, confidence FROM outcome_events WHERE idempotency_key = 'gmail:claim-4'")).rows[0];
    assert.deepEqual([row.department_key, row.actor_type, row.confidence], ["sales", "external", "verified"]);
  });

  await check("BEA may not write the app's slice of a shared key (a form capture)", async () => {
    const r = await post(ingestRequest({ events: [captured({ idempotency_key: "form:sub-from-bea" })] }));
    assert.equal(r.status, 422);
    assert.equal(r.body.results?.[0].error, "idempotency_key_off_template");
    assert.equal(await ledgerCount("idempotency_key = 'form:sub-from-bea'"), 0);
  });

  await check("a chunked body with no Content-Length is cut off at the cap, not read whole before the signature check", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const total = 128;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        if (pulled > total) c.close();
        else c.enqueue(chunk.slice());
      },
    });
    const req = new Request("https://occ.test/api/ledger/ingest", {
      method: "POST",
      headers: { "x-ledger-producer": "bea", "x-ledger-timestamp": String(Math.floor(Date.now() / 1000)), "x-ledger-signature": "0".repeat(64) },
      body: stream,
      duplex: "half",
    } as RequestInit);
    assert.equal(req.headers.get("content-length"), null, "chunked: no declared length");
    const letters = await deadLetters();
    const r = await post(req);
    assert.equal(r.status, 413);
    const cap = Math.ceil(ingestMod.MAX_BODY_BYTES / chunk.byteLength);
    assert.ok(pulled <= cap + 3, `read ${pulled} of ${total} chunks; the cap is ${cap}`);
    assert.equal(await deadLetters(), letters, "unauthenticated: nothing written");
  });

  await check("a producer whose secret is not configured is 503, never open", async () => {
    const r = await post(ingestRequest({ events: [received()] }, { producer: "maven", secret: "whatever-secret-0123456789abcdef00" }));
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "producer_not_configured");
  });

  await check("a valid batch writes each event once, and re-sending it writes nothing new", async () => {
    const body = { events: [received(), captured()] };
    const first = await post(ingestRequest(body));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.results?.map((r) => r.status), ["written", "written"]);
    const again = await post(ingestRequest(body));
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.results?.map((r) => r.status), ["duplicate", "duplicate"]);
    assert.equal(await ledgerCount("idempotency_key IN ('gmail:18f2a', 'email:18f2a')"), 2);
    const row = (await db.execute("SELECT * FROM outcome_events WHERE idempotency_key = 'gmail:18f2a'")).rows[0];
    assert.equal(row.tenant_id, OASIS);
    assert.equal(row.producer, "ingest:bea:scripts/integrations/email_engine.py");
    assert.equal(row.department_key, "sales");
  });

  await check("the tenant comes from the subject: a lead's own row decides, and a contradicting tenant_id is refused", async () => {
    const r = await post(ingestRequest({ events: [captured({ subject: { type: "lead", id: "lead-webdev-1" }, contact_id: "lead-webdev-1", idempotency_key: "email:wd-1" })] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = (await db.execute("SELECT tenant_id FROM outcome_events WHERE idempotency_key = 'email:wd-1'")).rows[0];
    assert.equal(row.tenant_id, WEBDEV, "no tenant_id was sent; the lead's row said oasis-webdev");
    const lie = await post(ingestRequest({ events: [captured({ tenant_id: OASIS, subject: { type: "lead", id: "lead-webdev-1" }, contact_id: "lead-webdev-1", idempotency_key: "email:wd-2" })] }));
    assert.equal(lie.status, 422);
    assert.equal(lie.body.results?.[0].error, "tenant_mismatch");
    const ghost = await post(ingestRequest({ events: [captured({ subject: { type: "lead", id: "lead-nowhere" }, contact_id: "lead-nowhere", idempotency_key: "email:wd-3" })] }));
    assert.equal(ghost.body.results?.[0].error, "subject_not_found");
    const orphan = await post(ingestRequest({ events: [received({ tenant_id: undefined, idempotency_key: "gmail:no-tenant" })] }));
    assert.equal(orphan.body.results?.[0].error, "tenant_required", "no subject row and no tenant: dead letter, never 'default to OASIS'");
    assert.equal(await ledgerCount("idempotency_key IN ('email:wd-2', 'email:wd-3', 'gmail:no-tenant')"), 0);
  });

  await check("a producer writing a workspace it may not is refused, dead-lettered and non-2xx, and the good event beside it still lands", async () => {
    const letters = await deadLetters();
    const r = await post(
      ingestRequest({
        events: [
          received({ tenant_id: CLIENT, idempotency_key: "gmail:client-1" }),
          captured({ subject: { type: "lead", id: "lead-client-1" }, contact_id: "lead-client-1", idempotency_key: "email:client-2" }),
          received({ idempotency_key: "gmail:ok-beside" }),
        ],
      }),
    );
    assert.equal(r.status, 422);
    assert.deepEqual(r.body.results?.map((x) => [x.status, x.error ?? null]), [
      ["rejected", "tenant_not_allowed"],
      ["rejected", "tenant_not_allowed"],
      ["written", null],
    ]);
    assert.equal(await ledgerCount("tenant_id = ?", [CLIENT]), 0);
    assert.equal(await deadLetters(), letters + 2);
    const dl = (await db.execute("SELECT * FROM ledger_dead_letters WHERE idempotency_key = 'gmail:client-1'")).rows[0];
    assert.equal(dl.tenant_hint, CLIENT);
    assert.equal(dl.producer, "bea");
    assert.match(String(dl.error), /^tenant_not_allowed/);
  });

  await check("a retired workspace is refused even if a producer's allowlist ever named it", async () => {
    const tenants = ingestMod.PRODUCER_TENANTS as Record<string, ReadonlySet<string>>;
    const saved = tenants.bea;
    tenants.bea = new Set([...saved, SUNBIZ]);
    try {
      const r = await post(ingestRequest({ events: [received({ tenant_id: SUNBIZ, idempotency_key: "gmail:retired-1" })] }));
      assert.equal(r.body.results?.[0].error, "tenant_retired");
    } finally {
      tenants.bea = saved;
    }
    assert.equal(await ledgerCount("tenant_id = ?", [SUNBIZ]), 0);
  });

  await check("a producer may send only the keys the catalog gives it; join keys must live in the same tenant", async () => {
    const wrongKey = await post(ingestRequest({ events: [{ ...received(), event_key: "content.published", idempotency_key: "post:x:1",
      subject: { type: "content", id: "p1" }, payload: { platform: "instagram", platform_post_id: "p1" } }] }));
    assert.equal(wrongKey.body.results?.[0].error, "producer_not_allowed_for_event");
    const crossJoin = await post(ingestRequest({ events: [received({ idempotency_key: "gmail:join-1", contact_id: "lead-client-1" })] }));
    assert.equal(crossJoin.body.results?.[0].error, "join_key_not_in_tenant");
    const crossCustomer = await post(ingestRequest({ events: [received({ idempotency_key: "gmail:join-2", customer_id: "cust-client-1" })] }));
    assert.equal(crossCustomer.body.results?.[0].error, "join_key_not_in_tenant");
    const ownCustomer = await post(ingestRequest({ events: [received({ idempotency_key: "gmail:join-3", customer_id: "cust-oasis-1" })] }));
    assert.equal(ownCustomer.status, 200, JSON.stringify(ownCustomer.body));
  });

  await check("an event carrying PII is refused, and its dead letter does not keep the address", async () => {
    const r = await post(ingestRequest({ events: [received({ idempotency_key: "gmail:pii-1",
      payload: { channel: "email", provider: "gmail", provider_message_id: "jane.doe@harbour.test", intent: "pricing_question" } })] }));
    assert.equal(r.status, 422);
    assert.equal(r.body.results?.[0].error, "payload_not_an_id");
    const dl = (await db.execute("SELECT payload_json, error FROM ledger_dead_letters WHERE idempotency_key = 'gmail:pii-1'")).rows[0];
    assert.ok(dl, "dead-lettered");
    assert.doesNotMatch(String(dl.payload_json), /harbour\.test/);
    assert.match(String(dl.payload_json), /\[redacted\]/);
  });

  await check("a dead letter keeps no phone number (as text or as a number) and no PII in a payload KEY, in any column", async () => {
    const mk = (key: string, payload: Record<string, unknown>) => received({ idempotency_key: key, payload: { channel: "sms", provider: "kixie", intent: "callback", ...payload } });
    const r = await post(
      ingestRequest({
        events: [
          mk("sms:pii-2", { provider_message_id: "514-555-0199" }),
          mk("sms:pii-3", { provider_message_id: "m3", phone: 5145550199 }),
          mk("sms:pii-4", { provider_message_id: "m4", "jane.doe@harbour.test": 1 }),
          mk("sms:pii-5", { provider_message_id: "m5", "5145550199": true }),
          mk("5145550199", { provider_message_id: "Jean.Tremblay" }),
        ],
      }),
    );
    assert.equal(r.status, 422);
    assert.deepEqual(r.body.results?.map((x) => x.error), [
      "payload_not_an_id", "payload_field_unknown", "payload_field_unknown", "payload_field_unknown", "payload_not_an_id",
    ]);
    const letters = (await db.execute(
      "SELECT idempotency_key, payload_json, error FROM ledger_dead_letters WHERE last_seen = (SELECT MAX(last_seen) FROM ledger_dead_letters)",
    )).rows;
    assert.ok(letters.length >= 5, `${letters.length} dead letters`);
    const stored = JSON.stringify(letters);
    for (const pii of [/5145550199/, /514-555-0199/, /harbour/, /Tremblay/]) assert.doesNotMatch(stored, pii);
    const byKey = new Map(letters.map((l) => [String(l.idempotency_key), l]));
    assert.equal(byKey.get("sms:pii-4")?.error, "payload_field_unknown:payload.[redacted-key]");
    assert.equal(byKey.get("sms:pii-5")?.error, "payload_field_unknown:payload.[redacted-key]");
    assert.match(String(byKey.get("sms:pii-3")?.payload_json), /"phone":"\[redacted\]"/);
    assert.equal(byKey.get("sms:pii-3")?.error, "payload_field_unknown:payload.phone", "a plain key is kept, so Operations can see what was sent");
  });

  await check("the same key re-sent with different content is refused as idempotency_key_reused; a repeat bumps attempts", async () => {
    const r = await post(ingestRequest({ events: [received({ payload: { channel: "email", provider: "gmail", provider_message_id: "18f2a", intent: "complaint" } })] }));
    assert.equal(r.status, 422);
    assert.equal(r.body.results?.[0].error, "idempotency_key_reused");
    const stored = (await db.execute("SELECT payload_json FROM outcome_events WHERE idempotency_key = 'gmail:18f2a'")).rows;
    assert.equal(stored.length, 1);
    assert.match(String(stored[0].payload_json), /pricing_question/, "the first fact stands");
    const bad = { events: [received({ idempotency_key: "gmail:pii-1",
      payload: { channel: "email", provider: "gmail", provider_message_id: "jane.doe@harbour.test", intent: "pricing_question" } })] };
    await post(ingestRequest(bad));
    const dl = (await db.execute("SELECT attempts FROM ledger_dead_letters WHERE idempotency_key = 'gmail:pii-1'")).rows;
    assert.equal(dl.length, 1, "one row per distinct refused event");
    assert.equal(Number(dl[0].attempts), 2);
  });

  await check("a re-send that moves the fact in time or re-attributes it is idempotency_key_reused, not a silent duplicate", async () => {
    // gmail:18f2a was written above, occurred 2026-09-28T14:00Z, no touch.
    for (const over of [{ occurred_at: "2025-01-01T00:00:00.000Z" }, { touch_id: "touch-other" }, { actor: { type: "agent", id: "bea" } }]) {
      const r = await post(ingestRequest({ events: [received(over)] }));
      assert.equal(r.body.results?.[0].error, "idempotency_key_reused", JSON.stringify(over));
    }
    const same = await post(ingestRequest({ events: [received({ source_ref: "retry-2", producer_ref: "scripts/other.py" })] }));
    assert.equal(same.body.results?.[0].status, "duplicate", "how it was sent is not the fact");
    const row = (await db.execute("SELECT occurred_at, touch_id FROM outcome_events WHERE idempotency_key = 'gmail:18f2a'")).rows;
    assert.deepEqual([row.length, row[0].occurred_at, row[0].touch_id], [1, "2026-09-28T14:00:00.000Z", null]);
  });

  await check("a signed body that is not {events:[1..100]} is 400 and dead-lettered", async () => {
    const letters = await deadLetters();
    assert.equal((await post(ingestRequest(null, { raw: "{not json" }))).status, 400);
    assert.equal((await post(ingestRequest({ events: [] }))).status, 400);
    assert.equal((await post(ingestRequest({ events: Array.from({ length: 101 }, () => received()) }))).status, 400);
    assert.equal(await deadLetters(), letters + 3);
  });

  // ── 8. Reads, two tenants ────────────────────────────────────────────────
  console.log("read");
  await check("read.ts: countByKey, latestFor and coverage see one tenant only", async () => {
    // lead.qualified: a key no other check in this file writes.
    const at = (iso: string, t: string, key: string, lead: string) =>
      emit(base({ tenantId: t, eventKey: "lead.qualified", occurredAt: iso, idempotencyKey: key,
        subject: { type: "lead", id: lead }, contactId: lead, payload: { reason: "budget_confirmed", attempt: 1 } }));
    await db.batch(
      [
        at("2026-09-27T09:00:00.000Z", OASIS, "form:r-1", "lead-r-a"),
        at("2026-09-29T08:00:00.000Z", OASIS, "form:r-2", "lead-r-a"),
        at("2026-09-29T09:30:00.000Z", OASIS, "form:r-3", "lead-r-b"),
        at("2026-09-28T10:00:00.000Z", CLIENT, "form:r-4", "lead-r-a"),
        at("2026-09-29T11:00:00.000Z", CLIENT, "form:r-5", "lead-r-a"),
      ],
      "write",
    );
    const from = "2026-09-27T00:00:00.000Z";
    const to = "2026-09-30T00:00:00.000Z";
    const Q = "lead.qualified";
    assert.equal(await read.countByKey(db, OASIS, Q, from, to), 3);
    assert.equal(await read.countByKey(db, CLIENT, Q, from, to), 2);
    assert.equal(await read.countByKey(db, WEBDEV, Q, from, to), 0);
    assert.equal(await read.countByKey(db, OASIS, Q, "2026-09-29T08:00:00.000Z", "2026-09-29T09:30:00.000Z"), 1, "[from, to)");
    const latest = await read.latestFor(db, OASIS, { type: "lead", id: "lead-r-a" });
    assert.equal(latest?.idempotency_key, "form:r-2", "OASIS's newest, not CLIENT's later row");
    assert.equal(latest?.tenant_id, OASIS);
    assert.deepEqual(latest?.payload, { attempt: 1, reason: "budget_confirmed" });
    assert.equal(await read.latestFor(db, OASIS, { type: "lead", id: "lead-r-a" }, "deal.won"), null);
    assert.equal(await read.latestFor(db, WEBDEV, { type: "lead", id: "lead-r-a" }), null);
    const cov = await read.coverage(db, OASIS, [Q, "meeting.booked"], 3, new Date("2026-09-29T12:00:00.000Z"));
    assert.deepEqual(cov.days, ["2026-09-27", "2026-09-28", "2026-09-29"]);
    assert.deepEqual(cov.byKey[Q].perDay, [1, 0, 2], "CLIENT's 09-28 row is not OASIS coverage");
    assert.equal(cov.byKey[Q].daysWithEvents, 2);
    assert.equal(cov.byKey[Q].trailingStreak, 1);
    assert.deepEqual(cov.byKey["meeting.booked"].perDay, [0, 0, 0], "a key with no events is zeros, not missing");
    const clientCov = await read.coverage(db, CLIENT, [Q], 3, new Date("2026-09-29T12:00:00.000Z"));
    assert.deepEqual(clientCov.byKey[Q].perDay, [0, 1, 1]);
    assert.equal(clientCov.byKey[Q].trailingStreak, 2);
    await assert.rejects(read.countByKey(db, "", Q, from, to), /tenant id is required/);
    await assert.rejects(read.coverage(db, " ", [Q], 3), /tenant id is required/);
  });

  // ── 9. The proving wire: approvals mirror ────────────────────────────────
  console.log("approvals mirror");
  const scope = { tenantId: OASIS, userId: CC_USER, persona: "founder" as const, canAct: true, allDepartments: true, departments: [] };
  const NOW = new Date("2026-09-29T15:00:00.000Z");
  const newApproval = async (over: Record<string, unknown> = {}) => {
    const r = await store.createApproval(
      db,
      {
        tenantId: OASIS,
        departmentKey: "sales",
        requestedBy: { type: "agent", id: "sdr" },
        actionKind: "send_email",
        title: "Reply to Lee",
        payload: { to: "lee@harbour.test", subject: "Your quote", body: "Here it is, Lee." },
        ...over,
      },
      NOW,
    );
    assert.ok(r.ok, JSON.stringify(r));
    return r.approval;
  };
  const mirror = async (approvalId: string) =>
    (await db.execute({ sql: "SELECT * FROM outcome_events WHERE tenant_id = ? AND approval_id = ? ORDER BY id", args: [OASIS, approvalId] })).rows;

  await check("create: approval.requested lands in the same batch, keyed to the approval_events row, ids and codes only", async () => {
    const a = await newApproval({ idempotencyKey: "reply-lee-1" });
    const rows = await mirror(a.id);
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.event_key, "approval.requested");
    assert.equal(r.subject_type, "approval");
    assert.equal(r.subject_id, a.id);
    assert.equal(r.department_key, "sales");
    assert.equal(r.actor_type, "agent");
    assert.equal(r.actor_id, "sdr");
    assert.equal(r.producer, "lib/os/approvals/store.ts");
    const ev = (await db.execute({ sql: "SELECT id FROM approval_events WHERE approval_id = ? AND event = 'created'", args: [a.id] })).rows[0];
    assert.equal(r.idempotency_key, `appr:${String(ev.id)}`);
    assert.equal(r.causation_id, ev.id);
    assert.deepEqual(JSON.parse(String(r.payload_json)), { action_kind: "send_email", requested_by_type: "agent", revision: 1, risk_level: "outbound" });
    assert.doesNotMatch(String(r.payload_json), /harbour|Lee/);
    // A retried create (same key, same words) makes no second approval and no second ledger row.
    await newApproval({ idempotencyKey: "reply-lee-1" });
    assert.equal((await mirror(a.id)).length, 1);
  });

  await check("approve: one approval.approved row, and none from the call that lost the compare-and-swap", async () => {
    const a = await newApproval();
    let hook: (() => Promise<void>) | null = null;
    // A client that lets the first decision finish in the gap between the
    // second one's read and its batch: the second read "pending" and loses.
    const racing = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return async (...args: Parameters<Client["batch"]>) => {
            const h = hook;
            hook = null;
            if (h) await h();
            return target.batch(...args);
          };
        }
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    }) as Client;
    hook = async () => {
      const first = await store.decideApproval(db, scope, a.id, { kind: "approve", payloadHash: a.payload_hash }, NOW);
      assert.ok(first.ok, "the first decision wins");
    };
    const second = await store.decideApproval(racing, scope, a.id, { kind: "approve", payloadHash: a.payload_hash }, NOW);
    assert.equal(second.ok, false);
    assert.equal(!second.ok && second.error, "not_pending");
    const approved = (await mirror(a.id)).filter((r) => r.event_key === "approval.approved");
    assert.equal(approved.length, 1, "the losing CAS wrote no ledger row");
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM approval_events WHERE approval_id = ? AND event = 'approved'", [a.id]), 1);
    assert.equal(approved[0].actor_type, "human");
    assert.equal(approved[0].actor_id, CC_USER);
    assert.deepEqual(JSON.parse(String(approved[0].payload_json)), { action_kind: "send_email", decided_via: "app" });

    // Execute: claim (not mirrored) then finish; the provider's message id and
    // sender address stay out of the ledger.
    assert.ok(await store.claimForExecution(db, OASIS, a.id, NOW));
    await store.finishExecution(db, OASIS, a.id, { status: "executed", result: { outcome: "sent", provider: "oasis_mailbox", message_id: "<m1@oasisai.work>", from: "cc@oasisai.work" } }, NOW, a);
    const executed = (await mirror(a.id)).filter((r) => r.event_key === "approval.executed");
    assert.equal(executed.length, 1);
    assert.deepEqual(JSON.parse(String(executed[0].payload_json)), { action_kind: "send_email", outcome: "sent", provider: "oasis_mailbox" });
    assert.equal(executed[0].actor_type, "system");
  });

  await check("send back, revise, fail and expire are mirrored; the note never reaches the ledger", async () => {
    const a = await newApproval();
    const sb = await store.decideApproval(db, scope, a.id, { kind: "send_back", note: "Too pushy. Mention jane@harbour.test instead." }, NOW);
    assert.ok(sb.ok);
    const sent = (await mirror(a.id)).find((r) => r.event_key === "approval.sent_back");
    assert.ok(sent);
    assert.doesNotMatch(String(sent.payload_json), /pushy|harbour/);
    const b = await newApproval({ supersedesId: a.id, payload: { to: "lee@harbour.test", subject: "Your quote", body: "Softer." } });
    const edited = (await mirror(b.id)).find((r) => r.event_key === "approval.edited");
    assert.ok(edited, "a revision is approval.edited");
    assert.deepEqual(JSON.parse(String(edited.payload_json)), { action_kind: "send_email", revision: 2, risk_level: "outbound", supersedes_id: a.id });

    const ok = await store.decideApproval(db, scope, b.id, { kind: "approve", payloadHash: b.payload_hash }, NOW);
    assert.ok(ok.ok);
    assert.ok(await store.claimForExecution(db, OASIS, b.id, NOW));
    await store.finishExecution(db, OASIS, b.id, { status: "failed", result: { outcome: "failed", reason: "read_failed", message: "The draft for Lee could not be read." } }, NOW, b);
    const failed = (await mirror(b.id)).find((r) => r.event_key === "approval.failed");
    assert.deepEqual(JSON.parse(String(failed?.payload_json)), { action_kind: "send_email", reason: "read_failed" });

    const c = await newApproval({ expiresAt: "2026-10-01T00:00:00.000Z" });
    assert.ok(await store.expireApproval(db, OASIS, c.id, new Date("2026-10-02T00:00:00.000Z")));
    assert.equal((await mirror(c.id)).filter((r) => r.event_key === "approval.expired").length, 1);
    assert.equal(await store.expireApproval(db, OASIS, c.id, new Date("2026-10-03T00:00:00.000Z")), false);
    assert.equal((await mirror(c.id)).filter((r) => r.event_key === "approval.expired").length, 1, "a second expire writes nothing");
  });

  await check("a failed ledger insert rolls the approval write back", async () => {
    await db.execute("CREATE TRIGGER test_fail_ledger BEFORE INSERT ON outcome_events BEGIN SELECT RAISE(ABORT, 'forced ledger failure'); END");
    try {
      await assert.rejects(newApproval({ idempotencyKey: "fault-1" }), /forced ledger failure/);
      assert.equal(await count(db, "SELECT COUNT(*) AS n FROM approvals WHERE idempotency_key = 'fault-1'"), 0, "no approval without its ledger row");
    } finally {
      await db.execute("DROP TRIGGER IF EXISTS test_fail_ledger");
    }
    const a = await newApproval({ idempotencyKey: "fault-2" });
    await db.execute("CREATE TRIGGER test_fail_ledger BEFORE INSERT ON outcome_events BEGIN SELECT RAISE(ABORT, 'forced ledger failure'); END");
    try {
      await assert.rejects(store.decideApproval(db, scope, a.id, { kind: "approve", payloadHash: a.payload_hash }, NOW), /forced ledger failure/);
    } finally {
      await db.execute("DROP TRIGGER IF EXISTS test_fail_ledger");
    }
    const after = await store.getApprovalInTenant(db, OASIS, a.id);
    assert.equal(after?.status, "pending", "the decision rolled back with its ledger row");
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM approval_events WHERE approval_id = ? AND event = 'approved'", [a.id]), 0);
  });

  await check("execute: a ledger that cannot record the outcome refuses BEFORE the claim; nothing is sent and the row stays approved", async () => {
    const { executeApproval } = await import("../lib/os/approvals/execute");
    type ExecutorDeps = import("../lib/os/approvals/executors").ExecutorDeps;
    const sent: unknown[] = [];
    const deps: ExecutorDeps = {
      isDryRun: () => false,
      sendEmail: async (args) => {
        sent.push(args);
        return { ok: true, provider: "oasis_shared_gmail", gmail_message_id: "<m-ready@oasisai.work>", from_address: "team@oasisai.work" };
      },
      emailSuppression: async () => ({ suppressed: false, checkFailed: false }),
      marketingDb: () => {
        throw new Error("not used by send_email");
      },
      marketingSql: () => db,
      foundersTenantIds: () => [OASIS],
      signerFor: () => null,
      publishEvent: async () => {},
    };
    // An approval approved before bravo__190 was applied, executed against a
    // database that still lacks it: every statement naming outcome_events
    // fails there exactly as it would in production.
    const missing = () => new Error("SQLITE_ERROR: no such table: outcome_events");
    const names = (s: unknown) => /\boutcome_events\b/.test(typeof s === "string" ? s : String((s as { sql?: unknown }).sql ?? ""));
    const unmigrated = new Proxy(db, {
      get(target, prop) {
        if (prop === "execute") {
          return async (s: Parameters<Client["execute"]>[0]) => {
            if (names(s)) throw missing();
            return target.execute(s);
          };
        }
        if (prop === "batch") {
          return async (stmts: Parameters<Client["batch"]>[0], mode?: Parameters<Client["batch"]>[1]) => {
            if (stmts.some(names)) throw missing();
            return target.batch(stmts, mode);
          };
        }
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    }) as Client;
    const a = await newApproval({ idempotencyKey: "ready-1" });
    assert.ok((await store.decideApproval(db, scope, a.id, { kind: "approve", payloadHash: a.payload_hash }, NOW)).ok);

    await assert.rejects(executeApproval(unmigrated, { tenantId: OASIS, approvalId: a.id }, deps), /no such table: outcome_events/);
    assert.equal(sent.length, 0, "nothing left the business");
    assert.equal((await store.getApprovalInTenant(db, OASIS, a.id))?.status, "approved", "still approved: pressing again once the migration is in runs it");

    const done = await executeApproval(db, { tenantId: OASIS, approvalId: a.id }, deps);
    assert.ok(done.ok);
    assert.equal(done.approval.status, "executed");
    assert.equal(sent.length, 1);
    const executed = (await mirror(a.id)).filter((r) => r.event_key === "approval.executed");
    assert.deepEqual(JSON.parse(String(executed[0]?.payload_json)), { action_kind: "send_email", outcome: "sent", provider: "oasis_shared_gmail" });
  });

  console.log(`ledger-core: ${passed} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
