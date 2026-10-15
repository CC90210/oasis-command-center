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
  const { GuidedPreflightUnavailable, plainFailure } = await import("../lib/os/runs/guided-run");
  const { foreignContactDetail } = await import("../lib/os/desk/proposals");

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


  // ── the review's fixes ────────────────────────────────────────────────────
  const seatOf = (over: Record<string, unknown> = {}) => async () => ({ live: true as const, profile: { id: "profile", email: "owner@acme.test", teamRole: "owner", isOwner: true, adminAccess: true, ...over } });
  const goodDeps = (over: Record<string, unknown> = {}) => ({
    seat: seatOf(),
    viewer: async () => viewer as never,
    connector: async () => ({ kind: "connected", label: "Connected", detail: "Verified" }),
    account: async () => ({ source: "workspace", provider: "openai", model: "gpt-test", encryptedApiKey: "cipher", enabled: true }),
    decrypt: () => "plain",
    ...over,
  });
  const runCount = async () => Number((await db.execute("SELECT COUNT(*) AS n FROM dept_chat_runs")).rows[0].n);
  const okTurn = (text = "Done.") => async () => {
    async function* stream() {
      yield { type: "delta" as const, text };
      yield { type: "done" as const, inputTokens: 1, outputTokens: 1 };
    }
    return { ok: true as const, agent: { display_name: "Sales" }, channelKey: "sales", agentSlug: "sdr", failureModel: () => null, stream: stream() };
  };

  await check("an owner who is no longer an owner or admin is refused before connectors, tools, account or model", async () => {
    let touched = false;
    const before = await runCount();
    const denied = await runGuidedAutomation({
      db, row, mode: "preview", scheduledFor: new Date("2026-10-15T14:00:00.000Z"), now: new Date("2026-10-15T14:00:00.000Z"),
      deps: goodDeps({
        seat: seatOf({ teamRole: "member", isOwner: false, adminAccess: false }),
        viewer: async () => { touched = true; return viewer as never; },
      }) as never,
    });
    assert.equal(denied.status, "failed");
    assert.equal(denied.receipt?.errorCode, "owner_not_manager");
    assert.equal(touched, false);
    assert.equal(await runCount(), before + 1, "one terminal receipt, nothing queued");
    assert.match(plainFailure("owner_not_manager"), /no longer manages the workspace/);
    // An admin grant is enough, as it is to build one.
    const granted = await runGuidedAutomation({
      db, row, mode: "preview", scheduledFor: new Date("2026-10-15T14:01:00.000Z"), now: new Date("2026-10-15T14:01:00.000Z"),
      deps: goodDeps({ seat: seatOf({ teamRole: "member", isOwner: false, adminAccess: true }), startTurn: okTurn() }) as never,
    });
    assert.equal(granted.status, "done");
  });

  await check("a failed READ (seat, connector, AI account) throws and records nothing: it is a retry, not a verdict on the automation", async () => {
    const before = await runCount();
    const at = (n: number) => new Date(`2026-10-15T15:0${n}:00.000Z`);
    const attempt = (n: number, over: Record<string, unknown>) =>
      runGuidedAutomation({ db, row, mode: "preview", scheduledFor: at(n), now: at(n), deps: goodDeps(over) as never });
    await assert.rejects(() => attempt(0, { seat: async () => ({ live: false, reason: "unavailable" }) }), GuidedPreflightUnavailable);
    await assert.rejects(() => attempt(1, { seat: async () => { throw new Error("db down"); } }), GuidedPreflightUnavailable);
    await assert.rejects(() => attempt(2, { connector: async () => { throw new Error("timeout"); } }), GuidedPreflightUnavailable);
    await assert.rejects(() => attempt(3, { account: async () => { throw new Error("timeout"); } }), GuidedPreflightUnavailable);
    assert.equal(await runCount(), before, "no failed run was written, so no slot was burned");
    // A decision, by contrast, is recorded: deactivated, or an account with no usable key.
    const gone = await attempt(4, { seat: async () => ({ live: false, reason: "deactivated" }) });
    assert.equal(gone.receipt?.errorCode, "owner_inactive");
    const noKey = await attempt(5, { account: async () => null });
    assert.equal(noKey.receipt?.errorCode, "ai_account_unavailable");
  });

  await check("a run that cannot be claimed because another is going fails as 'busy' at once; it does not stay queued, and the running one is not reaped", async () => {
    const slotA = new Date("2026-10-15T16:00:00.000Z");
    const slotB = new Date("2026-10-15T16:01:00.000Z");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = runGuidedAutomation({
      db, row, mode: "live", scheduledFor: slotA, now: slotA,
      deps: goodDeps({
        startTurn: async () => {
          async function* stream() {
            await gate;
            yield { type: "delta" as const, text: "First finished." };
            yield { type: "done" as const, inputTokens: 1, outputTokens: 1 };
          }
          return { ok: true as const, agent: { display_name: "Sales" }, channelKey: "sales", agentSlug: "sdr", failureModel: () => null, stream: stream() };
        },
      }) as never,
    });
    for (let i = 0; i < 100; i += 1) {
      const live = await db.execute({ sql: "SELECT status FROM dept_chat_runs WHERE automation_id = ? AND scheduled_for = ?", args: [automation, slotA.toISOString()] });
      if (live.rows[0]?.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    let secondStarted = false;
    const second = await runGuidedAutomation({
      db, row, mode: "preview", scheduledFor: slotB, now: slotB,
      deps: goodDeps({ startTurn: async () => { secondStarted = true; throw new Error("should not start"); } }) as never,
    });
    assert.equal(secondStarted, false);
    assert.equal(second.status, "failed");
    assert.equal(second.receipt?.errorCode, "automation_busy");
    const queued = await db.execute({ sql: "SELECT COUNT(*) AS n FROM dept_chat_runs WHERE automation_id = ? AND status = 'queued'", args: [automation] });
    assert.equal(Number(queued.rows[0].n), 0, "nothing is left queued");
    const stillRunning = await db.execute({ sql: "SELECT status FROM dept_chat_runs WHERE automation_id = ? AND scheduled_for = ?", args: [automation, slotA.toISOString()] });
    assert.equal(stillRunning.rows[0].status, "running", "the live run was not reaped as stale by the other's clock");
    release();
    const finished = await first;
    assert.equal(finished.status, "done");
    assert.match(plainFailure("automation_busy"), /earlier run/);
  });

  await check("a run's own clock is the wall clock, not the tick's start: its deadline and heartbeat are fresh", async () => {
    const tickStart = new Date("2026-10-15T09:00:00.000Z");
    const slot = new Date("2026-10-15T17:00:00.000Z");
    const result = await runGuidedAutomation({
      db, row, mode: "live", scheduledFor: slot, now: tickStart,
      deps: goodDeps({ startTurn: okTurn("Fresh.") }) as never,
    });
    assert.equal(result.status, "done", "a deadline counted from a stale tick start would have timed out at once");
    const stored = await db.execute({ sql: "SELECT created_at, deadline_at FROM dept_chat_runs WHERE id = ?", args: [result.runId] });
    const created = Date.parse(String(stored.rows[0].created_at));
    assert.ok(Math.abs(created - Date.now()) < 60_000, "queued at the real time");
    assert.ok(Date.parse(String(stored.rows[0].deadline_at)) > Date.now(), "and its deadline is still ahead");
  });

  await check("a 'missed' note never sits beside a real run of the same slot", async () => {
    const slot = new Date("2026-10-15T18:00:00.000Z");
    const live = await runGuidedAutomation({ db, row, mode: "live", scheduledFor: slot, now: slot, deps: goodDeps({ startTurn: okTurn("Ran.") }) as never });
    assert.equal(live.status, "done");
    const noted = await recordMissedGuidedAutomation({ db, row, scheduledFor: slot, now: new Date("2026-10-15T18:40:00.000Z") });
    assert.equal(noted.created, false);
    assert.equal(noted.runId, live.runId, "the real run is the record");
    const rows = await db.execute({ sql: "SELECT status FROM dept_chat_runs WHERE automation_id = ? AND scheduled_for = ?", args: [automation, slot.toISOString()] });
    assert.deepEqual(rows.rows.map((r) => r.status), ["done"]);
    // And the other way round: a missed note first still lets the slot be recorded once.
    const later = new Date("2026-10-15T19:00:00.000Z");
    assert.equal((await recordMissedGuidedAutomation({ db, row, scheduledFor: later, now: later })).created, true);
  });

  await check("the owner's words are scrubbed of deployment secrets at the last boundary before the model", async () => {
    let sent: unknown[] = [];
    const custom = {
      v: 1, template: { id: "custom", version: 1 }, department: "sales",
      inputs: { objective: `Look at leads and quote ${process.env.GUIDED_TEST_SECRET} in the note` },
      tools: ["leads_search"], output: "digest", target: { kind: "cloud" }, approval: "proposal_only", runtime_cap_sec: 180,
      schedule: { plan: { mode: "weekdays", time: "08:00", timezone: "America/Toronto" } },
    };
    const turn = await startAutomationTurn({
      session: { scope: { tenantId: tenant, userId: owner }, email: "owner@acme.test", tenantSlug: "acme", dept: OS_DEPARTMENTS.find((d) => d.key === "sales")!, operatorName: "Owner", isOperator: false, canManageAi: true, fallback: null, viewer: viewer as never, bridge: null, computerDispatch: null, apiEngineChoice: { kind: "api", provider: "openai" }, apiAccountSnapshot: { provider: "openai", model: "gpt-test" }, fallbackFrom: null, fallbackReason: null },
      payload: custom as never, mode: "preview", automationId: automation, automationName: row.name,
      run: { department: "sales", agentSlug: "sdr", id: "ffffffff-0000-4000-8000-000000000006" } as never,
      signal: new AbortController().signal, wouldDraft: [],
      deps: {
        prepare: async () => ({ ok: true, turn: { department: true, engine: { kind: "api" }, displayName: "Sales", agentSlug: "sdr", channelKey: "sales", provider: "openai", model: "gpt-test", revealModel: false } }) as never,
        ground: async () => ({ tools: { on: true }, stream: (messages: unknown[]) => { sent = messages; return (async function* () { yield { type: "done", inputTokens: 0, outputTokens: 0 }; })(); } }) as never,
      },
    });
    assert.equal(turn.ok, true);
    if (turn.ok) for await (const _event of turn.stream) { /* consume */ }
    const text = JSON.stringify(sent);
    assert.ok(!text.includes(String(process.env.GUIDED_TEST_SECRET)), "the secret never reaches the provider");
    assert.match(text, /REDACTED/);
  });

  await check("plainFailure: a refusal carries its own sentence, a run failure reads from the one copy table, nothing says 'can no longer be run safely' by default", () => {
    assert.equal(plainFailure("input_invalid", "Tell us a little more."), "Tell us a little more.");
    assert.match(plainFailure("run_timeout"), /time limit/);
    assert.ok(!/no longer be run safely/.test(plainFailure("provider_429")));
    assert.ok(!/no longer be run safely/.test(plainFailure("reply_empty")));
    assert.match(plainFailure("missing_connection:google-workspace", "google-workspace"), /google-workspace connection is not connected/);
  });

  await check("a draft may not carry anyone else's email or phone to the lead; the lead's own details and the owner's are fine, dates are not phones", async () => {
    assert.equal(foreignContactDetail("Call me at 514-555-0100", ["a@b.test"], null), "phone");
    assert.equal(foreignContactDetail("Write to boss@elsewhere.test too", ["a@b.test"], null), "email");
    assert.equal(foreignContactDetail("Reply to A@B.test any time", ["a@b.test"], null), null, "the lead's own address, any case");
    assert.equal(foreignContactDetail("Or ring +1 (514) 555-0100", ["a@b.test"], "514 555 0100"), null, "the lead's own number in another format");
    assert.equal(foreignContactDetail("Booked for 2026-10-15 at 10:30, invoice 12345678", ["a@b.test"], null), null, "a date or an amount is not a phone number");
    assert.equal(foreignContactDetail("Write to me@owner.test", ["a@b.test", "me@owner.test"], null), null, "the owner's own address");
    await db.execute({ sql: "INSERT INTO tenant_records (id,tenant_id,entity_type,data,created_at,updated_at) VALUES ('lead-2',?,'lead',?,?,?)", args: [tenant, JSON.stringify({ name: "Lead Two", email: "two@lead.test", phone: "+1 514 555 0199", stage: "follow_up" }), "2026-10-15T12:00:00.000Z", "2026-10-15T12:00:00.000Z"] });
    const dept = OS_DEPARTMENTS.find((d) => d.key === "sales")!;
    const policy = { mode: "preview" as const, automationId: automation, automationName: row.name };
    const draft = (body: string) => proposeAutomationEmail(viewer as never, dept, "sdr", { to: "two@lead.test", subject: "Hello", body, lead_id: "lead-2" }, new Date("2026-10-15T12:00:00.000Z"), policy, { proposed: 0 });
    await draft("Happy to talk. You can call 514 555 0199 or reply here.");
    await assert.rejects(() => draft("Dana at dana@other-client.test said she liked it."), (e: unknown) => e instanceof ProposalRefused && e.message === "automation_draft_names_another_contact");
    await assert.rejects(() => draft("Her number is 438-555-0123."), (e: unknown) => e instanceof ProposalRefused && e.message === "automation_draft_names_another_contact");
  });

  console.log(`guided-engine: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

void main();
