/**
 * tests/guided-automations-service.test.ts - the guided-automation routes and their service, end to end
 * against a real (file) libSQL database. The session, the viewer, the connection facts, the AI account and
 * the run engine are stand-ins (the engine has its own suite, tests/guided-engine.test.ts); everything
 * between them is real: the gate, the validator, the SQL, the audited toggle, the limits, the views.
 *
 * Run: node --conditions=react-server --import tsx tests/guided-automations-service.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Client } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "guided-service-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
// A deployment secret the redactor will know (its name ends in KEY and its value is long enough).
process.env.GUIDED_SERVICE_TEST_KEY = "svc-secret-value-0123456789";

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

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${String((error as Error).stack || error).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER = "bbbbbbbb-0000-4000-8000-000000000002";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000009";

/** What the stand-ins answer right now; each case sets what it needs. */
const world = {
  session: { authUserId: OWNER, profileId: "p1", tenantId: TENANT, teamRole: "owner", isOwner: true, adminAccess: false } as Record<string, unknown> | null,
  email: "owner@acme.test",
  viewerOk: true,
  financials: true,
  google: "connected" as string,
  cloud: "ready" as "ready" | "none" | "local",
  preflight: { ok: true } as { ok: boolean; code?: string; detail?: string },
  preflightThrows: false,
  /** Runs while the Turn on check is in progress (an edit saved in another tab, say). */
  duringPreflight: null as null | (() => Promise<void>),
  /** The run engine throws a failed read (GuidedPreflightUnavailable) instead of running. */
  runThrows: false,
  financeAgent: false,
  blockedSlugs: [] as string[],
  run: { status: "done", finalText: "Three leads are quiet. Call Dana first.", wouldDraft: [{ to: "dana@acme.test", subject: "Checking in", title: "t", body: "Hi Dana." }], errorCode: null as string | null },
  runCalls: [] as Array<{ mode: string }>,
};

async function main(): Promise<void> {
  const db: Client = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE tenant_cron_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_key TEXT, name TEXT, description TEXT, schedule TEXT,
      action_type TEXT, action_payload TEXT, enabled INTEGER DEFAULT 0, last_run_at TEXT, last_run_status TEXT,
      last_run_output TEXT, last_run_error TEXT, run_count INTEGER DEFAULT 0, created_by TEXT, owner_user_id TEXT,
      last_scheduled_for TEXT, tz TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE dept_chat_runs (
      id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, automation_id TEXT, origin TEXT, status TEXT,
      error_code TEXT, final_text TEXT, scheduled_for TEXT, started_at TEXT, heartbeat_at TEXT, finished_at TEXT, created_at TEXT
    );
    CREATE TABLE dept_chat_run_events (
      run_id TEXT NOT NULL, seq INTEGER NOT NULL, tenant_id TEXT NOT NULL, kind TEXT NOT NULL, data_json TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY (run_id, seq)
    );
    -- The production shape: id, metadata and created_at are NOT NULL (the toggle insert leaves them to defaults).
    CREATE TABLE tenant_audit_log (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT, actor_user_id TEXT, actor_email TEXT, action_type TEXT,
      target_table TEXT, target_id TEXT, before TEXT, after TEXT, ip_hash TEXT, user_agent TEXT,
      metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const { capabilitiesFor } = await import("../lib/role-surfaces");
  const { resolveOsModules } = await import("../lib/os/modules");
  const caps = () => ({ ...capabilitiesFor("founder", "acme"), canSeeCompanyFinancials: world.financials });
  const viewer = () => {
    const c = caps();
    return {
      ok: true as const,
      surface: { ok: true as const, persona: "founder" as const, capabilities: { ...c, canSeeCompanyFinancials: world.financials }, userId: OWNER, tenantId: TENANT, tenantSlug: "acme", teamRole: "owner", degraded: false },
      navInput: { persona: "founder" as const, capabilities: c, isOperator: false, tenantSlug: "acme", isOasisTenant: false, modules: resolveOsModules({ tenantSlug: "acme", provisioned: true }), provisioned: true, founders: null },
      oasis: false,
      provisioned: true,
      manifest: { brand: { name: "Acme", subtitle: "", logo: "default", footer_label: "", footer_tagline: "" }, agents: [{ slug: "sdr", name: "Sales", departments: ["sales"], enabled: true }, { slug: "ops", name: "Ops", departments: ["operations"], enabled: true }, ...(world.financeAgent ? [{ slug: "cfo", name: "Finance", departments: ["finance"], enabled: true }] : [])] },
      email: world.email,
      authUserId: OWNER,
    };
  };

  // ── stand-ins for everything outside the service ──────────────────────
  const realTeam = require("../lib/team");
  stub("../lib/team", { ...realTeam, getSessionContext: async () => world.session });
  const realSupabase = require("../lib/supabase-server");
  stub("../lib/supabase-server", { ...realSupabase, getSessionUser: async () => ({ id: String(world.session?.authUserId ?? OWNER), email: world.email }) });
  const realViewer = require("../components/os/department/viewer");
  stub("../components/os/department/viewer", { ...realViewer, resolveOsViewerFor: async () => (world.viewerOk ? viewer() : { ok: false, reason: "no_profile" }) });
  // The department gate: the real rail rule, plus what a case needs to open Finance (OASIS-only in production) or shut a department.
  const realGate = require("../components/os/department/gate");
  const { departmentBySlug } = require("../lib/os/departments");
  stub("../components/os/department/gate", {
    ...realGate,
    departmentGate: (slug: string, input: unknown) => {
      if (world.blockedSlugs.includes(slug)) return null;
      if (slug === "finance" && world.financeAgent) return departmentBySlug(slug);
      return realGate.departmentGate(slug, input);
    },
  });
  const realFacts = require("../components/os/connections/connector-facts");
  stub("../components/os/connections/connector-facts", { ...realFacts, loadWorkspaceConnectorStatus: async () => ({ kind: world.google, label: "x" }) });
  const realAccount = require("../lib/ai/workspace-account");
  stub("../lib/ai/workspace-account", {
    ...realAccount,
    readWorkspaceAiAccount: async () =>
      world.cloud === "none" ? null : { source: "workspace", provider: world.cloud === "local" ? "ollama" : "google", model: "gemini-test", encryptedApiKey: "enc", enabled: true },
  });
  const realRun = require("../lib/os/runs/guided-run");
  stub("../lib/os/runs/guided-run", {
    ...realRun,
    preflightGuidedAutomation: async () => {
      if (world.preflightThrows) throw new realRun.GuidedPreflightUnavailable("connector");
      if (world.duringPreflight) await world.duringPreflight();
      return world.preflight;
    },
    runGuidedAutomation: async (input: { mode: string }) => {
      if (world.runThrows) throw new realRun.GuidedPreflightUnavailable("ai_account");
      world.runCalls.push({ mode: input.mode });
      return {
        runId: `run-${world.runCalls.length}`,
        status: world.run.status,
        finalText: world.run.finalText,
        wouldDraft: world.run.wouldDraft,
        receipt: { errorCode: world.run.errorCode },
      };
    },
  });

  const service = await import("../lib/automations/guided-service");
  // Every guided request goes through ONE route module (app/api/automations/guided/[[...path]]). The
  // adapters below call it the way Next does, with the path segments, so each case reads as the URL it hits.
  const guided = await import("../app/api/automations/guided/[[...path]]/route");
  const at = (path: string[]) => ({ params: Promise.resolve({ path }) });
  type IdCtx = { params: Promise<{ id: string; runId?: string }> };
  const listRoute = { GET: (r: Request) => guided.GET(r, at([])), POST: (r: Request) => guided.POST(r, at([])) };
  const contextRoute = { GET: (r: Request) => guided.GET(r, at(["context"])) };
  const itemRoute = {
    PATCH: async (r: Request, c: IdCtx) => guided.PATCH(r, at([(await c.params).id])),
    DELETE: async (r: Request, c: IdCtx) => guided.DELETE(r, at([(await c.params).id])),
  };
  const action = (name: string) => ({ POST: async (r: Request, c: IdCtx) => guided.POST(r, at([(await c.params).id, name])) });
  const testRoute = action("test");
  const activateRoute = action("activate");
  const pauseRoute = action("pause");
  const runsRoute = { GET: async (r: Request, c: IdCtx) => guided.GET(r, at([(await c.params).id, "runs"])) };
  const receiptRoute = { GET: async (r: Request, c: IdCtx) => { const { id, runId } = await c.params; return guided.GET(r, at([id, "runs", String(runId)])); } };
  const { validateGuidedPayload } = await import("../lib/automations/guided/validate");
  const { templateById, defaultInputs } = await import("../lib/automations/guided/templates");

  const ORIGIN = "https://oasisai.work";
  const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { host: "oasisai.work", origin: ORIGIN, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
  const runCtx = (id: string, runId: string) => ({ params: Promise.resolve({ id, runId }) });
  const json = async (res: Response) => (await res.json()) as Record<string, any>;

  const followup = templateById("followup_drafts", "sales")!;
  const payloadFor = (over: Record<string, unknown> = {}) => ({
    v: 1,
    template: { id: followup.id, version: followup.version },
    department: "sales",
    inputs: defaultInputs(followup),
    schedule: { plan: followup.schedulePresets[0].plan },
    ...over,
  });
  const reset = async () => {
    world.session = { authUserId: OWNER, profileId: "p1", tenantId: TENANT, teamRole: "owner", isOwner: true, adminAccess: false };
    world.email = "owner@acme.test";
    world.viewerOk = true;
    world.financials = true;
    world.google = "connected";
    world.cloud = "ready";
    world.preflight = { ok: true };
    world.preflightThrows = false;
    world.duringPreflight = null;
    world.runThrows = false;
    world.financeAgent = false;
    world.blockedSlugs = [];
    world.run = { status: "done", finalText: "Three leads are quiet. Call Dana first.", wouldDraft: [{ to: "dana@acme.test", subject: "Checking in", title: "t", body: "Hi Dana." }], errorCode: null };
    world.runCalls = [];
    await db.execute("DELETE FROM tenant_cron_jobs");
    await db.execute("DELETE FROM dept_chat_runs");
    await db.execute("DELETE FROM dept_chat_run_events");
    await db.execute("DELETE FROM tenant_audit_log");
  };
  const create = async (over: Record<string, unknown> = {}, name?: string) => {
    const res = await listRoute.POST(req("POST", "/api/automations/guided", { name, payload: payloadFor(over) }));
    return { res, body: await json(res) };
  };

  console.log("guided automations: the routes and their service");

  await check("who may build: signed out 401, a plain member 403, an unconfirmed workspace 403, a foreign origin 403", async () => {
    await reset();
    world.session = null;
    assert.equal((await listRoute.GET(req("GET", "/api/automations/guided"))).status, 401);
    await reset();
    world.session = { ...world.session!, teamRole: "member", isOwner: false };
    const member = await listRoute.GET(req("GET", "/api/automations/guided"));
    assert.equal(member.status, 403);
    assert.equal((await json(member)).error, "forbidden");
    await reset();
    world.viewerOk = false;
    assert.equal((await listRoute.GET(req("GET", "/api/automations/guided"))).status, 403);
    await reset();
    const foreign = await listRoute.POST(req("POST", "/api/automations/guided", { payload: payloadFor() }, { origin: "https://evil.example" }));
    assert.equal(foreign.status, 403, "a write from another site is refused before anything is read");
    const noOrigin = new Request(`${ORIGIN}/api/automations/guided`, { method: "POST", headers: { host: "oasisai.work", "content-type": "application/json" }, body: JSON.stringify({ payload: payloadFor() }) });
    assert.equal((await listRoute.POST(noOrigin)).status, 403, "and so is a write with no origin at all");
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM tenant_cron_jobs")).rows[0].n, 0);
  });

  await check("context: the departments this person may build for, Cloud's state, every connection with its repair link", async () => {
    await reset();
    const res = await json(await contextRoute.GET(req("GET", "/api/automations/guided/context")));
    assert.equal(res.ok, true);
    assert.deepEqual(res.context.departments.sort(), ["operations", "sales"]);
    assert.equal(res.context.companyFinancials, true);
    assert.deepEqual(res.context.cloud, { ready: true, reason: null, repair: null });
    const google = res.context.connections.find((c: { slug: string }) => c.slug === "google-workspace");
    assert.equal(google.state, "connected");
    world.google = "not_connected";
    world.cloud = "none";
    world.financials = false;
    const bad = await json(await contextRoute.GET(req("GET", "/api/automations/guided/context")));
    assert.equal(bad.context.companyFinancials, false);
    assert.equal(bad.context.cloud.ready, false);
    assert.match(bad.context.cloud.repair.href, /^\/settings/);
    const g2 = bad.context.connections.find((c: { slug: string }) => c.slug === "google-workspace");
    assert.equal(g2.state, "not_connected");
    assert.match(g2.repair.href, /^\/settings\/connections/);
    world.cloud = "local";
    const local = await json(await contextRoute.GET(req("GET", "/api/automations/guided/context")));
    assert.match(local.context.cloud.reason, /local model/);
  });

  await check("create saves PAUSED with the server's payload, the person's own seat, the department's teammate and a cron the library built", async () => {
    await reset();
    const { res, body } = await create({}, "  Morning   follow-ups ");
    assert.equal(res.status, 201);
    assert.equal(body.item.status, "paused");
    assert.equal(body.item.name, "Morning follow-ups", "the name is trimmed and collapsed");
    assert.equal(body.item.templateTitle, "Follow-up drafts");
    assert.equal(body.item.scheduleSentence.includes("Toronto"), true);
    assert.deepEqual(body.item.nextRuns, [], "nothing is armed while it is paused");
    const row = (await db.execute("SELECT * FROM tenant_cron_jobs")).rows[0] as Record<string, any>;
    assert.equal(row.enabled, 0);
    assert.equal(row.owner_user_id, OWNER);
    assert.equal(row.created_by, OWNER);
    assert.equal(row.tenant_id, TENANT);
    assert.equal(row.action_type, "department_task");
    assert.equal(row.agent_key, "sdr", "the teammate bound to Sales in this workspace");
    assert.equal(row.schedule, "0 9 * * 1-5");
    assert.equal(row.tz, "America/Toronto");
    const stored = JSON.parse(row.action_payload);
    assert.deepEqual(stored.target, { kind: "cloud" });
    assert.equal(stored.approval, "proposal_only");
    assert.equal(stored.runtime_cap_sec, followup.runtimeCapSec);
    assert.deepEqual(stored.tools, [...followup.tools]);
    // The default name is the template's.
    const unnamed = await create({});
    assert.equal(unnamed.body.item.name, "Follow-up drafts");
  });

  await check("a hostile body cannot widen anything or name another workspace or person", async () => {
    await reset();
    const hostile = await listRoute.POST(
      req("POST", "/api/automations/guided", {
        tenant_id: "other-tenant",
        owner_user_id: OTHER,
        enabled: 1,
        payload: payloadFor({ tools: ["pipeline_summary", "finance_get_metric"], target: { kind: "device" }, runtime_cap_sec: 3600 }),
      }),
    );
    assert.equal(hostile.status, 422);
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM tenant_cron_jobs")).rows[0].n, 0, "nothing was written");
    // Extra top-level body keys are ignored: the row is the session's, paused.
    const { body } = await create({});
    const rows = (await db.execute("SELECT tenant_id, owner_user_id, enabled FROM tenant_cron_jobs")).rows as unknown as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((r) => [r.tenant_id, r.owner_user_id, r.enabled]), [[TENANT, OWNER, 0]]);
    assert.equal(body.ok, true);
    const bad = await json(await listRoute.POST(req("POST", "/api/automations/guided", { payload: payloadFor({ inputs: { max_drafts: 99 } }) })));
    assert.equal(bad.error, "input_invalid");
    assert.equal(bad.field, "max_drafts");
    const badName = await json(await listRoute.POST(req("POST", "/api/automations/guided", { name: "x".repeat(81), payload: payloadFor() })));
    assert.equal(badName.field, "name");
  });

  await check("a department the person cannot reach, and Finance without the right to see company money, are refused", async () => {
    await reset();
    const marketing = templateById("marketing_numbers", "marketing")!;
    const send = (tpl: typeof marketing) =>
      listRoute.POST(req("POST", "/api/automations/guided", { payload: { v: 1, template: { id: tpl.id, version: tpl.version }, department: tpl.department, inputs: {}, schedule: { plan: tpl.schedulePresets[0].plan } } }));
    const noTeammate = await send(marketing);
    assert.equal(noTeammate.status, 403, "no teammate is bound to Marketing in this workspace");
    assert.equal((await json(noTeammate)).field, "department");
    world.financials = false;
    const money = templateById("money_summary", "finance")!;
    const denied = await send(money);
    assert.equal(denied.status, 422);
    assert.equal((await json(denied)).error, "template_not_available");
  });

  await check("a workspace may hold only so many guided automations", async () => {
    await reset();
    for (let i = 0; i < service.MAX_GUIDED_PER_WORKSPACE; i += 1) {
      await db.execute({ sql: "INSERT INTO tenant_cron_jobs (id, tenant_id, action_type, name, owner_user_id, enabled) VALUES (?, ?, 'department_task', 'x', ?, 0)", args: [`row-${i}`, TENANT, OWNER] });
    }
    const over = await create({});
    assert.equal(over.res.status, 409);
    assert.equal(over.body.error, "limit_reached");
  });

  await check("list shows status, schedule words, the next three runs once it is on, the last run, and what blocks it", async () => {
    await reset();
    const { body } = await create({});
    const id = body.item.id as string;
    await db.execute({ sql: "INSERT INTO dept_chat_runs (id, tenant_id, user_id, automation_id, origin, status, final_text, created_at, started_at) VALUES ('r1', ?, ?, ?, 'test', 'done', 'Two drafts would have been filed. More text.', '2026-10-15T12:00:00.000Z', '2026-10-15T12:00:01.000Z')", args: [TENANT, OWNER, id] });
    let items = (await json(await listRoute.GET(req("GET", "/api/automations/guided")))).items;
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "paused");
    assert.deepEqual(items[0].lastRun, { at: "2026-10-15T12:00:01.000Z", status: "done", summary: "Two drafts would have been filed.", receiptId: "r1", preview: true });
    assert.deepEqual(items[0].problems, []);
    world.google = "not_connected";
    items = (await json(await listRoute.GET(req("GET", "/api/automations/guided")))).items;
    assert.equal(items[0].problems[0].code, "missing_connection:google-workspace");
    assert.match(items[0].problems[0].repair.href, /^\/settings\/connections/);
    world.google = "connected";
    const on = await json(await activateRoute.POST(req("POST", `/api/automations/guided/${id}/activate`), idCtx(id)));
    assert.equal(on.item.status, "on");
    assert.equal(on.item.nextRuns.length, 3);
    for (const t of on.item.nextRuns) assert.ok(Date.parse(t) > Date.now(), "future instants");
    // On, but its connection broke: needs attention, with the fix.
    world.google = "attention";
    const sick = (await json(await listRoute.GET(req("GET", "/api/automations/guided")))).items[0];
    assert.equal(sick.status, "needs_attention");
    // Another workspace's rows never appear.
    await db.execute({ sql: "INSERT INTO tenant_cron_jobs (id, tenant_id, action_type, name, owner_user_id, action_payload, enabled) VALUES ('foreign', 'other-tenant', 'department_task', 'theirs', 'u', '{}', 0)" });
    const all = (await json(await listRoute.GET(req("GET", "/api/automations/guided")))).items;
    assert.ok(!all.some((i: { id: string }) => i.id === "foreign"));
  });

  await check("a saved payload that no longer validates is listed as needs attention, never hidden", async () => {
    await reset();
    await db.execute({ sql: "INSERT INTO tenant_cron_jobs (id, tenant_id, action_type, name, owner_user_id, action_payload, enabled) VALUES ('old', ?, 'department_task', 'Old one', ?, ?, 1)", args: [TENANT, OWNER, JSON.stringify({ v: 1, template: { id: "followup_drafts", version: 99 }, department: "sales", inputs: {}, schedule: { plan: { mode: "manual", timezone: "America/Toronto" } } })] });
    const items = (await json(await listRoute.GET(req("GET", "/api/automations/guided")))).items;
    assert.equal(items[0].status, "needs_attention");
    assert.equal(items[0].problems[0].code, "template_version_unknown");
    await db.execute("INSERT INTO tenant_cron_jobs (id, tenant_id, action_type, name, owner_user_id, action_payload, enabled) VALUES ('junk', '" + TENANT + "', 'department_task', 'Corrupt', '" + OWNER + "', 'not json', 0)");
    const again = (await json(await listRoute.GET(req("GET", "/api/automations/guided")))).items;
    assert.equal(again.length, 1, "a corrupt row is logged and left out, not a 500");
  });

  await check("only the owner edits, tests, turns on or deletes; a changed automation is switched off; anyone managing may pause", async () => {
    await reset();
    const { body } = await create({});
    const id = body.item.id as string;
    await json(await activateRoute.POST(req("POST", `/api/automations/guided/${id}/activate`), idCtx(id)));
    assert.equal((await db.execute("SELECT enabled FROM tenant_cron_jobs")).rows[0].enabled, 1);
    // Someone else who manages the workspace:
    world.session = { ...world.session!, authUserId: OTHER, teamRole: "admin", isOwner: false };
    for (const [method, path, call, payload] of [
      ["PATCH", `/api/automations/guided/${id}`, itemRoute.PATCH, { payload: payloadFor() }],
      ["DELETE", `/api/automations/guided/${id}`, itemRoute.DELETE, undefined],
      ["POST", `/api/automations/guided/${id}/test`, testRoute.POST, undefined],
      ["POST", `/api/automations/guided/${id}/activate`, activateRoute.POST, undefined],
    ] as const) {
      const res = await (call as (r: Request, c: unknown) => Promise<Response>)(req(method, path, payload), idCtx(id));
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal((await json(res)).error, "not_your_automation");
    }
    assert.equal(world.runCalls.length, 0, "a non-owner's test never reached the engine");
    const paused = await json(await pauseRoute.POST(req("POST", `/api/automations/guided/${id}/pause`), idCtx(id)));
    assert.equal(paused.item.status, "paused", "an admin may switch it off");
    // Back to the owner: editing a turned-on automation switches it off.
    world.session = { ...world.session!, authUserId: OWNER, teamRole: "owner", isOwner: true };
    await json(await activateRoute.POST(req("POST", `/api/automations/guided/${id}/activate`), idCtx(id)));
    const edited = await json(await itemRoute.PATCH(req("PATCH", `/api/automations/guided/${id}`, { name: "Renamed", payload: payloadFor({ inputs: { max_drafts: 2, goal: "check_in", tone: "direct" } }) }), idCtx(id)));
    assert.equal(edited.item.name, "Renamed");
    assert.equal(edited.item.status, "paused", "changed means switched off");
    assert.equal(edited.item.payload.inputs.max_drafts, 2);
    const audits = (await db.execute("SELECT action_type FROM tenant_audit_log")).rows.map((r) => r.action_type);
    assert.equal(audits.filter((a) => a === "cron_job_toggle").length, 3, "every switch is audited: on, off, on");
    const gone = await itemRoute.DELETE(req("DELETE", `/api/automations/guided/${id}`), idCtx(id));
    assert.equal(gone.status, 200);
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM tenant_cron_jobs")).rows[0].n, 0);
    assert.equal((await itemRoute.DELETE(req("DELETE", `/api/automations/guided/${id}`), idCtx(id))).status, 404, "gone is gone");
  });

  await check("Turn on is refused with the fix when the run would be refused: connection, Cloud, seat", async () => {
    await reset();
    const { body } = await create({});
    const id = body.item.id as string;
    const turnOn = async () => {
      const res = await activateRoute.POST(req("POST", `/api/automations/guided/${id}/activate`), idCtx(id));
      return { status: res.status, body: await json(res) };
    };
    world.preflight = { ok: false, code: "missing_connection:google-workspace", detail: "google-workspace" };
    const conn = await turnOn();
    assert.equal(conn.status, 409);
    assert.equal(conn.body.error, "connection_missing");
    assert.match(conn.body.repair.href, /^\/settings\/connections/);
    world.preflight = { ok: false, code: "ai_account_unavailable" };
    const cloud = await turnOn();
    assert.equal(cloud.body.error, "cloud_unavailable");
    assert.match(cloud.body.repair.href, /^\/settings/);
    world.preflight = { ok: false, code: "owner_inactive" };
    assert.equal((await turnOn()).status, 403);
    world.preflight = { ok: false, code: "tool_unavailable:propose_email" };
    assert.equal((await turnOn()).body.error, "tools_invalid");
    assert.equal((await db.execute("SELECT enabled FROM tenant_cron_jobs")).rows[0].enabled, 0, "still off after every refusal");
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM tenant_audit_log")).rows[0].n, 0, "and nothing audited as switched");
    world.preflight = { ok: true };
    assert.equal((await turnOn()).status, 200);
  });

  await check("Test now runs the engine in PREVIEW and answers with text, the drafts it would file and a plain failure", async () => {
    await reset();
    const { body } = await create({});
    const id = body.item.id as string;
    const ok = await json(await testRoute.POST(req("POST", `/api/automations/guided/${id}/test`), idCtx(id)));
    assert.deepEqual(world.runCalls, [{ mode: "preview" }]);
    assert.equal(ok.result.status, "done");
    assert.equal(ok.result.finalText, "Three leads are quiet. Call Dana first.");
    assert.deepEqual(ok.result.wouldDraft, [{ to: "dana@acme.test", subject: "Checking in", body: "Hi Dana." }]);
    assert.equal(ok.result.failure, null);
    world.run = { status: "failed", finalText: "", wouldDraft: [], errorCode: "missing_connection:google-workspace" };
    const bad = await json(await testRoute.POST(req("POST", `/api/automations/guided/${id}/test`), idCtx(id)));
    assert.equal(bad.result.status, "failed");
    assert.match(bad.result.failure, /connection is not connected/);
    world.run = { status: "failed", finalText: "", wouldDraft: [], errorCode: "run_timeout" };
    assert.match((await json(await testRoute.POST(req("POST", `/api/automations/guided/${id}/test`), idCtx(id)))).result.failure, /time limit/);
    world.run = { status: "queued", finalText: "", wouldDraft: [], errorCode: null };
    const stuck = await json(await testRoute.POST(req("POST", `/api/automations/guided/${id}/test`), idCtx(id)));
    assert.equal(stuck.result.status, "failed", "a run that did not finish is never reported as done");
    assert.ok(stuck.result.failure);
  });

  await check("Test now is capped per person per hour, by an atomic claim in the database", async () => {
    await reset();
    const { body } = await create({});
    const id = body.item.id as string;
    const claim = async (when: string) =>
      db.execute({ sql: "INSERT INTO tenant_audit_log (tenant_id, actor_user_id, action_type, created_at) VALUES (?, ?, 'guided_test_claim', ?)", args: [TENANT, OWNER, when] });
    for (let i = 0; i < service.MAX_TESTS_PER_HOUR; i += 1) await claim(new Date().toISOString());
    const limited = await testRoute.POST(req("POST", `/api/automations/guided/${id}/test`), idCtx(id));
    assert.equal(limited.status, 429);
    assert.equal((await json(limited)).error, "rate_limited");
    assert.equal(world.runCalls.length, 0);
    // Another person's claims do not count against this one.
    await db.execute({ sql: "UPDATE tenant_audit_log SET actor_user_id = ?", args: [OTHER] });
    assert.equal((await testRoute.POST(req("POST", `/api/automations/guided/${id}/test`), idCtx(id))).status, 200);
    // An old claim does not count.
    await db.execute({ sql: "UPDATE tenant_audit_log SET actor_user_id = ?, created_at = ?", args: [OWNER, new Date(Date.now() - 2 * 3_600_000).toISOString()] });
    assert.equal((await testRoute.POST(req("POST", `/api/automations/guided/${id}/test`), idCtx(id))).status, 200);
  });

  await check("a burst of Test now presses cannot pass the cap together: exactly the allowance runs", async () => {
    await reset();
    const { body } = await create({});
    const id = body.item.id as string;
    const presses = await Promise.all(
      Array.from({ length: service.MAX_TESTS_PER_HOUR + 5 }, () => testRoute.POST(req("POST", `/api/automations/guided/${id}/test`), idCtx(id))),
    );
    const statuses = presses.map((r) => r.status);
    assert.equal(statuses.filter((x) => x === 200).length, service.MAX_TESTS_PER_HOUR, `statuses: ${statuses.join(",")}`);
    assert.equal(statuses.filter((x) => x === 429).length, 5);
    assert.equal(world.runCalls.length, service.MAX_TESTS_PER_HOUR, "the refused presses never reached the engine");
    const claims = (await db.execute("SELECT COUNT(*) AS n FROM tenant_audit_log WHERE action_type = 'guided_test_claim'")).rows[0].n;
    assert.equal(claims, service.MAX_TESTS_PER_HOUR);
  });

  await check("Test now while a run of the same automation is going is refused first, without using the allowance; a dead one does not block", async () => {
    await reset();
    const { body } = await create({});
    const id = body.item.id as string;
    const seed = (runId: string, status: string, beat: string) =>
      db.execute({ sql: "INSERT INTO dept_chat_runs (id, tenant_id, user_id, automation_id, origin, status, created_at, started_at, heartbeat_at) VALUES (?, ?, ?, ?, 'automation', ?, ?, ?, ?)", args: [runId, TENANT, OWNER, id, status, beat, beat, beat] });
    await seed("live-run", "running", new Date().toISOString());
    const busy = await testRoute.POST(req("POST", `/api/automations/guided/${id}/test`), idCtx(id));
    assert.equal(busy.status, 409);
    assert.equal((await json(busy)).error, "run_in_progress");
    assert.equal(world.runCalls.length, 0);
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM tenant_audit_log WHERE action_type = 'guided_test_claim'")).rows[0].n, 0, "a refusal uses none of the hourly allowance");
    await db.execute("DELETE FROM dept_chat_runs");
    await seed("dead-run", "running", new Date(Date.now() - 10 * 60_000).toISOString());
    assert.equal((await testRoute.POST(req("POST", `/api/automations/guided/${id}/test`), idCtx(id))).status, 200, "a run whose driver stopped reporting does not block for ever");
  });

  await check("the edges: a malformed id is a 404 before any read, a huge or non-object body is a 400, an unknown id is a 404", async () => {
    await reset();
    assert.equal((await itemRoute.DELETE(req("DELETE", "/api/automations/guided/not-an-id"), idCtx("not-an-id"))).status, 404);
    const huge = await listRoute.POST(req("POST", "/api/automations/guided", { payload: payloadFor(), pad: "x".repeat(30_000) }));
    assert.equal(huge.status, 400);
    const array = await listRoute.POST(new Request(`${ORIGIN}/api/automations/guided`, { method: "POST", headers: { host: "oasisai.work", origin: ORIGIN }, body: "[1,2]" }));
    assert.equal(array.status, 400);
    const unknown = "dddddddd-0000-4000-8000-000000000004";
    assert.equal((await testRoute.POST(req("POST", `/api/automations/guided/${unknown}/test`), idCtx(unknown))).status, 404);
    assert.equal((await pauseRoute.POST(req("POST", `/api/automations/guided/${unknown}/pause`), idCtx(unknown))).status, 404);
    assert.equal(world.runCalls.length, 0);
    // A guided id that is really a script automation is not reachable through these routes.
    await db.execute({ sql: "INSERT INTO tenant_cron_jobs (id, tenant_id, action_type, name, owner_user_id, enabled) VALUES (?, ?, 'script_run', 'A script', ?, 1)", args: ["eeeeeeee-0000-4000-8000-000000000005", TENANT, OWNER] });
    const script = "eeeeeeee-0000-4000-8000-000000000005";
    assert.equal((await pauseRoute.POST(req("POST", `/api/automations/guided/${script}/pause`), idCtx(script))).status, 404);
    assert.equal((await db.execute({ sql: "SELECT enabled FROM tenant_cron_jobs WHERE id = ?", args: [script] })).rows[0].enabled, 1, "a script job is untouched");
  });

  const customPayload = (over: Record<string, unknown> = {}) => ({
    v: 1,
    template: { id: "custom", version: 1 },
    department: "sales",
    inputs: { objective: "Which leads from this week have not had a reply?" },
    tools: ["leads_search"],
    output: "digest",
    schedule: { plan: { mode: "weekdays", time: "08:00" } },
    ...over,
  });

  await check("a saved custom drafts automation reads back as valid: what the server stored passes the same validation again", async () => {
    await reset();
    const made = await listRoute.POST(req("POST", "/api/automations/guided", { payload: customPayload({ output: "email_drafts" }) }));
    assert.equal(made.status, 201, JSON.stringify(await made.clone().json()));
    const item = (await json(made)).item;
    assert.equal(item.status, "paused", "valid and paused, not 'needs attention' the moment it is saved");
    assert.deepEqual(item.problems.filter((p: { code: string }) => p.code === "tools_invalid"), []);
    assert.ok(item.payload.tools.includes("propose_email"));
    const stored = JSON.parse(String((await db.execute("SELECT action_payload FROM tenant_cron_jobs")).rows[0].action_payload));
    const again = validateGuidedPayload(stored, { companyFinancials: true });
    assert.equal(again.ok, true, "round trip: " + JSON.stringify(again));
    if (again.ok) assert.deepEqual(again.payload, stored, "and it is stable");
    // The draft tool is still not a read for a digest.
    const digest = await json(await listRoute.POST(req("POST", "/api/automations/guided", { payload: customPayload({ tools: ["leads_search", "propose_email"] }) })));
    assert.equal(digest.error, "tools_invalid");
    // Only the draft tool ticked is not enough: it must read something.
    const lone = await json(await listRoute.POST(req("POST", "/api/automations/guided", { payload: customPayload({ output: "email_drafts", tools: ["propose_email"] }) })));
    assert.equal(lone.error, "tools_invalid");
  });

  await check("email drafts need a real schedule: 'only when I run it' only ever previews, so it is refused", async () => {
    await reset();
    const res = await json(await listRoute.POST(req("POST", "/api/automations/guided", { payload: customPayload({ output: "email_drafts", schedule: { plan: { mode: "manual" } } }) })));
    assert.equal(res.error, "schedule_invalid");
    assert.match(res.message, /Email drafts need a schedule/);
    const digest = await listRoute.POST(req("POST", "/api/automations/guided", { payload: customPayload({ schedule: { plan: { mode: "manual" } } }) }));
    assert.equal(digest.status, 201, "a digest may still be run by hand");
  });

  await check("the owner's words are refused when they contain a deployment secret; nothing is saved", async () => {
    await reset();
    const res = await listRoute.POST(req("POST", "/api/automations/guided", { payload: customPayload({ inputs: { objective: "Use the key svc-secret-value-0123456789 to look at leads" } }) }));
    assert.equal(res.status, 422);
    const body = await json(res);
    assert.equal(body.error, "input_invalid");
    assert.equal(body.field, "objective");
    assert.ok(!JSON.stringify(body).includes("svc-secret-value"), "the refusal does not echo the secret");
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM tenant_cron_jobs")).rows[0].n, 0);
  });

  await check("the stored zone follows the plan's zone, not a constant", async () => {
    await reset();
    const made = await listRoute.POST(req("POST", "/api/automations/guided", { payload: customPayload({ schedule: { plan: { mode: "weekdays", time: "08:00", timezone: "America/Vancouver" } } }) }));
    assert.equal(made.status, 201);
    const row = (await db.execute("SELECT tz, action_payload FROM tenant_cron_jobs")).rows[0] as Record<string, any>;
    assert.equal(row.tz, JSON.parse(row.action_payload).schedule.plan.timezone);
    assert.equal(row.tz, "America/Vancouver");
  });

  await check("a malformed stored payload is shown in a safe shape: no unchecked cast reaches the page", async () => {
    await reset();
    await db.execute({
      sql: "INSERT INTO tenant_cron_jobs (id, tenant_id, action_type, name, owner_user_id, action_payload, enabled) VALUES ('mal', ?, 'department_task', 'Mangled', ?, ?, 0)",
      args: [TENANT, OWNER, JSON.stringify({ v: 1, template: "nope", department: "bogus", inputs: "oops", tools: "x", output: 7, schedule: "daily", runtime_cap_sec: "soon" })],
    });
    const items = (await json(await listRoute.GET(req("GET", "/api/automations/guided")))).items;
    assert.equal(items.length, 1);
    const view = items[0];
    assert.equal(view.status, "needs_attention");
    assert.ok(Array.isArray(view.payload.tools), "tools is always an array");
    assert.equal(typeof view.payload.inputs, "object");
    assert.ok(!Array.isArray(view.payload.inputs));
    assert.equal(view.payload.target.kind, "cloud");
    assert.ok(["digest", "email_drafts"].includes(view.payload.output));
    assert.equal(typeof view.payload.schedule.plan.mode, "string");
    assert.equal(view.department, "chief_of_staff", "an unknown department becomes the neutral one, not the raw string");
    const sal = service.salvagePayload({ tools: ["a", 3, "b"], inputs: { n: 5, s: "x".repeat(900), z: { deep: 1 } }, department: "sales" });
    assert.deepEqual(sal.tools, ["a", "b"]);
    assert.deepEqual(sal.inputs.n, 5);
    assert.equal(String(sal.inputs.s).length, 400);
    assert.ok(!("z" in sal.inputs));
  });

  await check("another admin sees only what the department pages would show them; a Finance digest is hidden without the right", async () => {
    await reset();
    world.financeAgent = true;
    const money = templateById("money_summary", "finance")!;
    const madeFinance = await listRoute.POST(req("POST", "/api/automations/guided", { payload: { v: 1, template: { id: money.id, version: money.version }, department: "finance", inputs: {}, schedule: { plan: money.schedulePresets[0].plan } } }));
    assert.equal(madeFinance.status, 201, JSON.stringify(await madeFinance.clone().json()));
    const financeId = (await json(madeFinance)).item.id as string;
    const salesId = (await create({})).body.item.id as string;
    await db.execute({ sql: "INSERT INTO dept_chat_runs (id, tenant_id, user_id, automation_id, origin, status, final_text, created_at, started_at) VALUES ('fin-run', ?, ?, ?, 'automation', 'done', 'Collected 9000 dollars in 7 days.', '2026-10-15T12:00:00.000Z', '2026-10-15T12:00:01.000Z')", args: [TENANT, OWNER, financeId] });
    // The owner sees both.
    assert.equal((await json(await listRoute.GET(req("GET", "/api/automations/guided")))).items.length, 2);
    // A different admin without the company-financials right.
    world.session = { ...world.session!, authUserId: OTHER, teamRole: "admin", isOwner: false };
    world.financials = false;
    world.blockedSlugs = [];
    const theirs = (await json(await listRoute.GET(req("GET", "/api/automations/guided")))).items;
    assert.deepEqual(theirs.map((i: { id: string }) => i.id), [salesId], "the Finance digest and its last result are not listed");
    assert.ok(!JSON.stringify(theirs).includes("9000"));
    assert.equal((await pauseRoute.POST(req("POST", `/api/automations/guided/${financeId}/pause`), idCtx(financeId))).status, 404);
    assert.equal((await runsRoute.GET(req("GET", `/api/automations/guided/${financeId}/runs`), idCtx(financeId))).status, 404);
    assert.equal((await receiptRoute.GET(req("GET", `/api/automations/guided/${financeId}/runs/fin-run`), runCtx(financeId, "fin-run"))).status, 404);
    // With the right they see it.
    world.financials = true;
    assert.equal((await json(await listRoute.GET(req("GET", "/api/automations/guided")))).items.length, 2);
    // A department they cannot open hides its automations from them too, with the same "not found".
    world.blockedSlugs = ["sales"];
    const noSales = (await json(await listRoute.GET(req("GET", "/api/automations/guided")))).items;
    assert.deepEqual(noSales.map((i: { id: string }) => i.id), [financeId]);
    assert.equal((await pauseRoute.POST(req("POST", `/api/automations/guided/${salesId}/pause`), idCtx(salesId))).status, 404);
    // The owner keeps seeing their own, so they can read what stopped working and fix it.
    world.session = { ...world.session!, authUserId: OWNER, teamRole: "owner", isOwner: true };
    assert.equal((await json(await listRoute.GET(req("GET", "/api/automations/guided")))).items.length, 2);
  });

  await check("run history and receipts: newest first, redacted, tied to the automation, steps in order", async () => {
    await reset();
    const id = (await create({})).body.item.id as string;
    const other = (await create({})).body.item.id as string;
    const put = (runId: string, automation: string, status: string, origin: string, at: string, text: string | null, code: string | null = null) =>
      db.execute({ sql: "INSERT INTO dept_chat_runs (id, tenant_id, user_id, automation_id, origin, status, final_text, error_code, scheduled_for, created_at, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", args: [runId, TENANT, OWNER, automation, origin, status, text, code, at, at, at, at] });
    await put("11111111-0000-4000-8000-000000000001", id, "done", "automation", "2026-10-15T12:00:00.000Z", "Two leads are quiet. Key svc-secret-value-0123456789 leaked.");
    await put("11111111-0000-4000-8000-000000000002", id, "failed", "test", "2026-10-15T13:00:00.000Z", null, "run_timeout");
    await put("11111111-0000-4000-8000-000000000003", other, "done", "automation", "2026-10-15T14:00:00.000Z", "Not this one.");
    const ev = (runId: string, seq: number, data: unknown) =>
      db.execute({ sql: "INSERT INTO dept_chat_run_events (run_id, seq, tenant_id, kind, data_json, created_at) VALUES (?, ?, ?, 'tool', ?, '2026-10-15T12:00:00.000Z')", args: [runId, seq, TENANT, JSON.stringify(data)] });
    const first = "11111111-0000-4000-8000-000000000001";
    await ev(first, 1, { id: "a", phase: "start", label: "Looking up the pipeline", ok: null });
    await ev(first, 2, { id: "a", phase: "done", ok: true });
    await ev(first, 3, { id: "b", phase: "start", label: "Reading lead history", ok: null });
    await ev(first, 4, { id: "b", phase: "done", ok: false });

    const list = await json(await runsRoute.GET(req("GET", `/api/automations/guided/${id}/runs`), idCtx(id)));
    assert.deepEqual(list.runs.map((r: { id: string }) => r.id), ["11111111-0000-4000-8000-000000000002", first], "newest first, only this automation's");
    assert.equal(list.runs[0].origin, "test");
    assert.match(list.runs[0].summary, /time limit/);
    assert.equal(list.runs[1].origin, "scheduled");

    const receipt = await json(await receiptRoute.GET(req("GET", `/api/automations/guided/${id}/runs/${first}`), runCtx(id, first)));
    assert.equal(receipt.ok, true);
    assert.deepEqual(receipt.receipt.steps, [{ label: "Looking up the pipeline", ok: true }, { label: "Reading lead history", ok: false }]);
    assert.ok(!JSON.stringify(receipt).includes("svc-secret-value"), `the receipt is redacted: ${JSON.stringify(receipt).slice(0, 400)}`);
    assert.match(receipt.receipt.text, /Two leads are quiet/);
    const failed = await json(await receiptRoute.GET(req("GET", `/api/automations/guided/${id}/runs/11111111-0000-4000-8000-000000000002`), runCtx(id, "11111111-0000-4000-8000-000000000002")));
    assert.match(failed.receipt.failure, /time limit/);
    assert.equal(failed.receipt.text, "");
    // Another automation's run, a run id that is not an id, and an unknown run are all "not found".
    const foreign = "11111111-0000-4000-8000-000000000003";
    assert.equal((await receiptRoute.GET(req("GET", `/api/automations/guided/${id}/runs/${foreign}`), runCtx(id, foreign))).status, 404);
    assert.equal((await receiptRoute.GET(req("GET", `/api/automations/guided/${id}/runs/nope`), runCtx(id, "nope"))).status, 404);
    assert.equal((await receiptRoute.GET(req("GET", `/api/automations/guided/${id}/runs/11111111-0000-4000-8000-0000000000ff`), runCtx(id, "11111111-0000-4000-8000-0000000000ff"))).status, 404);
    // Signed out.
    world.session = null;
    assert.equal((await runsRoute.GET(req("GET", `/api/automations/guided/${id}/runs`), idCtx(id))).status, 401);
  });

  await check("Turn on: a failed READ is a try-again, not a verdict; an automation that is already on is not re-stamped; a demoted owner is refused", async () => {
    await reset();
    const id = (await create({})).body.item.id as string;
    const turnOn = async () => {
      const res = await activateRoute.POST(req("POST", `/api/automations/guided/${id}/activate`), idCtx(id));
      return { status: res.status, body: await json(res) };
    };
    world.preflightThrows = true;
    const hiccup = await turnOn();
    assert.equal(hiccup.status, 503);
    assert.match(hiccup.body.message, /Nothing was changed/);
    assert.equal((await db.execute("SELECT enabled FROM tenant_cron_jobs")).rows[0].enabled, 0);
    world.preflightThrows = false;
    assert.equal((await turnOn()).status, 200);
    await db.execute({ sql: "UPDATE tenant_cron_jobs SET last_scheduled_for = '2026-10-15T08:00:00.000Z'" });
    assert.equal((await turnOn()).status, 200);
    assert.equal((await db.execute("SELECT last_scheduled_for FROM tenant_cron_jobs")).rows[0].last_scheduled_for, "2026-10-15T08:00:00.000Z", "turning on what is already on changes nothing");
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM tenant_audit_log WHERE action_type = 'cron_job_toggle'")).rows[0].n, 1, "and audits nothing");
    await db.execute("UPDATE tenant_cron_jobs SET enabled = 0");
    world.preflight = { ok: false, code: "owner_not_manager" };
    const demoted = await turnOn();
    assert.equal(demoted.status, 403);
    assert.equal(demoted.body.error, "forbidden");
  });

  await check("the workspace cap holds under concurrent saves: the count and the insert are one statement", async () => {
    await reset();
    for (let i = 0; i < service.MAX_GUIDED_PER_WORKSPACE - 1; i += 1) {
      await db.execute({ sql: "INSERT INTO tenant_cron_jobs (id, tenant_id, action_type, name, owner_user_id, enabled) VALUES (?, ?, 'department_task', 'x', ?, 0)", args: [`cap-${i}`, TENANT, OWNER] });
    }
    const results = await Promise.all(Array.from({ length: 4 }, () => create({})));
    const statuses = results.map((r) => r.res.status).sort();
    assert.deepEqual(statuses, [201, 409, 409, 409], `statuses: ${statuses.join(",")}`);
    assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS n FROM tenant_cron_jobs WHERE tenant_id = ? AND action_type = 'department_task'", args: [TENANT] })).rows[0].n, service.MAX_GUIDED_PER_WORKSPACE);
  });

  await check("Turn on never switches on a version that was edited while it was being checked", async () => {
    await reset();
    const id = (await create({})).body.item.id as string;
    // While the check runs, the owner saves an edit in another tab: a new payload, switched off.
    world.duringPreflight = async () => {
      await listRoute.GET(req("GET", "/api/automations/guided"));
      const edited = await itemRoute.PATCH(req("PATCH", `/api/automations/guided/${id}`, { payload: payloadFor({ inputs: { max_drafts: 1, goal: "check_in", tone: "direct" } }) }), idCtx(id));
      assert.equal(edited.status, 200);
      world.duringPreflight = null;
    };
    const res = await activateRoute.POST(req("POST", `/api/automations/guided/${id}/activate`), idCtx(id));
    assert.equal(res.status, 409);
    const body = await json(res);
    assert.equal(body.error, "changed_while_checking");
    assert.match(body.message, /changed while we were checking/);
    const row = (await db.execute({ sql: "SELECT enabled, action_payload FROM tenant_cron_jobs WHERE id = ?", args: [id] })).rows[0] as Record<string, any>;
    assert.equal(row.enabled, 0, "the unchecked version is not left on");
    assert.equal(JSON.parse(row.action_payload).inputs.max_drafts, 1, "the edit is kept");
    // Checked as it is now, it turns on.
    assert.equal((await activateRoute.POST(req("POST", `/api/automations/guided/${id}/activate`), idCtx(id))).status, 200);
  });

  await check("each listed automation says whether the viewer made it; only the owner's own is theirs to change", async () => {
    await reset();
    const id = (await create({})).body.item.id as string;
    assert.equal((await json(await listRoute.GET(req("GET", "/api/automations/guided")))).items[0].mine, true);
    world.session = { ...world.session!, authUserId: OTHER, teamRole: "admin", isOwner: false };
    const theirs = (await json(await listRoute.GET(req("GET", "/api/automations/guided")))).items;
    assert.equal(theirs[0].id, id);
    assert.equal(theirs[0].mine, false);
  });

  await check("Test now when a read fails before the run: a plain try-again, and the hourly test is given back", async () => {
    await reset();
    const id = (await create({})).body.item.id as string;
    world.runThrows = true;
    const res = await testRoute.POST(req("POST", `/api/automations/guided/${id}/test`), idCtx(id));
    assert.equal(res.status, 503);
    assert.match((await json(res)).message, /the test did not run\. Try again in a minute\./);
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM tenant_audit_log WHERE action_type = 'guided_test_claim'")).rows[0].n, 0, "the claim was given back");
    world.runThrows = false;
    assert.equal((await testRoute.POST(req("POST", `/api/automations/guided/${id}/test`), idCtx(id))).status, 200);
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM tenant_audit_log WHERE action_type = 'guided_test_claim'")).rows[0].n, 1);
  });

  await check("the one route module: an unknown path or method is a 404 and reaches no handler", async () => {
    await reset();
    const id = (await create({})).body.item.id as string;
    world.runCalls = [];
    const statusOf = async (res: Promise<Response>) => (await res).status;
    assert.equal(await statusOf(guided.GET(req("GET", "/api/automations/guided/nope"), at(["nope"]))), 404);
    assert.equal(await statusOf(guided.GET(req("GET", `/api/automations/guided/${id}`), at([id]))), 404, "an automation is read through the list");
    assert.equal(await statusOf(guided.POST(req("POST", `/api/automations/guided/${id}/launch`), at([id, "launch"]))), 404);
    assert.equal(await statusOf(guided.POST(req("POST", `/api/automations/guided/${id}`), at([id]))), 404);
    assert.equal(await statusOf(guided.PATCH(req("PATCH", "/api/automations/guided", {}), at([]))), 404);
    assert.equal(await statusOf(guided.DELETE(req("DELETE", `/api/automations/guided/${id}/runs`), at([id, "runs"]))), 404);
    assert.equal(await statusOf(guided.GET(req("GET", `/api/automations/guided/${id}/runs/x/y`), at([id, "runs", "x", "y"]))), 404);
    assert.equal(await statusOf(guided.GET(req("GET", `/api/automations/guided/context/runs`), at(["context", "runs"]))), 404, "context is not an id");
    assert.equal(world.runCalls.length, 0);
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM tenant_cron_jobs")).rows[0].n, 1, "nothing was changed");
  });

  console.log(`guided-automations-service: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
