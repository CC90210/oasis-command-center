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
  `);
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
  const { streamGeminiWithTools } = await import("../lib/os/desk/gemini-loop");
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
