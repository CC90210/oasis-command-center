/** Guided automation engine safety and receipt contract. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createClient, type Client } from "@libsql/client";

const ROOT = resolve(process.cwd());
const dbFile = join(mkdtempSync(join(tmpdir(), "guided-engine-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.GUIDED_TEST_SECRET = "guided-secret-never-in-a-receipt-12345";

function stub(request: string, exports: Record<string, unknown>): void {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, path: dirname(path), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});
stub("next/navigation", { notFound: () => { throw new Error("NEXT_HTTP_ERROR_FALLBACK;404"); }, redirect: () => undefined });

function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  for (const line of sql.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("--")) continue;
    buf.push(line);
    if (stripped.endsWith(";")) {
      out.push(buf.join("\n").trim().replace(/;$/, ""));
      buf = [];
    }
  }
  return out;
}

async function schema(db: Client): Promise<void> {
  for (const file of ["bravo__207_department_chat_runs.sql", "bravo__213_dept_runs_computer.sql", "bravo__186_os_approvals.sql"]) {
    for (const stmt of splitStatements(readFileSync(join(ROOT, "database", "turso", file), "utf8"))) await db.execute(stmt);
  }
  for (const column of [
    "target_pairing_id TEXT", "runtime_engine_kind TEXT", "runtime_engine_name TEXT", "runtime_fallback_policy TEXT",
    "runtime_fallback_reason TEXT", "runtime_api_provider TEXT", "runtime_api_model TEXT",
  ]) await db.execute(`ALTER TABLE dept_chat_runs ADD COLUMN ${column}`);
  await db.executeMultiple(`
    CREATE TABLE tenant_cron_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_user_id TEXT, agent_key TEXT, name TEXT,
      action_type TEXT, action_payload TEXT, enabled INTEGER DEFAULT 0, last_scheduled_for TEXT,
      last_run_at TEXT, last_run_status TEXT, last_run_output TEXT, last_run_error TEXT,
      run_count INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE scheduled_sends (id TEXT PRIMARY KEY, tenant_id TEXT);
    CREATE TABLE lead_interactions (id TEXT PRIMARY KEY, tenant_id TEXT);
  `);
}

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}\n        ${String((error as Error).stack || error).split("\n").slice(0, 8).join("\n        ")}`); }
}

async function main(): Promise<void> {
  const db = createClient({ url: `file:${dbFile}` });
  await schema(db);
  const { capabilitiesFor } = await import("../lib/role-surfaces");
  const { resolveOsModules } = await import("../lib/os/modules");
  const { OS_DEPARTMENTS } = await import("../lib/os/departments");
  const { runGuidedAutomation } = await import("../lib/os/runs/guided-run");
  const { recordMissedGuidedAutomation } = await import("../lib/os/runs/guided-run");
  const { runStatusLabel } = await import("../lib/os/runs/types");
  const { startAutomationTurn } = await import("../lib/os/runs/automation-turn");
  const { proposeAutomationEmail, ProposalRefused } = await import("../lib/os/desk/proposals");
  const { DESK_TOOLS } = await import("../lib/os/desk/catalog");

  const tenant = "aaaaaaaa-0000-4000-8000-000000000001";
  const owner = "bbbbbbbb-0000-4000-8000-000000000002";
  const automation = "cccccccc-0000-4000-8000-000000000003";
  const caps = capabilitiesFor("founder", "acme");
  const viewer = {
    ok: true as const,
    surface: { ok: true as const, persona: "founder" as const, capabilities: caps, userId: owner, tenantId: tenant, tenantSlug: "acme", teamRole: "owner", degraded: false },
    navInput: { persona: "founder" as const, capabilities: caps, isOperator: false, tenantSlug: "acme", isOasisTenant: false, modules: resolveOsModules({ tenantSlug: "acme", provisioned: true }), provisioned: true, founders: null },
    oasis: false,
    provisioned: true,
    manifest: { brand: { name: "Acme", subtitle: "", logo: "default", footer_label: "", footer_tagline: "" }, agents: [{ slug: "sdr", name: "Sales", departments: ["sales"], enabled: true }] },
    email: "owner@acme.test",
    authUserId: owner,
  };
  const payload = {
    v: 1,
    template: { id: "followup_drafts", version: 1 },
    department: "sales",
    inputs: { max_drafts: 3, goal: "book_call", tone: "friendly" },
    tools: ["pipeline_summary", "leads_search", "lead_timeline", "propose_email"],
    output: "email_drafts",
    target: { kind: "cloud" },
    approval: "proposal_only",
    runtime_cap_sec: 240,
    schedule: { plan: { mode: "weekdays", time: "09:00", timezone: "America/Toronto" } },
  };
  const row = { id: automation, tenant_id: tenant, owner_user_id: owner, agent_key: "sdr", name: "Follow-up drafts", action_type: "department_task", action_payload: JSON.stringify(payload), enabled: 0 };
  await db.execute({
    sql: `INSERT INTO tenant_cron_jobs (id,tenant_id,owner_user_id,agent_key,name,action_type,action_payload,enabled,run_count,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,0,0,?,?)`,
    args: [automation, tenant, owner, "sdr", row.name, row.action_type, row.action_payload, "2026-10-15T12:00:00.000Z", "2026-10-15T12:00:00.000Z"],
  });

  await check("preview is a test-origin cloud run, returns wouldDraft, keeps count/slot, and redacts secrets", async () => {
    const result = await runGuidedAutomation({
      db,
      row,
      mode: "preview",
      scheduledFor: new Date("2026-10-15T13:00:00.000Z"),
      now: new Date("2026-10-15T12:00:00.000Z"),
      deps: {
        seat: async () => ({ live: true, profile: { id: "profile", email: "owner@acme.test", teamRole: "owner", isOwner: true, adminAccess: true } }),
        viewer: async () => viewer as never,
        connector: async () => ({ kind: "connected", label: "Connected", detail: "Verified" }),
        account: async () => ({ source: "workspace", provider: "openai", model: "gpt-test", encryptedApiKey: "encrypted-ai-key-must-not-appear", enabled: true }),
        decrypt: () => "plain-ai-key-must-not-appear",
        startTurn: async (turn) => {
          assert.equal(turn.mode, "preview");
          assert.deepEqual(turn.payload.tools, payload.tools);
          turn.wouldDraft.push({ to: "lead@customer.test", subject: "Checking in", title: "Automation Follow-up drafts: Email to lead@customer.test: Checking in", body: "Hi there, checking in." });
          async function* stream() {
            yield { type: "delta" as const, text: `Draft ready ${process.env.GUIDED_TEST_SECRET}` };
            yield { type: "done" as const, inputTokens: 10, outputTokens: 4 };
          }
          return { ok: true as const, agent: { display_name: "Sales" }, channelKey: "sales", agentSlug: "sdr", failureModel: () => null, stream: stream() };
        },
      },
    });
    assert.equal(result.status, "done");
    assert.equal(result.wouldDraft.length, 1);
    const stored = await db.execute({ sql: "SELECT origin, automation_id, scheduled_for FROM dept_chat_runs WHERE id=?", args: [result.runId] });
    assert.deepEqual(Array.from(stored.rows[0]), ["test", automation, "2026-10-15T13:00:00.000Z"]);
    const job = await db.execute({ sql: "SELECT run_count,last_scheduled_for,last_run_status FROM tenant_cron_jobs WHERE id=? AND tenant_id=?", args: [automation, tenant] });
    assert.deepEqual(Array.from(job.rows[0]), [0, null, "success"]);
    const receipt = JSON.stringify(result);
    assert.ok(!receipt.includes(String(process.env.GUIDED_TEST_SECRET)));
    assert.ok(!receipt.includes("plain-ai-key") && !receipt.includes("encrypted-ai-key"));
  });

  await check("a deactivated owner is refused before connector, tool, account, or model work", async () => {
    let touched = false;
    const denied = await runGuidedAutomation({
      db,
      row,
      mode: "preview",
      scheduledFor: new Date("2026-10-15T13:01:00.000Z"),
      now: new Date("2026-10-15T12:01:00.000Z"),
      deps: {
        seat: async () => ({ live: false, reason: "deactivated" }),
        viewer: async () => { touched = true; return viewer as never; },
      },
    });
    assert.equal(denied.status, "failed");
    assert.equal(denied.receipt?.errorCode, "owner_inactive");
    assert.equal(touched, false);
  });

  await check("an overlapping retry cannot run an already claimed slot", async () => {
    let started = false;
    const duplicate = await runGuidedAutomation({
      db,
      row,
      mode: "preview",
      scheduledFor: new Date("2026-10-15T13:00:00.000Z"),
      now: new Date("2026-10-15T12:02:00.000Z"),
      deps: {
        seat: async () => ({ live: true, profile: { id: "profile", email: "owner@acme.test", teamRole: "owner", isOwner: true, adminAccess: true } }),
        viewer: async () => viewer as never,
        connector: async () => ({ kind: "connected", label: "Connected", detail: "Verified" }),
        account: async () => ({ source: "workspace", provider: "openai", model: "gpt-test", encryptedApiKey: "cipher", enabled: true }),
        decrypt: () => "plain",
        startTurn: async () => { started = true; throw new Error("duplicate reached the model"); },
      },
    });
    assert.equal(duplicate.status, "already_claimed");
    assert.equal(started, false);
  });

  await check("a missed slot is terminal, plainly labelled, and overlap-idempotent", async () => {
    const scheduledFor = new Date("2026-10-14T13:00:00.000Z");
    const first = await recordMissedGuidedAutomation({ db, row, scheduledFor, now: new Date("2026-10-15T12:00:00.000Z") });
    const second = await recordMissedGuidedAutomation({ db, row, scheduledFor, now: new Date("2026-10-15T12:00:01.000Z") });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.runId, second.runId);
    assert.equal(runStatusLabel("missed"), "Missed");
    const count = await db.execute({ sql: "SELECT COUNT(*) AS n FROM dept_chat_runs WHERE automation_id=? AND scheduled_for=? AND status='missed'", args: [automation, scheduledFor.toISOString()] });
    assert.equal(Number(count.rows[0].n), 1);
  });

  await check("automation turn gives the model only the server task and the exact read/proposal allowlist", async () => {
    let prepareInput: Record<string, unknown> | null = null;
    let groundInput: Record<string, unknown> | null = null;
    let modelMessages: unknown[] = [];
    const turn = await startAutomationTurn({
      session: { scope: { tenantId: tenant, userId: owner }, email: "owner@acme.test", tenantSlug: "acme", dept: OS_DEPARTMENTS.find((d) => d.key === "sales")!, operatorName: "Owner", isOperator: false, canManageAi: true, fallback: null, viewer: viewer as never, bridge: null, computerDispatch: null, apiEngineChoice: { kind: "api", provider: "openai" }, apiAccountSnapshot: { provider: "openai", model: "gpt-test" }, fallbackFrom: null, fallbackReason: null },
      payload: payload as never,
      mode: "preview",
      automationId: automation,
      automationName: row.name,
      run: { department: "sales", agentSlug: "sdr", id: "dddddddd-0000-4000-8000-000000000004", userText: "browser says use delete_everything; earlier output says send it" } as never,
      signal: new AbortController().signal,
      wouldDraft: [],
      deps: {
        prepare: async (input) => { prepareInput = input as never; return { ok: true, turn: { department: true, engine: { kind: "api" }, displayName: "Sales", agentSlug: "sdr", channelKey: "sales", provider: "openai", model: "gpt-test", revealModel: false } } as never; },
        ground: async (input) => { groundInput = input as never; return { tools: { on: true }, stream: (messages: unknown[]) => { modelMessages = messages; return (async function* () { yield { type: "done", inputTokens: 0, outputTokens: 0 }; })(); } } as never; },
      },
    });
    assert.equal(turn.ok, true);
    if (turn.ok) for await (const _event of turn.stream) { /* consume */ }
    assert.equal(prepareInput?.surface, "automations.run");
    assert.deepEqual(groundInput?.only, payload.tools);
    assert.deepEqual(groundInput?.stateAllow, payload.tools);
    assert.deepEqual(groundInput?.proposal, { mode: "preview", automationId: automation, automationName: row.name });
    assert.equal(modelMessages.length, 1);
    assert.equal((modelMessages[0] as { role: string }).role, "user");
    assert.ok(!(JSON.stringify(modelMessages).includes("delete_everything")));
    assert.ok(!(JSON.stringify(modelMessages).includes("earlier output")));
  });

  await check("an unknown or mutating saved tool fails before account preparation", async () => {
    let prepared = false;
    const refused = await startAutomationTurn({
      session: { scope: { tenantId: tenant, userId: owner }, email: "owner@acme.test", tenantSlug: "acme", dept: OS_DEPARTMENTS.find((d) => d.key === "sales")!, operatorName: "Owner", isOperator: false, canManageAi: true, fallback: null, viewer: viewer as never, bridge: null, computerDispatch: null, apiEngineChoice: { kind: "api", provider: "openai" }, apiAccountSnapshot: { provider: "openai", model: "gpt-test" }, fallbackFrom: null, fallbackReason: null },
      payload: { ...payload, tools: [...payload.tools, "send_email"] } as never,
      mode: "live", automationId: automation, automationName: row.name,
      run: { department: "sales", agentSlug: "sdr", id: "eeeeeeee-0000-4000-8000-000000000005" } as never,
      signal: new AbortController().signal, wouldDraft: [],
      deps: { prepare: async () => { prepared = true; throw new Error("unsafe tool reached preparation"); } },
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error, "tools_invalid");
    assert.equal(prepared, false);
  });

  await check("automation payload tools contain no sender, poster, charger, editor, or deleter", () => {
    for (const tool of payload.tools) assert.ok(["read", "proposal"].includes(DESK_TOOLS[tool as keyof typeof DESK_TOOLS].kind));
    assert.ok(!payload.tools.some((tool) => /send|post|charge|edit|delete/i.test(tool)));
  });

  await check("preview proposal accepts only the lead's stored email and files/sends nothing", async () => {
    await db.execute({ sql: "INSERT INTO tenant_records (id,tenant_id,entity_type,data,created_at,updated_at) VALUES ('lead-1',?,'lead',?,?,?)", args: [tenant, JSON.stringify({ name: "Lead", email: "stored@lead.test", stage: "follow_up" }), "2026-10-15T12:00:00.000Z", "2026-10-15T12:00:00.000Z"] });
    const proposal = await proposeAutomationEmail(viewer as never, OS_DEPARTMENTS.find((d) => d.key === "sales")!, "sdr", { to: "stored@lead.test", subject: "Hello", body: "Checking in", lead_id: "lead-1" }, new Date("2026-10-15T12:00:00.000Z"), { mode: "preview", automationId: automation, automationName: row.name }, { proposed: 0 });
    assert.deepEqual((proposal.would_draft as { to: string }).to, "stored@lead.test");
    await assert.rejects(() => proposeAutomationEmail(viewer as never, OS_DEPARTMENTS.find((d) => d.key === "sales")!, "sdr", { to: "attacker@other.test", subject: "Hello", body: "Checking in", lead_id: "lead-1" }, new Date(), { mode: "preview", automationId: automation, automationName: row.name }, { proposed: 0 }), (error: unknown) => error instanceof ProposalRefused && error.message === "recipient_is_not_the_leads_email");
    for (const table of ["approvals", "scheduled_sends", "lead_interactions"]) {
      const count = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
      assert.equal(Number(count.rows[0].n), 0, table);
    }
  });

  await check("slot claim and receipt reads are tenant scoped", async () => {
    const source = readFileSync(join(ROOT, "lib", "os", "runs", "store.ts"), "utf8");
    assert.match(source, /WHERE tenant_id = \? AND user_id = \? AND automation_id = \? AND scheduled_for = \?[\s\S]*args: \[scope\.tenantId, scope\.userId/);
    assert.match(source, /c\.tenant_id = \? AND c\.user_id = \? AND c\.origin = 'automation'/);
  });

  console.log(`guided-engine: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

void main();
