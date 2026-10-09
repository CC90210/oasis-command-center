/**
 * department-desk.test.ts - a department teammate knows the business it works
 * for, and can look it up (lib/os/desk/*).
 *
 * WHY (CC, 2026-10-09). Chief of Staff answered "what's happening in the
 * pipeline and what tools do you have" with "please connect or specify the
 * workspace CRM": every department turn sent about 200 input tokens, a persona
 * and nothing else. What must hold now:
 *   - the turn's prompt carries the DEPARTMENT STATE (the page's numbers,
 *     pipeline, follow-ups, connections) of THIS workspace only;
 *   - "what can you do" is the palette this turn really has, and a provider
 *     that cannot call tools is said to be one, in the prompt and the UI note;
 *   - each department is offered only its palette, and the dispatcher refuses
 *     anything else, even for OASIS's own workspace (which the generic runner
 *     offers every tool);
 *   - a tool reads only the session workspace's rows, whatever tenant the
 *     model writes into its input, and an own-book member only their leads;
 *   - Gemini function calling round-trips (the model's turn comes back
 *     verbatim, thought signature included).
 *
 * Real libSQL file for the records; the provider is a stubbed global fetch.
 * Run: node --conditions=react-server --import tsx tests/department-desk.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "department-desk-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
delete process.env.LEAD_SCOPING_MODE;
// A credential-shaped env value (lib/secret-redaction.ts snapshots these on
// first use), and one workspace-vault value, planted in workspace data below:
// neither may reach a provider request or the browser.
const ENV_SECRET = "sk-desk-env-secret-0123456789abcdef";
const VAULT_SECRET = "vault-desk-secret-zyxwvutsrqpo";
process.env.DESK_FIXTURE_API_KEY = ENV_SECRET;
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "department-desk-field-key-long-enough-0001";

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});
stub("next/navigation", {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
});

const ACME = "a1a1a1a1-0000-4000-8000-0000000000a1";
const ZETA = "b2b2b2b2-0000-4000-8000-0000000000b2";
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const OWNER = "0e000000-0000-4000-8000-000000000001";
const REP = "0e000000-0000-4000-8000-000000000002";
const OTHER_REP = "0e000000-0000-4000-8000-000000000003";

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

const realError = console.error;
const logged: unknown[][] = [];
console.error = (...args: unknown[]) => void logged.push(args);

type Sent = { url: string; body: Record<string, unknown> };
let sent: Sent[] = [];
let steps: Array<() => Response> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  sent.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
  const next = steps.shift();
  return next ? next() : new Response("no step scripted", { status: 400 });
}) as typeof fetch;
function sse(frames: Array<{ event?: string; data: unknown }>): Response {
  const body = frames.map((f) => `${f.event ? `event: ${f.event}\n` : ""}data: ${typeof f.data === "string" ? f.data : JSON.stringify(f.data)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const finishes: unknown[] = [];
const meter = {
  context: { tenantId: ACME },
  totals: () => ({ calls: 0, costMicroUsd: 0, unknownCostCalls: 0 }),
  begin: async () => ({ finish: async (end: unknown) => void finishes.push(end) }),
};

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tenant_cron_jobs (id TEXT PRIMARY KEY, tenant_id TEXT, agent_key TEXT, name TEXT, description TEXT,
      schedule TEXT, enabled INTEGER, last_run_at TEXT, last_run_status TEXT, created_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT, team_role TEXT,
      full_name TEXT, display_name TEXT);
    CREATE TABLE tenant_integration_credentials (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT,
      service TEXT, field_key TEXT, encrypted_value TEXT, created_at TEXT, updated_at TEXT);
  `);
  // The approvals tables as the migrations write them (and the ledger they mirror into).
  const splitSql = (sql: string) => {
    const out: string[] = [];
    let buf: string[] = [];
    for (const line of sql.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("--")) continue;
      buf.push(line);
      if (t.endsWith(";")) {
        out.push(buf.join("\n").trim().replace(/;$/, ""));
        buf = [];
      }
    }
    if (buf.join("").trim()) out.push(buf.join("\n").trim());
    return out;
  };
  for (const stmt of splitSql(readFileSync(join(process.cwd(), "database/turso/bravo__186_os_approvals.sql"), "utf8"))) await db.execute(stmt);
  await db.executeMultiple(readFileSync(join(process.cwd(), "database/turso/bravo__190_ledger_core.sql"), "utf8"));
  const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const now = new Date().toISOString();
  const lead = (id: string, tenant: string, data: Record<string, unknown>) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data, created_at, updated_at) VALUES (?, ?, 'lead', ?, ?, ?)",
    args: [id, tenant, JSON.stringify(data), now, now],
  });
  await db.batch(
    [
      lead("lead-acme-1", ACME, { name: "Harbor Bakery", company: "Harbor Bakery", stage: "contacted", next_action_at: past, assigned_to: REP }),
      lead("lead-acme-2", ACME, { name: "Northwind Clinic", company: "Northwind Clinic", stage: "new", assigned_to: OTHER_REP }),
      lead("lead-zeta-1", ZETA, { name: "Quillfeather Studio", company: "Quillfeather Studio", stage: "contacted", next_action_at: past }),
      {
        sql: "INSERT INTO tenant_cron_jobs (id, tenant_id, agent_key, name, schedule, enabled, last_run_status, created_at) VALUES ('r1', ?, 'sdr', 'Morning lead sweep', '0 8 * * *', 1, 'success', ?)",
        args: [ACME, now],
      },
      {
        sql: "INSERT INTO tenant_cron_jobs (id, tenant_id, agent_key, name, schedule, enabled, last_run_status, created_at) VALUES ('r2', ?, 'sdr', 'Zeta secret routine', '0 9 * * *', 1, 'error', ?)",
        args: [ZETA, now],
      },
    ],
    "write",
  );

  const { capabilitiesFor } = await import("../lib/role-surfaces");
  const { resolveOsModules } = await import("../lib/os/modules");
  const { OS_DEPARTMENTS } = await import("../lib/os/departments");
  const dept = (key: string) => OS_DEPARTMENTS.find((d) => d.key === key)!;
  type Persona = Parameters<typeof capabilitiesFor>[0];
  const viewerFor = (tenantId: string, slug: string, persona: Persona, userId: string, brand = "Acme Roofing") => ({
    ok: true as const,
    surface: { ok: true as const, persona, capabilities: capabilitiesFor(persona, slug), userId, tenantId, tenantSlug: slug, teamRole: persona === "founder" ? "owner" : "sales", degraded: false },
    navInput: {
      persona,
      capabilities: capabilitiesFor(persona, slug),
      isOperator: false,
      tenantSlug: slug,
      isOasisTenant: false,
      modules: resolveOsModules({ tenantSlug: slug, provisioned: true }),
      provisioned: true,
      founders: null,
    },
    oasis: false,
    provisioned: true,
    manifest: { brand: { name: brand, subtitle: "Roof repair in Ottawa", logo: "default", footer_label: "", footer_tagline: "" }, agents: [], onboarding_industry: "custom" },
    email: "owner@acme.test",
    authUserId: userId,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acmeOwner = viewerFor(ACME, "acme-roofing", "founder", OWNER) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acmeRep = viewerFor(ACME, "acme-roofing", "sales", REP) as any;

  const catalog = await import("../lib/os/desk/catalog");
  const { loadDepartmentState } = await import("../lib/os/desk/state");
  const { renderDepartmentState } = await import("../lib/os/desk/state-render");
  const { deskToolset } = await import("../lib/os/desk/tools");
  const { groundDepartmentTurn } = await import("../lib/os/desk/turn");
  const { streamGeminiWithTools, hasInputs } = await import("../lib/os/desk/gemini-loop");
  const runner = await import("../lib/cloud-tool-runner");

  console.log("The DEPARTMENT STATE block");
  const salesFacts = await loadDepartmentState(acmeOwner, dept("sales"));
  const salesBlock = renderDepartmentState(salesFacts, { on: true, tools: catalog.deskPalette("sales") });
  await check("a Sales turn carries this workspace's pipeline, its past-due follow-up, and the business profile", () => {
    assert.match(salesBlock, /Business: Acme Roofing - Roof repair in Ottawa/);
    assert.match(salesBlock, /Pipeline \(the whole pipeline\), 2 leads: Contacted \[contacted\] 1, New \[new\] 1/);
    assert.match(salesBlock, /Follow-ups past due \(1\): Harbor Bakery \[id lead-acme-1\]/);
    assert.match(salesBlock, /Numbers on the Sales page:\n- Leads: 2/);
  });
  await check("another workspace's leads and routines never reach it", () => {
    assert.doesNotMatch(salesBlock, /Quillfeather|lead-zeta|Zeta secret/);
  });
  await check("it names the department's connections from the Connections catalog", () => {
    assert.match(salesBlock, /Apps the Sales department works through[^\n]*\n- Google Workspace: /);
    assert.match(salesBlock, /\n- Twilio SMS: /);
  });
  await check("the workspace data sits inside one untrusted-data fence, with the guard", () => {
    const begin = salesBlock.indexOf("<<<UNTRUSTED_INPUT_BEGIN>>>");
    const end = salesBlock.indexOf("<<<UNTRUSTED_INPUT_END>>>");
    assert.ok(begin > 0 && end > begin);
    assert.ok(salesBlock.indexOf("Harbor Bakery") > begin && salesBlock.indexOf("Harbor Bakery") < end);
    assert.match(salesBlock, /INPUT BOUNDARY RULES/);
  });
  await check("'what can you do' lists every palette tool by its label, and no persona or internal name", () => {
    for (const t of catalog.deskPalette("sales")) assert.ok(salesBlock.includes(`- ${t.label}: ${t.summary}`), t.name);
    assert.doesNotMatch(salesBlock, /\b(bravo|maven|atlas|aura|hermes|conaugh|turso|supabase)\b/i);
  });
  await check("the block is bounded", () => {
    assert.ok(salesBlock.length < 12_000, String(salesBlock.length));
  });
  await check("Operations lists this workspace's routines only", async () => {
    const ops = renderDepartmentState(await loadDepartmentState(acmeOwner, dept("operations")), { on: true, tools: catalog.deskPalette("operations") });
    assert.match(ops, /Morning lead sweep: on/);
    assert.doesNotMatch(ops, /Zeta secret routine/);
  });
  await check("lookups OFF: the prompt says so and why, and lists no tools as available", () => {
    const off = renderDepartmentState(salesFacts, { on: false, reason: "a test reason", tools: catalog.deskPalette("sales") });
    assert.match(off, /Looking things up is OFF this turn: a test reason/);
    assert.doesNotMatch(off, /Look things up in this workspace \(/);
  });

  console.log("Palettes");
  await check("each department's palette is its own; Marketing and Finance cannot propose emails; plan mode proposes nothing", () => {
    assert.deepEqual(catalog.deskPalette("finance").map((t) => t.name), ["department_numbers", "finance_get_metric", "approvals_list", "connections_status"]);
    assert.ok(!catalog.deskPalette("marketing").some((t) => t.kind === "proposal"));
    assert.ok(catalog.deskPalette("sales").some((t) => t.name === "propose_email"));
    assert.ok(!catalog.deskPalette("sales", { planMode: true }).some((t) => t.kind === "proposal"));
    for (const t of Object.values(catalog.DESK_TOOLS)) assert.ok(t.kind === "read" || t.name === "propose_email", t.name);
  });
  await check("providers: Anthropic, OpenAI, OpenRouter and Gemini look things up; a local model says it cannot", () => {
    for (const p of ["anthropic", "openai", "openrouter", "google"]) assert.equal(catalog.deskToolSupport(p).on, true, p);
    const local = catalog.deskToolSupport("ollama");
    assert.equal(local.on, false);
    assert.match((local as { reason: string }).reason, /local model, which cannot look things up/);
  });

  console.log("Tools: tenant and palette at dispatch");
  const salesTools = deskToolset({ viewer: acmeOwner, dept: dept("sales"), agentSlug: "sdr" });
  await check("leads_search reads the session workspace only, whatever tenant the model writes", async () => {
    const r = await salesTools.execute("leads_search", { tenant_id: ZETA, tenantId: ZETA, limit: 15 });
    assert.equal(r.is_error, false, r.content);
    const names = (JSON.parse(r.content).leads as Array<{ name: string }>).map((l) => l.name).sort();
    assert.deepEqual(names, ["Harbor Bakery", "Northwind Clinic"]);
  });
  await check("lead_timeline will not open another workspace's lead", async () => {
    const r = await salesTools.execute("lead_timeline", { lead_id: "lead-zeta-1" });
    assert.equal(r.is_error, true);
    assert.match(r.content, /lead_not_found/);
    assert.doesNotMatch(r.content, /Quillfeather/);
  });
  await check("a tool outside the department's palette is refused at dispatch", async () => {
    const r = await salesTools.execute("routines_status", {});
    assert.equal(r.is_error, true);
    assert.match(r.content, /tool_not_in_this_department/);
    const credential = await salesTools.execute("get_credential", { service: "stripe" });
    assert.match(credential.content, /tool_not_in_this_department/);
  });
  await check("an own-book member finds only their own leads, and cannot open a colleague's", async () => {
    assert.equal(acmeRep.surface.capabilities.canSeeOwnPipelineOnly || acmeRep.surface.capabilities.canSeeAllPipeline, true);
    const tools = deskToolset({ viewer: acmeRep, dept: dept("sales"), agentSlug: "sdr" });
    const r = await tools.execute("leads_search", {});
    const names = (JSON.parse(r.content).leads as Array<{ name: string }>).map((l) => l.name);
    if (!acmeRep.surface.capabilities.canSeeAllPipeline) {
      assert.deepEqual(names, ["Harbor Bakery"]);
      const other = await tools.execute("lead_timeline", { lead_id: "lead-acme-2" });
      assert.match(other.content, /lead_not_found/);
    }
  });
  await check("company money is refused outside OASIS's Finance gate", async () => {
    const fin = deskToolset({ viewer: acmeOwner, dept: dept("finance"), agentSlug: "x" });
    const r = await fin.execute("finance_get_metric", {});
    assert.match(r.content, /company_money_not_available_to_you/);
  });

  console.log("Tool loops offer the palette and nothing else");
  await check("Anthropic: the request offers exactly the palette (even for OASIS's own workspace) and an off-palette call never runs", async () => {
    sent = [];
    steps = [
      () =>
        sse([
          { event: "message_start", data: { message: { usage: { input_tokens: 10 } } } },
          { event: "content_block_start", data: { index: 0, content_block: { type: "tool_use", id: "t1", name: "get_credential" } } },
          { event: "content_block_delta", data: { index: 0, delta: { type: "input_json_delta", partial_json: "{}" } } },
          { event: "content_block_stop", data: { index: 0 } },
          { event: "content_block_start", data: { index: 1, content_block: { type: "tool_use", id: "t2", name: "leads_search" } } },
          { event: "content_block_delta", data: { index: 1, delta: { type: "input_json_delta", partial_json: "{\"query\":\"Harbor\"}" } } },
          { event: "content_block_stop", data: { index: 1 } },
          { event: "message_delta", data: { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } },
          { event: "message_stop", data: {} },
        ]),
      () =>
        sse([
          { event: "message_start", data: { message: { usage: { input_tokens: 20 } } } },
          { event: "content_block_start", data: { index: 0, content_block: { type: "text" } } },
          { event: "content_block_delta", data: { index: 0, delta: { type: "text_delta", text: "Harbor Bakery is past due." } } },
          { event: "content_block_stop", data: { index: 0 } },
          { event: "message_delta", data: { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } } },
          { event: "message_stop", data: {} },
        ]),
    ];
    const events: Array<{ type: string; name?: string; ok?: boolean }> = [];
    const ctx = { tenantId: OASIS, userId: OWNER, agentKey: "bravo", authUserId: OWNER, isAdmin: true };
    for await (const ev of runner.streamAnthropicWithTools(
      { apiKey: "k", model: "claude-sonnet-4-5", system: "s", messages: [{ role: "user", content: "pipeline?" }], maxTokens: 512, meter: meter as never, toolset: salesTools },
      ctx,
    )) events.push(ev as never);
    const offered = (sent[0].body.tools as Array<{ name: string }>).map((t) => t.name);
    assert.deepEqual(offered, catalog.deskPalette("sales").map((t) => t.name));
    assert.ok(events.some((e) => e.type === "tool_result" && e.name === "get_credential" && e.ok === false));
    assert.ok(!events.some((e) => e.type === "tool_use" && e.name === "get_credential"));
    // The allowed call ran on the toolset and its result went back to the model.
    const second = JSON.stringify(sent[1].body.messages);
    assert.match(second, /Harbor Bakery/);
    assert.doesNotMatch(second, /Quillfeather/);
  });
  await check("OpenAI-compatible: the request offers exactly the palette", async () => {
    sent = [];
    steps = [
      () => sse([{ data: { choices: [{ delta: { content: "Hello." }, finish_reason: "stop" }] } }, { data: { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } } }, { data: "[DONE]" }]),
    ];
    for await (const _ of runner.streamOpenAICompatibleWithTools(
      { provider: "openrouter", apiKey: "k", model: "openai/gpt-5.4", system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 256, meter: meter as never, toolset: salesTools },
      { tenantId: OASIS, userId: OWNER, agentKey: "bravo", authUserId: OWNER, isAdmin: true },
    )) void _;
    const offered = (sent[0].body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    assert.deepEqual(offered, catalog.deskPalette("sales").map((t) => t.name));
  });

  console.log("Gemini function calling");
  await check("a Gemini turn calls a tool, sends the model's turn back verbatim with its signature, and answers", async () => {
    sent = [];
    finishes.length = 0;
    steps = [
      () =>
        sse([
          {
            data: {
              candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "leads_search", args: { query: "Harbor" } }, thoughtSignature: "sig-123" }] }, finishReason: "STOP" }],
              usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5 },
            },
          },
        ]),
      () =>
        sse([
          {
            data: {
              candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "routines_status", args: {} } }] }, finishReason: "STOP" }],
              usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 4 },
            },
          },
        ]),
      () =>
        sse([
          { data: { candidates: [{ content: { role: "model", parts: [{ text: "Harbor Bakery needs a follow-up." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 9 } } },
        ]),
    ];
    const events: Array<Record<string, unknown>> = [];
    for await (const ev of streamGeminiWithTools({
      apiKey: "k",
      model: "gemini-3.8-flash",
      system: "sys",
      messages: [{ role: "user", content: "Who should I follow up with?" }],
      maxTokens: 512,
      meter: meter as never,
      toolset: salesTools,
    })) events.push(ev as never);
    assert.equal(sent.length, 3);
    const decl = ((sent[0].body.tools as Array<{ functionDeclarations: Array<{ name: string }> }>)[0].functionDeclarations).map((d) => d.name);
    assert.deepEqual(decl, catalog.deskPalette("sales").map((t) => t.name));
    // Gemini 400s on an OBJECT schema with no properties: a tool with no
    // input is declared without `parameters`, every other tool keeps them.
    for (const d of (sent[0].body.tools as Array<{ functionDeclarations: Array<{ parameters?: { properties?: object } }> }>)[0].functionDeclarations) {
      if (d.parameters) assert.ok(Object.keys(d.parameters.properties ?? {}).length > 0, "no empty OBJECT schema reaches Gemini");
    }
    assert.equal(hasInputs({ type: "object", properties: {} }), false);
    assert.equal(hasInputs({ type: "object", properties: { q: { type: "string" } } }), true);
    const contents2 = sent[1].body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    assert.deepEqual(contents2[1], { role: "model", parts: [{ functionCall: { name: "leads_search", args: { query: "Harbor" } }, thoughtSignature: "sig-123" }] });
    const resp = contents2[2].parts[0].functionResponse as { name: string; response: { leads: Array<{ name: string }> } };
    assert.equal(resp.name, "leads_search");
    assert.deepEqual(resp.response.leads.map((l) => l.name), ["Harbor Bakery"]);
    // The off-palette call was answered with a refusal and never ran.
    const contents3 = sent[2].body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    assert.match(JSON.stringify(contents3[4]), /tool_not_in_this_department/);
    assert.ok(!events.some((e) => e.type === "tool_use" && e.name === "routines_status"));
    assert.ok(events.some((e) => e.type === "delta" && e.text === "Harbor Bakery needs a follow-up."));
    assert.deepEqual(events.at(-1), { type: "done", inputTokens: 190, outputTokens: 18, unreportedCalls: 0 });
    assert.equal(finishes.length, 3, "one metered call per request");
  });
  await check("the ledger: every Gemini request of a tool turn is one ai_usage_events row for this workspace and department, thinking included", async () => {
    await db.executeMultiple(readFileSync(join(process.cwd(), "database/turso/bravo__192_ai_usage.sql"), "utf8"));
    const usage = await import("../lib/ai/usage");
    const real = usage.modelCallMeter({ tenantId: ACME, surface: "agents.chat", ...usage.billingForKey("google", "tenant"), departmentKey: "sales", teammateId: "sdr", userId: OWNER, jobId: null });
    steps = [
      () => sse([{ data: { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "pipeline_summary", args: {} } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 3, thoughtsTokenCount: 10 } } }]),
      () => sse([{ data: { candidates: [{ content: { role: "model", parts: [{ text: "Two leads." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 70, candidatesTokenCount: 4 } } }]),
    ];
    for await (const _ of streamGeminiWithTools({ apiKey: "k", model: "gemini-3.8-flash", system: "s", messages: [{ role: "user", content: "pipeline?" }], maxTokens: 256, meter: real, toolset: salesTools })) void _;
    const rows = (await db.execute({ sql: "SELECT tenant_id, provider, department_key, input_tokens, output_tokens, outcome FROM ai_usage_events ORDER BY occurred_at, id" })).rows;
    assert.deepEqual(
      rows.map((r) => [r.tenant_id, r.provider, r.department_key, Number(r.input_tokens), Number(r.output_tokens), r.outcome]),
      [
        [ACME, "google", "sales", 40, 13, "ok"],
        [ACME, "google", "sales", 70, 4, "ok"],
      ],
    );
  });
  await check("a Gemini turn that ends with no text is a failed turn, never an empty success", async () => {
    sent = [];
    steps = [() => sse([{ data: { candidates: [{ content: { role: "model", parts: [] }, finishReason: "MAX_TOKENS" }], usageMetadata: { promptTokenCount: 5, thoughtsTokenCount: 500 } } }])];
    const events: Array<Record<string, unknown>> = [];
    for await (const ev of streamGeminiWithTools({ apiKey: "k", model: "gemini-3.8-flash", system: "s", messages: [{ role: "user", content: "x" }], maxTokens: 64, meter: meter as never, toolset: salesTools })) events.push(ev as never);
    assert.deepEqual(events.at(-1), { type: "error", message: "empty_reply:thinking" });
  });

  await check("a Gemini tool step that reports 0 output tokens is NOT recorded as 0: it called a tool, so it is not an empty reply (the health check would page on it)", async () => {
    await db.execute("DELETE FROM ai_usage_events");
    const usage = await import("../lib/ai/usage");
    const real = usage.modelCallMeter({ tenantId: ACME, surface: "agents.chat", ...usage.billingForKey("google", "tenant"), departmentKey: "sales", teammateId: "sdr", userId: OWNER, jobId: null });
    steps = [
      // A functionCall-only step; the usage block leaves the function call out of the count (no candidatesTokenCount, thoughts 0).
      () => sse([{ data: { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "pipeline_summary", args: {} } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 40, thoughtsTokenCount: 0 } } }]),
      () => sse([{ data: { candidates: [{ content: { role: "model", parts: [{ text: "Two leads." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 70, candidatesTokenCount: 4 } } }]),
    ];
    const events: Array<Record<string, unknown>> = [];
    for await (const ev of streamGeminiWithTools({ apiKey: "k", model: "gemini-3.8-flash", system: "s", messages: [{ role: "user", content: "pipeline?" }], maxTokens: 256, meter: real, toolset: salesTools })) events.push(ev as never);
    assert.equal(events.at(-1)?.type, "done", "the turn answered");
    const rows = (await db.execute("SELECT outcome, input_tokens, output_tokens FROM ai_usage_events ORDER BY occurred_at, id")).rows;
    assert.deepEqual(rows.map((r) => [r.outcome, r.output_tokens === null ? null : Number(r.output_tokens)]), [["ok", null], ["ok", 4]], "the tool step's output is unknown, never 0; the answer step keeps its count");
    assert.ok(!rows.some((r) => r.outcome === "ok" && r.output_tokens !== null && Number(r.output_tokens) === 0), "no ok row with 0 output");
  });

  console.log("Grounding a turn");
  const baseTurn = (provider: string, tenantId = ACME) => ({
    tenantId,
    agentSlug: "sdr",
    department: dept("sales"),
    provider: provider as never,
    model: "m",
    apiKey: "k",
    system: "PERSONA",
    meter: meter as never,
  });
  const plainCalls: string[] = [];
  const plainStream = async function* (t: { system: string }) {
    plainCalls.push(t.system);
    yield { type: "delta" as const, text: "plain" };
    yield { type: "done" as const, inputTokens: 1, outputTokens: 1 };
  };
  await check("a local-model account: the state is there, lookups are off, and the prompt and the UI note say why", async () => {
    const g = await groundDepartmentTurn({ turn: baseTurn("ollama"), viewer: acmeOwner, maxTokens: 256, plainStream });
    assert.ok(g);
    assert.match(g.system, /^PERSONA/);
    assert.match(g.system, /Harbor Bakery/);
    assert.match(g.system, /Looking things up is OFF this turn: this workspace's AI account runs on a local model/);
    assert.equal(g.tools.on, false);
    assert.match(String(g.tools.note), /Looking things up is off: this workspace's AI account runs on a local model/);
    plainCalls.length = 0;
    for await (const _ of g.stream([{ role: "user", content: "hi" }])) void _;
    assert.equal(plainCalls.length, 1);
    assert.match(plainCalls[0], /DEPARTMENT STATE/);
  });
  await check("a hosted engine that is not the API keeps the plain stream", async () => {
    const g = await groundDepartmentTurn({ turn: { ...baseTurn("google"), engine: { kind: "cli" } }, viewer: acmeOwner, maxTokens: 256, plainStream });
    assert.equal(g?.tools.on, false);
  });
  await check("a Gemini account: lookups on, labelled by the palette", async () => {
    const g = await groundDepartmentTurn({ turn: baseTurn("google"), viewer: acmeOwner, maxTokens: 256, plainStream });
    assert.equal(g?.tools.on, true);
    assert.deepEqual(g?.tools.labels, catalog.deskPalette("sales").map((t) => t.label));
    assert.match(String(g?.system), /Look things up in this workspace \(7 tools/);
  });
  await check("a viewer in ANOTHER workspace than the turn's gets no workspace data at all", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const zetaViewer = viewerFor(ZETA, "zeta-dental", "founder", OWNER, "Zeta Dental") as any;
    const g = await groundDepartmentTurn({ turn: baseTurn("google", ACME), viewer: zetaViewer, maxTokens: 256, plainStream });
    assert.equal(g?.tools.on, false);
    assert.doesNotMatch(String(g?.system), /Harbor Bakery|Quillfeather|Zeta Dental/);
    assert.match(String(g?.system), /could not confirm which workspace/);
  });
  await check("a signed-out or unreadable viewer gets no workspace data either", async () => {
    const g = await groundDepartmentTurn({ turn: baseTurn("google"), viewer: { ok: false, reason: "degraded" }, maxTokens: 256, plainStream });
    assert.equal(g?.tools.on, false);
    assert.doesNotMatch(String(g?.system), /Harbor Bakery/);
  });

  console.log("Drafts: who may propose, and whose draft a revision may replace");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acmeOtherRep = viewerFor(ACME, "acme-roofing", "sales", OTHER_REP) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acmeReadOnly = viewerFor(ACME, "acme-roofing", "readonly", "0e000000-0000-4000-8000-000000000009") as any;
  const draft = (extra: Record<string, unknown> = {}) => ({ to: "lee@harbor.test", subject: "Following up", body: "Hi Lee, checking in.", ...extra });
  const pendingCards = async () =>
    (await db.execute("SELECT id, status, idempotency_key FROM approvals ORDER BY created_at, id")).rows.map((r) => ({ id: String(r.id), status: String(r.status), key: String(r.idempotency_key) }));
  let repCardId = "";
  await check("a rep's draft is one pending card, owned by that rep", async () => {
    assert.equal(acmeRep.surface.capabilities.canAct, true);
    const r = await deskToolset({ viewer: acmeRep, dept: dept("sales"), agentSlug: "sdr" }).execute("propose_email", draft());
    assert.equal(r.is_error, false, r.content);
    repCardId = JSON.parse(r.content).approval_id;
    const card = (await pendingCards()).find((c) => c.id === repCardId);
    assert.equal(card?.status, "pending");
    assert.ok(card?.key.startsWith(`desk:${REP}:`), card?.key);
  });
  await check("a read-only member is never offered a draft, and cannot create or revise one when it runs", async () => {
    assert.equal(acmeReadOnly.surface.capabilities.canAct, false);
    const tools = deskToolset({ viewer: acmeReadOnly, dept: dept("client_success"), agentSlug: "customer-support" });
    assert.ok(!tools.tools.some((t) => t.name === "propose_email"));
    const before = (await pendingCards()).length;
    const create = await tools.execute("propose_email", draft({ subject: "From read-only" }));
    const revise = await tools.execute("propose_email", draft({ subject: "Replaced", revises_approval_id: repCardId }));
    assert.equal(create.is_error, true);
    assert.equal(revise.is_error, true);
    assert.equal((await pendingCards()).length, before);
    assert.equal((await pendingCards()).find((c) => c.id === repCardId)?.status, "pending");
  });
  await check("a member whose role lost 'act' mid-turn is refused when the draft runs, not only when it is offered", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = viewerFor(ACME, "acme-roofing", "sales", REP) as any;
    v.surface = { ...v.surface, capabilities: { ...v.surface.capabilities } };
    const tools = deskToolset({ viewer: v, dept: dept("sales"), agentSlug: "sdr" });
    assert.ok(tools.tools.some((t) => t.name === "propose_email"));
    v.surface.capabilities.canAct = false;
    const before = (await pendingCards()).length;
    const r = await tools.execute("propose_email", draft({ subject: "Too late" }));
    assert.equal(JSON.parse(r.content).error, "read_only_member_cannot_propose");
    assert.equal((await pendingCards()).length, before);
  });
  await check("the draft function itself refuses a member who may not act, whoever calls it", async () => {
    const { proposeDeskEmail } = await import("../lib/os/desk/proposals");
    const before = (await pendingCards()).length;
    await assert.rejects(() => proposeDeskEmail(acmeReadOnly, dept("client_success"), "customer-support", draft({ subject: "Direct" }), new Date()), /proposer_may_not_act/);
    assert.equal((await pendingCards()).length, before);
  });
  await check("another rep on the same Sales agent cannot replace that rep's pending draft", async () => {
    const r = await deskToolset({ viewer: acmeOtherRep, dept: dept("sales"), agentSlug: "sdr" }).execute("propose_email", draft({ subject: "Hijack", revises_approval_id: repCardId }));
    assert.equal(r.is_error, true);
    assert.match(r.content, /supersedes_not_yours/);
    assert.equal((await pendingCards()).find((c) => c.id === repCardId)?.status, "pending");
  });
  await check("another rep's approvals list and summary never show that rep's draft; the rep's own do", async () => {
    const other = await deskToolset({ viewer: acmeOtherRep, dept: dept("sales"), agentSlug: "sdr" }).execute("approvals_list", {});
    assert.doesNotMatch(other.content, new RegExp(repCardId));
    assert.equal(JSON.parse(other.content).waiting, 0);
    const own = await deskToolset({ viewer: acmeRep, dept: dept("sales"), agentSlug: "sdr" }).execute("approvals_list", {});
    assert.match(own.content, new RegExp(repCardId));
    const otherState = renderDepartmentState(await loadDepartmentState(acmeOtherRep, dept("sales")), { on: true, tools: catalog.deskPalette("sales") });
    assert.match(otherState, /Drafts this person proposed, still waiting: 0/);
    assert.doesNotMatch(otherState, /Following up/);
  });
  await check("the rep revises their own draft; an owner may revise it too", async () => {
    const own = await deskToolset({ viewer: acmeRep, dept: dept("sales"), agentSlug: "sdr" }).execute("propose_email", draft({ subject: "Following up, v2", revises_approval_id: repCardId }));
    assert.equal(own.is_error, false, own.content);
    const v2 = JSON.parse(own.content).approval_id;
    const byOwner = await deskToolset({ viewer: acmeOwner, dept: dept("sales"), agentSlug: "sdr" }).execute("propose_email", draft({ subject: "Following up, v3", revises_approval_id: v2 }));
    assert.equal(byOwner.is_error, false, byOwner.content);
  });

  console.log("Secrets never reach the provider or the browser");
  await check("env and workspace-vault secrets in workspace data are scrubbed from the prompt, every tool result and the reply", async () => {
    await db.execute({
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data, created_at, updated_at) VALUES ('lead-acme-secret', ?, 'lead', ?, ?, ?)",
      args: [ACME, JSON.stringify({ name: `Secretive Co ${ENV_SECRET}`, company: `Vaulted ${VAULT_SECRET}`, stage: "contacted", next_action_at: past }), now, now],
    });
    sent = [];
    steps = [
      () => sse([{ data: { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "leads_search", args: { query: "Secretive" } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } } }]),
      () =>
        sse([
          { data: { candidates: [{ content: { role: "model", parts: [{ text: `The key is ${ENV_SECRET.slice(0, 10)}` }] } }] } },
          { data: { candidates: [{ content: { role: "model", parts: [{ text: `${ENV_SECRET.slice(10)} and ${VAULT_SECRET}.` }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2 } } },
        ]),
    ];
    const g = await groundDepartmentTurn({
      turn: baseTurn("google"),
      viewer: acmeOwner,
      maxTokens: 256,
      plainStream,
      loadVault: async () => [{ key: "ACME_VAULT", value: VAULT_SECRET }],
    });
    assert.ok(g);
    const browser: string[] = [];
    let replyText = "";
    for await (const ev of g.stream([{ role: "user", content: "Any secrets?" }])) {
      browser.push(JSON.stringify(ev));
      if (ev.type === "delta") replyText += ev.text;
    }
    const requests = JSON.stringify(sent.map((s) => s.body));
    assert.equal(sent.length, 2);
    for (const secret of [ENV_SECRET, VAULT_SECRET]) {
      assert.ok(!g.system.includes(secret), "prompt");
      assert.ok(!requests.includes(secret), "provider request");
      assert.ok(!browser.join("").includes(secret), "browser events");
    }
    assert.match(requests, /\[REDACTED:DESK_FIXTURE_API_KEY\]/);
    assert.match(requests, /\[REDACTED:ACME_VAULT\]/);
    assert.ok(!replyText.includes(ENV_SECRET) && !replyText.includes(VAULT_SECRET));
    assert.match(replyText, /The key is \[REDACTED:DESK_FIXTURE_API_KEY\] and \[REDACTED:ACME_VAULT\]\./);
    await db.execute("DELETE FROM tenant_records WHERE id = 'lead-acme-secret'");
  });
  await check("a vault read that fails sends no workspace data at all", async () => {
    const g = await groundDepartmentTurn({
      turn: baseTurn("google"),
      viewer: acmeOwner,
      maxTokens: 256,
      plainStream,
      loadVault: async () => {
        throw new Error("vault down");
      },
    });
    assert.equal(g?.tools.on, false);
    assert.doesNotMatch(String(g?.system), /Harbor Bakery/);
  });

  await check("the production vault reader: a stored secret is read and scrubbed", async () => {
    const { encryptField } = await import("../lib/field-encryption");
    await db.execute({
      sql: "INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value) VALUES (?, 'custom', 'acme_vault', ?)",
      args: [ACME, encryptField(VAULT_SECRET)],
    });
    await db.execute({
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data, created_at, updated_at) VALUES ('lead-acme-vault', ?, 'lead', ?, ?, ?)",
      args: [ACME, JSON.stringify({ name: `Vault Lead ${VAULT_SECRET}`, stage: "contacted", next_action_at: past }), now, now],
    });
    const g = await groundDepartmentTurn({ turn: baseTurn("google"), viewer: acmeOwner, maxTokens: 256, plainStream });
    assert.equal(g?.tools.on, true);
    assert.ok(!String(g?.system).includes(VAULT_SECRET));
    assert.match(String(g?.system), /Vault Lead \[REDACTED:ACME_VAULT\]/);
  });
  await check("a vault read that ANSWERS an error (not a throw) sends no workspace data", async () => {
    const { fetchTenantVaultSecretsForRedaction } = await import("../lib/chat-persistence");
    await db.execute("ALTER TABLE tenant_integration_credentials RENAME TO tic_unavailable");
    try {
      await assert.rejects(() => fetchTenantVaultSecretsForRedaction(ACME), /vault_read_failed/);
      const g = await groundDepartmentTurn({ turn: baseTurn("google"), viewer: acmeOwner, maxTokens: 256, plainStream });
      assert.equal(g?.tools.on, false);
      assert.doesNotMatch(String(g?.system), /Harbor Bakery|Vault Lead/);
    } finally {
      await db.execute("ALTER TABLE tic_unavailable RENAME TO tenant_integration_credentials");
      await db.execute("DELETE FROM tenant_records WHERE id = 'lead-acme-vault'");
    }
  });

  await check("a vault entry that cannot be decrypted sends no workspace data (a partial scrub is not sent)", async () => {
    const { fetchTenantVaultSecretsForRedaction } = await import("../lib/chat-persistence");
    const { encryptField } = await import("../lib/field-encryption");
    await db.execute({
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data, created_at, updated_at) VALUES ('lead-acme-vault2', ?, 'lead', ?, ?, ?)",
      args: [ACME, JSON.stringify({ name: `Vault Lead ${VAULT_SECRET}`, stage: "contacted", next_action_at: past }), now, now],
    });
    // One good entry, one whose ciphertext is corrupt.
    await db.execute({
      sql: "INSERT INTO tenant_integration_credentials (id, tenant_id, service, field_key, encrypted_value) VALUES ('corrupt-1', ?, 'custom', 'broken_key', ?)",
      args: [ACME, `${encryptField("another-secret-value-123").slice(0, -6)}XXXXXX`],
    });
    try {
      // The chat routes' lenient read still answers the entries it can decrypt.
      assert.ok((await fetchTenantVaultSecretsForRedaction(ACME)).some((s) => s.value === VAULT_SECRET));
      await assert.rejects(() => fetchTenantVaultSecretsForRedaction(ACME, { requireComplete: true }), /vault_incomplete/);
      sent = [];
      const g = await groundDepartmentTurn({ turn: baseTurn("google"), viewer: acmeOwner, maxTokens: 256, plainStream });
      assert.equal(g?.tools.on, false);
      assert.doesNotMatch(String(g?.system), /Harbor Bakery|Vault Lead|REDACTED:ACME_VAULT/);
      assert.equal(sent.length, 0, "no provider request was built from workspace data");
    } finally {
      await db.execute("DELETE FROM tenant_integration_credentials WHERE id = 'corrupt-1'");
      await db.execute("DELETE FROM tenant_records WHERE id = 'lead-acme-vault2'");
    }
  });

  console.log("Routines are the Operations page's data");
  await check("Chief of Staff offers routines to an owner, and returns them", async () => {
    const tools = deskToolset({ viewer: acmeOwner, dept: dept("chief_of_staff"), agentSlug: "cos" });
    assert.ok(tools.tools.some((t) => t.name === "routines_status"));
    const r = await tools.execute("routines_status", {});
    assert.match(r.content, /Morning lead sweep/);
  });
  await check("Chief of Staff never offers routines to a sales member or a read-only member, and refuses them", async () => {
    for (const v of [acmeRep, acmeReadOnly]) {
      const tools = deskToolset({ viewer: v, dept: dept("chief_of_staff"), agentSlug: "cos" });
      assert.ok(!tools.tools.some((t) => t.name === "routines_status"), v.surface.persona);
      const r = await tools.execute("routines_status", {});
      assert.equal(r.is_error, true);
      assert.doesNotMatch(r.content, /Morning lead sweep/);
    }
  });
  await check("the routines handler itself checks the Operations gate (a role changed mid-turn)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = viewerFor(ACME, "acme-roofing", "founder", OWNER) as any;
    const tools = deskToolset({ viewer: v, dept: dept("chief_of_staff"), agentSlug: "cos" });
    assert.ok(tools.tools.some((t) => t.name === "routines_status"));
    v.navInput = acmeRep.navInput;
    const r = await tools.execute("routines_status", {});
    assert.equal(JSON.parse(r.content).error, "routines_not_available_to_you");
  });

  console.log("Wiring");
  await check("the chat route grounds department turns from the session viewer and relays lookups as plain labels", () => {
    const src = readFileSync(join(process.cwd(), "app/api/agents/chat/route.ts"), "utf8");
    assert.match(src, /groundDepartmentTurn\(\{\s*turn: t,\s*viewer: await resolveOsViewer\(\)/);
    assert.match(src, /desk \? desk\.stream\(incoming\)/);
    assert.match(src, /send\("tool", \{ phase: ev\.phase, label: ev\.label, ok: ev\.ok \}\)/);
  });
  await check("the channel shows why lookups are off, and nothing when they are on", async () => {
    const { deskToolsNote } = catalog;
    const chat = readFileSync(join(process.cwd(), "components/agents/AgentChat.tsx"), "utf8");
    assert.match(chat, /setToolsNote\(deskToolsNote\(\(payload as \{ tools\?: unknown \}\)\.tools\)\)/);
    assert.match(chat, /eventName === "tool"/);
    assert.equal(deskToolsNote({ on: true, labels: ["Leads"], note: null }), null);
    assert.equal(deskToolsNote({ on: false, labels: [], note: "Looking things up is off: x." }), "Looking things up is off: x.");
    assert.equal(deskToolsNote(undefined), null);
  });

  console.error = realError;
  if (failures > 0) {
    for (const l of logged.slice(-12)) realError(...l);
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("department desk tests passed");
}

main().catch((error) => {
  console.error = realError;
  console.error(error);
  for (const l of logged.slice(-12)) realError(...l);
  process.exit(1);
});
