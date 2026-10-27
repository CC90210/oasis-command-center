/**
 * tests/agent-access.test.ts - which agents may use a custom key or an app.
 *
 * CC, 2026-10-26: a custom credential is set up for the agents that need it,
 * and the built-in apps come with the agents we know they serve. Pins, each
 * through the real code on a real libSQL file with the real encryption:
 *
 *   1. The rules (lib/os/agent-access.ts): "all" or departments, unknown names
 *      refused, a full list collapses to "all"; an app suggests its catalog
 *      departments plus the Chief of Staff; refusals say what to do.
 *   2. The store: a choice saves, reads back, and saving the default clears it.
 *      An unreadable choice refuses only its own key or app (review of #743);
 *      a read that fails outright refuses everything.
 *   3. The two chat loops, with only the network stubbed: the tools[] the model
 *      is sent leaves out an app's tools for an agent not given the app, and
 *      keeps them for one that was (send_sms is Quo's).
 *   4. executeTool refuses an app tool anyway; get_credential refuses a key the
 *      agent was not given; add_credential cannot overwrite one either.
 *   5. The routes, with the session stood in: 401 and 403, an unknown app, bad
 *      agents, a key rotated without its agents keeps them, delete drops them,
 *      and an unreadable choice can be saved again.
 *   6. APP_TOOLS is whole (every credential read in the runner is mapped), and
 *      the picker toggles back to "All agents".
 *
 * Run: node --conditions=react-server --import tsx tests/agent-access.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "agent-access-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "agent-access-test-field-encryption-passphrase";

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

// The routes ask lib/api-auth who is signed in; the test decides (stood in before the routes load).
const OWNER = { ok: true, userId: "u-owner", profileId: "p-owner", tenantId: OASIS, email: null, teamRole: "owner", isAdmin: true, isTrueAdmin: true };
let session: Record<string, unknown> = OWNER;
async function standInForSession() {
  const realAuth = (await import("../lib/api-auth")) as Record<string, unknown>;
  const p = require.resolve("../lib/api-auth");
  require.cache[p] = {
    id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [],
    exports: { ...realAuth, resolveSessionContext: async () => session },
  } as unknown as NodeModule;
  // The routes name the agents from the signed-in viewer's workspace
  // (lib/os/agent-access-names-session.ts); the test decides who that is, so the
  // real viewer (cookies) never runs. next/navigation is stood in the way
  // tests/one-agent-roster.test.ts does: its client build needs React's client half.
  const n = require.resolve("next/navigation");
  require.cache[n] = {
    id: n, filename: n, path: dirname(n), loaded: true, children: [], paths: [],
    exports: {
      redirect: (url: string) => {
        throw new Error(`NEXT_REDIRECT;${url}`);
      },
      notFound: () => {
        throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
      },
    },
  } as unknown as NodeModule;
  const v = require.resolve("../components/os/department/viewer");
  require.cache[v] = {
    id: v, filename: v, path: dirname(v), loaded: true, children: [], paths: [],
    exports: {
      resolveOsViewer: async () => {
        if (viewer instanceof Error) throw viewer;
        return viewer;
      },
    },
  } as unknown as NodeModule;
}
const FOUNDER_VIEWER = {
  ok: true, oasis: true, manifest: null,
  surface: { ok: true, persona: "founder", tenantId: OASIS, tenantSlug: "oasis", userId: "u-owner", teamRole: "owner", degraded: false },
};
let viewer: Record<string, unknown> | Error = FOUNDER_VIEWER;

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
  console.log("agent access:");
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(readFileSync(join(root, "database", "turso", "bravo__192_ai_usage.sql"), "utf8"));
  await db.executeMultiple(`
    CREATE TABLE "tenant_integration_credentials" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      "tenant_id" TEXT NOT NULL, "service" TEXT NOT NULL, "field_key" TEXT NOT NULL,
      "encrypted_value" TEXT NOT NULL, "last_tested_at" TEXT, "last_test_ok" INTEGER, "last_test_error" TEXT,
      "created_by" TEXT,
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY ("id"));
    CREATE UNIQUE INDEX "tic_key" ON "tenant_integration_credentials" (tenant_id, service, field_key);
  `);
  const rules = await import("../lib/os/agent-access");
  const store = await import("../lib/os/agent-access-store");
  const runner = await import("../lib/cloud-tool-runner");
  const { modelCallMeter } = await import("../lib/ai/usage");
  const { CONNECTOR_CATALOG } = await import("../lib/os/connectors");
  const { setTenantIntegrationValue, VAULT_CUSTOM_SERVICE } = await import("../lib/tenant-integration-store");
  await standInForSession();
  const customRoute = await import("../app/api/credentials/custom/route");
  const agentsRoute = await import("../app/api/connections/agents/route");
  const ctx = (agentKey: string) => ({ tenantId: OASIS, userId: "u1", agentKey, authUserId: "a1", isAdmin: true });
  const accessRows = async () =>
    (await db.execute({ sql: "SELECT field_key FROM tenant_integration_credentials WHERE tenant_id = ? AND service = 'agent_access' ORDER BY field_key", args: [OASIS] })).rows.map((r) => String(r.field_key));
  const json = (body: unknown, method = "POST") =>
    new Request("https://oasisai.work/api", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as never;
  const realFetch = globalThis.fetch;

  await check("the rules: departments in rail order, typos refused, a full list is all agents, refusals say what to do", () => {
    assert.equal(rules.normalizeAgentAccess("all"), "all");
    assert.deepEqual(rules.normalizeAgentAccess(["finance", "sales", "sales"]), ["sales", "finance"]);
    assert.deepEqual(rules.normalizeAgentAccess([]), [], "no agents is a choice");
    assert.equal(rules.normalizeAgentAccess(["sales", "salse"]), null, "a typo is refused, not dropped");
    assert.equal(rules.normalizeAgentAccess("sales"), null);
    assert.deepEqual(rules.parseAgentAccess('["marketing","sales"]'), ["sales", "marketing"]);
    assert.equal(rules.parseAgentAccess("not json"), null);
    assert.equal(rules.collapseToAll(rules.AGENT_CHOICES.map((c) => c.key)), "all");
    assert.deepEqual(rules.collapseToAll(["sales"]), ["sales"]);
    assert.equal(rules.accessAllows("all", null), true, "every agent, even one with no department");
    assert.equal(rules.accessAllows(["sales"], null), false);
    assert.equal(rules.refusalSentence("not_given", "FOO", ["sales", "finance"], "Settings > Connections > Custom keys"),
      "FOO is set for Sales, Finance. An owner can give this agent access in Settings > Connections > Custom keys.");
    assert.match(rules.refusalSentence("unreadable", "FOO", null, "x"), /^FOO's agent choice could not be read, so no agent may use it until an owner saves it again in x\.$/);
    assert.match(rules.refusalSentence("read_failed", "FOO", null, "x"), /^Could not check which agents may use FOO right now\./);
    assert.equal(rules.appForTool("send_sms"), "quo");
    assert.equal(rules.appForTool("constructor"), null, "only the table's own keys");
    assert.equal(rules.agentToolsOf("quo"), "texting a lead from your computer");
    assert.equal(rules.agentToolsOf("slack"), null);
  });

  await check("the defaults: a custom key is for every agent; an app is its catalog agents plus the Chief of Staff", () => {
    assert.equal(store.defaultAccess({ kind: "custom", key: "FOO" }), "all");
    for (const def of CONNECTOR_CATALOG) {
      assert.deepEqual(store.defaultAccess({ kind: "connector", slug: def.slug }), rules.orderedDepartments(["chief_of_staff", ...def.departments]), def.slug);
    }
    assert.equal(store.defaultAccess({ kind: "connector", slug: "texttorrent" }), "all", "a service with no card stays open");
    assert.equal(store.accessField({ kind: "custom", key: "My_Key" }), "custom:my_key");
  });

  await check("a choice saves encrypted, reads back, and saving the default clears its row", async () => {
    assert.deepEqual(await store.saveAgentAccess({ tenantId: OASIS, target: { kind: "custom", key: "FOO" }, access: ["sales"] }), { ok: true });
    const read1 = await store.readAgentAccessOverrides(OASIS);
    assert.ok(read1.ok);
    if (read1.ok) assert.deepEqual(store.effectiveAccess(read1, { kind: "custom", key: "FOO" }), { access: ["sales"], saved: true });
    const stored = (await db.execute({ sql: "SELECT encrypted_value FROM tenant_integration_credentials WHERE field_key = 'custom:foo'", args: [] })).rows[0];
    assert.doesNotMatch(String(stored.encrypted_value), /sales/);
    await store.saveAgentAccess({ tenantId: OASIS, target: { kind: "custom", key: "FOO" }, access: "all" });
    assert.deepEqual(await accessRows(), [], "the default is no row");
  });

  await check("get_credential refuses a key the agent was not given; add_credential cannot overwrite it", async () => {
    await store.saveAgentAccess({ tenantId: OASIS, target: { kind: "custom", key: "FIN_SECRET" }, access: ["finance"] });
    await setTenantIntegrationValue({ tenantId: OASIS, service: VAULT_CUSTOM_SERVICE, fieldKey: "fin_secret", value: "finance-value" });
    const refused = JSON.parse((await runner.executeTool("get_credential", { name: "FIN_SECRET" }, ctx("maven"))).content);
    assert.deepEqual([refused.found, refused.forbidden], [false, true]);
    assert.equal(refused.hint, "FIN_SECRET is set for Finance. An owner can give this agent access in Settings > Connections > Custom keys.");
    const overwrite = JSON.parse((await runner.executeTool("add_credential", { name: "FIN_SECRET", value: "marketing-value" }, ctx("maven"))).content);
    assert.deepEqual([overwrite.ok, overwrite.forbidden], [false, true], "Marketing cannot replace Finance's key");
    const given = JSON.parse((await runner.executeTool("get_credential", { name: "FIN_SECRET" }, ctx("atlas"))).content);
    assert.equal(given.found, true);
    assert.equal(given.value, "finance-value", "the value Finance set is still the value");
  });

  await check("the Anthropic loop: send_sms is not offered to an agent Quo was not given, and is to one it was", async () => {
    await store.saveAgentAccess({ tenantId: OASIS, target: { kind: "connector", slug: "quo" }, access: ["sales"] });
    const meter = modelCallMeter({ tenantId: OASIS, surface: "chat.tools", authKind: "api_key", billingMode: "byo_key" });
    const offered = async (agentKey: string) => {
      let body: { tools?: Array<{ name: string }> } = {};
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(String(input), "https://api.anthropic.com/v1/messages");
        body = JSON.parse(String(init?.body));
        const frames: Array<[string, Record<string, unknown>]> = [
          ["message_start", { message: { usage: { input_tokens: 3 } } }],
          ["content_block_start", { index: 0, content_block: { type: "text" } }],
          ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } }],
          ["content_block_stop", { index: 0 }],
          ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
          ["message_stop", {}],
        ];
        return new Response(frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch;
      try {
        for await (const ev of runner.streamAnthropicWithTools(
          { apiKey: "test-key", model: "claude-test", system: "sys", messages: [{ role: "user", content: "hi" }], excludeDeferredTools: false, bridgeAdvertisedTools: null, toolPalette: undefined, meter },
          ctx(agentKey),
        )) void ev;
      } finally {
        globalThis.fetch = realFetch;
      }
      return (body.tools || []).map((t) => t.name);
    };
    const forMaven = await offered("maven");
    const forSdr = await offered("sdr");
    assert.ok(forMaven.length > 10, "the loop ran and offered tools");
    assert.ok(!forMaven.includes("send_sms"), "Marketing is not offered texting");
    assert.ok(forSdr.includes("send_sms"), "Sales is");
  });

  await check("the OpenAI-compatible loop withholds an app's tools the same way", async () => {
    await store.saveAgentAccess({ tenantId: OASIS, target: { kind: "connector", slug: "texttorrent" }, access: ["sales"] });
    const meter = modelCallMeter({ tenantId: OASIS, surface: "chat.tools", authKind: "api_key", billingMode: "byo_key" });
    const offered = async (agentKey: string) => {
      let body: { tools?: Array<{ function?: { name: string } }> } = {};
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        const frames = [{ choices: [{ delta: { content: "done" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"];
        return new Response(frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch;
      try {
        for await (const ev of runner.streamOpenAICompatibleWithTools(
          { provider: "openai", apiKey: "test-key", model: "gpt-test", system: "sys", messages: [{ role: "user", content: "hi" }], toolPalette: undefined, meter } as never,
          ctx(agentKey),
        )) void ev;
      } finally {
        globalThis.fetch = realFetch;
      }
      return (body.tools || []).map((t) => t.function?.name);
    };
    const forMaven = await offered("maven");
    assert.ok(forMaven.length > 10, "the loop ran and offered tools");
    assert.ok(!forMaven.includes("texttorrent_send"));
    assert.ok((await offered("sdr")).includes("texttorrent_send"));
  });

  await check("executeTool refuses an app tool the agent was not given (the offer is not the boundary)", async () => {
    const r = await runner.executeTool("texttorrent_send", { to: "+13655550100", message: "x" }, ctx("maven"));
    assert.equal(r.is_error, true);
    assert.match(r.content, /app_not_given_to_this_agent: texttorrent is set for Sales\. An owner can give this agent access in Settings > Connections\./);
    await store.clearAgentAccess({ tenantId: OASIS, target: { kind: "connector", slug: "texttorrent" } });
    await store.clearAgentAccess({ tenantId: OASIS, target: { kind: "connector", slug: "quo" } });
  });

  await check("an unreadable choice refuses only its own key; a failed read refuses everything", async () => {
    await db.execute({
      sql: "INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value) VALUES (?, 'agent_access', 'custom:broken', 'not-ciphertext')",
      args: [OASIS],
    });
    assert.deepEqual(await store.agentMayUse(OASIS, { kind: "custom", key: "BROKEN" }, "bravo"), { allowed: false, code: "unreadable", access: null });
    assert.deepEqual(await store.agentMayUse(OASIS, { kind: "custom", key: "OTHER" }, "bravo"), { allowed: true }, "the rest of the workspace works");
    assert.equal((await runner.toolsWithheldFromAgent(OASIS, "bravo")).size, 0);
    await db.execute("ALTER TABLE tenant_integration_credentials RENAME TO tic_away");
    try {
      assert.deepEqual(await store.agentMayUse(OASIS, { kind: "custom", key: "OTHER" }, "bravo"), { allowed: false, code: "read_failed", access: null });
      assert.deepEqual([...(await runner.toolsWithheldFromAgent(OASIS, "bravo"))].sort(), Object.keys(rules.APP_TOOLS).sort());
    } finally {
      await db.execute("ALTER TABLE tic_away RENAME TO tenant_integration_credentials");
    }
  });

  await check("the routes: signed out is 401, a member is 403, owners only", async () => {
    session = { ok: false, reason: "no_session" };
    assert.equal((await agentsRoute.GET()).status, 401);
    assert.equal((await customRoute.GET()).status, 401);
    session = { ...OWNER, isAdmin: false };
    assert.equal((await agentsRoute.GET()).status, 403);
    assert.equal((await agentsRoute.PUT(json({ kind: "connector", id: "slack", agents: ["sales"] }, "PUT"))).status, 403);
    assert.equal((await customRoute.POST(json({ key: "X", value: "y" }))).status, 403);
    session = OWNER;
  });

  await check("PUT: unknown apps and bad agents are refused; an app with no card can be set; null resets", async () => {
    assert.equal((await (await agentsRoute.PUT(json({ kind: "connector", id: "nope", agents: "all" }, "PUT"))).json()).error, "unknown_target");
    assert.equal((await (await agentsRoute.PUT(json({ kind: "connector", id: "slack", agents: ["salse"] }, "PUT"))).json()).error, "invalid_agents");
    const tt = await (await agentsRoute.PUT(json({ kind: "connector", id: "texttorrent", agents: ["sales"] }, "PUT"))).json();
    assert.deepEqual(tt, { ok: true, access: ["sales"], saved: true });
    const reset = await (await agentsRoute.PUT(json({ kind: "connector", id: "texttorrent", agents: null }, "PUT"))).json();
    assert.deepEqual(reset, { ok: true, access: "all", saved: false });
    const all = await (await agentsRoute.GET()).json();
    assert.deepEqual(all.connectors.texttorrent, { access: "all", saved: false, suggested: "all", unreadable: false });
    assert.equal(all.connectors.broken, undefined);
  });

  await check("custom keys: agents saved with the key, kept when it is rotated without them, dropped with it", async () => {
    assert.equal((await (await customRoute.POST(json({ key: "ROT_KEY", value: "v1", agents: ["salse"] }))).json()).error, "invalid_agents");
    assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS n FROM tenant_integration_credentials WHERE field_key = 'rot_key'", args: [] })).rows[0].n, 0, "nothing saved with bad agents");
    assert.equal((await (await customRoute.POST(json({ key: "ROT_KEY", value: "v1", agents: ["finance"] }))).json()).ok, true);
    assert.equal((await (await customRoute.POST(json({ key: "ROT_KEY", value: "v2" }))).json()).ok, true);
    const listed = (await (await customRoute.GET()).json()).entries.find((e: { key: string }) => e.key === "ROT_KEY");
    assert.deepEqual([listed.agents, listed.agents_saved], [["finance"], true], "a new value without agents keeps the agents");
    assert.equal(JSON.parse((await runner.executeTool("get_credential", { name: "ROT_KEY" }, ctx("maven"))).content).forbidden, true);
    const del = await customRoute.DELETE(json({ key: "ROT_KEY" }, "DELETE"));
    assert.deepEqual(await del.json(), { ok: true });
    assert.ok(!(await accessRows()).includes("custom:rot_key"), "the choice goes with the key");
  });

  await check("an unreadable choice is shown as one and can be saved again", async () => {
    await setTenantIntegrationValue({ tenantId: OASIS, service: VAULT_CUSTOM_SERVICE, fieldKey: "broken", value: "x" });
    const row = (await (await customRoute.GET()).json()).entries.find((e: { key: string }) => e.key === "BROKEN");
    assert.deepEqual([row.agents, row.agents_unreadable], [null, true]);
    assert.deepEqual(await (await agentsRoute.PUT(json({ kind: "custom", id: "BROKEN", agents: ["sales"] }, "PUT"))).json(), { ok: true, access: ["sales"], saved: true });
    assert.deepEqual(await store.agentMayUse(OASIS, { kind: "custom", key: "BROKEN" }, "sdr"), { allowed: true }, "repaired");
  });

  await check("a garbled choice row never reaches the credential status list, and the editor starts it from no agents", async () => {
    const { listTenantIntegrationStatus } = await import("../lib/tenant-integration-store");
    await db.execute({
      sql: "INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value) VALUES (?, 'agent_access', 'connector:slack', 'not-ciphertext')",
      args: [OASIS],
    });
    const rows = await listTenantIntegrationStatus(OASIS);
    assert.ok(rows.length > 0, "the vault's own rows are still listed");
    assert.ok(rows.every((r) => r.service !== "agent_access"), "agent choices are not credentials");
    await db.execute({ sql: "DELETE FROM tenant_integration_credentials WHERE field_key = 'connector:slack'", args: [] });
    const vault = read("components/settings/CustomCredentialsVault.tsx");
    assert.match(vault, /setEditAgents\(row\.agents_unreadable \? \[\] : row\.agents \?\? "all"\)/, "saving it unchanged must not widen it");
  });

  await check("the agents are named as the workspace's AI Team names them (CC: connected to a specific AI)", async () => {
    const { namedAgentChoices } = await import("../lib/os/agent-access-names");
    const founder = namedAgentChoices({ oasis: true, manifest: null, internal: true });
    // Operations reads as a department: Bravo leads it on the AI Team, but the runner checks
    // Bravo as the Chief of Staff, and a name must not promise access it refuses (review of #748).
    assert.deepEqual(founder.map((c) => c.label), [
      "Bravo (Chief of Staff)", "SDR (Sales)", "Maven (Marketing)", "Customer Support (Client Success)", "Atlas (Finance)", "Operations",
    ]);
    const { departmentForAgent } = await import("../lib/os/approvals/rules");
    const leads: Record<string, string> = { chief_of_staff: "bravo", sales: "sdr", marketing: "maven", client_success: "customer-support", finance: "atlas" };
    for (const c of founder.filter((x) => x.agent)) {
      assert.equal(departmentForAgent(leads[c.key]), c.key, `${c.label}: the runner checks its agent as this department`);
    }
    assert.equal(rules.agentNamesSentence(["chief_of_staff", "operations", "sales"], founder), "Bravo, Operations and SDR");
    assert.equal(rules.agentNamesSentence(["sales", "marketing", "finance"], founder), "SDR, Maven and Atlas");
    const twoForOne = [{ key: "chief_of_staff" as const, label: "Bravo (Chief of Staff)", agent: "Bravo" }, { key: "operations" as const, label: "Bravo (Operations)", agent: "Bravo" }];
    assert.equal(rules.agentNamesSentence(["chief_of_staff", "operations"], twoForOne), "Bravo", "each agent once");
    assert.equal(rules.agentAccessLabel(["marketing", "finance"], founder), "Maven (Marketing), Atlas (Finance)");
    assert.equal(rules.agentNamesSentence("all", founder), "all agents");
    assert.equal(rules.agentNamesSentence([], founder), "no agents");
    assert.equal(rules.agentNamesSentence(["finance"]), "Finance", "a workspace that names no agent reads departments");
    // Anyone but OASIS's founders reads a house agent as its department (lib/os/agent-names.ts).
    const oasisRep = namedAgentChoices({ oasis: true, manifest: null, internal: false });
    assert.equal(oasisRep.find((c) => c.key === "chief_of_staff")!.label, "Chief of Staff");
    assert.equal(oasisRep.find((c) => c.key === "sales")!.label, "SDR (Sales)", "a library template keeps its name");
    // A client with no teammates sees departments; one with a teammate sees that teammate's name.
    assert.deepEqual(namedAgentChoices({ oasis: false, manifest: null, internal: false }).map((c) => c.label), rules.AGENT_CHOICES.map((c) => c.label));
    const withRiley = namedAgentChoices({
      oasis: false,
      manifest: { agents: [{ slug: "sdr", display_name: "Riley", enabled: true, departments: ["sales"] }] } as never,
      internal: false,
    });
    assert.equal(withRiley.find((c) => c.key === "sales")!.label, "Riley (Sales)");
    // A teammate the runner does not know reads as its department: ticking Sales would not reach it.
    const withOwnSlug = namedAgentChoices({
      oasis: false,
      manifest: { agents: [{ slug: "riley", display_name: "Riley", enabled: true, departments: ["sales"] }] } as never,
      internal: false,
    });
    assert.equal(withOwnSlug.find((c) => c.key === "sales")!.label, "Sales");
    // The picker shows the names it is given.
    const React = await import("react");
    (globalThis as unknown as { React: typeof React }).React = React;
    const { AgentPicker } = await import("../components/os/connections/AgentPicker");
    const tree = AgentPicker({ value: "all", onChange: () => undefined, choices: founder }) as unknown as { props: { children: [unknown, Array<{ props: { children: unknown } }>] } };
    assert.deepEqual(tree.props.children[1].map((b) => b.props.children), founder.map((c) => c.label));
    // Both routes send the names, as the signed-in viewer's AI Team names them.
    const labels = (j: { choices: Array<{ label: string }> }) => j.choices.map((c) => c.label);
    viewer = FOUNDER_VIEWER;
    assert.deepEqual(labels(await (await agentsRoute.GET()).json()), founder.map((c) => c.label));
    assert.deepEqual(labels(await (await customRoute.GET()).json()), founder.map((c) => c.label));
    viewer = { ...FOUNDER_VIEWER, surface: { ...(FOUNDER_VIEWER.surface as object), persona: "rep" } };
    assert.equal(labels(await (await agentsRoute.GET()).json())[0], "Chief of Staff", "a rep reads the house agent's department");
    // A lookup that fails shows the departments, and says so in the log.
    const realError = console.error;
    const logged: unknown[] = [];
    console.error = (...a: unknown[]) => void logged.push(a);
    viewer = new Error("viewer lookup failed");
    try {
      assert.deepEqual(labels(await (await customRoute.GET()).json()), rules.AGENT_CHOICES.map((c) => c.label));
    } finally {
      console.error = realError;
      viewer = FOUNDER_VIEWER;
    }
    assert.equal(logged.length, 1);
    // The cards and every saved custom key show them.
    const hub = read("components/os/connections/ConnectionsHub.tsx");
    assert.match(hub, /`Used by \$\{agentNamesSentence\(c\.access, j\.choices\)\}`/);
    assert.match(hub, /agents=\{agentLines\?\.\[def\.slug\]\}/);
    assert.match(hub, /\{customLine \?\? "Each key names the agents that may use it"\}/);
    assert.match(read("components/settings/CustomCredentialsVault.tsx"), /<AgentChips access=\{row\.agents\} choices=\{choices\} \/>/);
  });

  await check("a paste saves each key with its own agents; one bad choice saves nothing", async () => {
    const before = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM tenant_integration_credentials WHERE service = 'custom'", args: [] })).rows[0].n;
    const choicesBefore = await accessRows();
    const bad = await customRoute.POST(json({ entries: [{ key: "P_ONE", value: "1", agents: ["sales"] }, { key: "P_TWO", value: "2", agents: ["salse"] }] }));
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "invalid_agents");
    assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS n FROM tenant_integration_credentials WHERE service = 'custom'", args: [] })).rows[0].n, before, "no value saved");
    assert.deepEqual(await accessRows(), choicesBefore, "no agent choice saved either");
    assert.equal(
      (await customRoute.POST(json({ entries: [{ key: "P_ONE", value: "1", suggested_agents: "everyone" }] }))).status,
      400,
      "a bad suggestion is refused the same way",
    );
    const ok = await (await customRoute.POST(json({
      agents: ["finance"],
      entries: [
        { key: "P_ONE", value: "1", agents: ["sales"] },
        { key: "P_TWO", value: "2" },
      ],
    }))).json();
    assert.deepEqual([ok.ok, ok.saved], [true, 2]);
    const listed = (await (await customRoute.GET()).json()).entries as Array<{ key: string; agents: unknown }>;
    assert.deepEqual(listed.find((e) => e.key === "P_ONE")?.agents, ["sales"], "its own agents win");
    assert.deepEqual(listed.find((e) => e.key === "P_TWO")?.agents, ["finance"], "the request's agents otherwise");
    assert.equal(JSON.parse((await runner.executeTool("get_credential", { name: "P_ONE" }, ctx("atlas"))).content).forbidden, true);
    for (const key of ["P_ONE", "P_TWO"]) await customRoute.DELETE(json({ key }, "DELETE"));
  });

  await check("a suggestion applies only to a key that is new when it is written, whatever the browser believed", async () => {
    const agentsOf = async (key: string) =>
      ((await (await customRoute.GET()).json()).entries as Array<{ key: string; agents: unknown; agents_saved: boolean }>).find((e) => e.key === key);
    const SUGGEST = ["chief_of_staff", "sales", "marketing"];
    // New: the suggestion is saved before the value.
    await customRoute.POST(json({ key: "S_NEW", value: "v", suggested_agents: SUGGEST }));
    assert.deepEqual((await agentsOf("S_NEW"))?.agents, SUGGEST);
    // Saved for Sales by an owner: a stale browser's suggestion does not replace it.
    await customRoute.POST(json({ key: "S_OWNED", value: "v1", agents: ["sales"] }));
    await customRoute.POST(json({ key: "S_OWNED", value: "v2", suggested_agents: SUGGEST }));
    assert.deepEqual((await agentsOf("S_OWNED"))?.agents, ["sales"]);
    // Saved for Finance, then a model's suggestion ("all"): not widened, not cleared.
    await customRoute.POST(json({ key: "S_NARROW", value: "v1", agents: ["finance"] }));
    await customRoute.POST(json({ key: "S_NARROW", value: "v2", suggested_agents: "all" }));
    assert.deepEqual((await agentsOf("S_NARROW"))?.agents, ["finance"]);
    // A value saved with no choice (all agents) stays as it is: a suggestion is for new keys only.
    await customRoute.POST(json({ key: "S_OPEN", value: "v1" }));
    await customRoute.POST(json({ key: "S_OPEN", value: "v2", suggested_agents: ["finance"] }));
    assert.deepEqual([(await agentsOf("S_OPEN"))?.agents, (await agentsOf("S_OPEN"))?.agents_saved], ["all", false]);
    // A choice saved for a name with no value yet is the owner's too.
    await agentsRoute.PUT(json({ kind: "custom", id: "S_CHOSEN", agents: ["marketing"] }, "PUT"));
    await customRoute.POST(json({ key: "S_CHOSEN", value: "v", suggested_agents: SUGGEST }));
    assert.deepEqual((await agentsOf("S_CHOSEN"))?.agents, ["marketing"]);
    // An explicit choice always applies.
    await customRoute.POST(json({ key: "S_OWNED", value: "v3", agents: ["finance"], suggested_agents: SUGGEST }));
    assert.deepEqual((await agentsOf("S_OWNED"))?.agents, ["finance"]);
    // Twice in one paste: the second does not see the first as new.
    await customRoute.POST(json({ entries: [{ key: "S_TWICE", value: "a", agents: ["finance"] }, { key: "S_TWICE", value: "b", suggested_agents: SUGGEST }] }));
    assert.deepEqual((await agentsOf("S_TWICE"))?.agents, ["finance"]);
    for (const key of ["S_NEW", "S_OWNED", "S_NARROW", "S_OPEN", "S_CHOSEN", "S_TWICE"]) await customRoute.DELETE(json({ key }, "DELETE"));
  });

  await check("when the keys cannot be read: GET fails loudly and a suggestion is refused, never applied blind", async () => {
    const realError = console.error;
    console.error = () => undefined;
    await db.execute("ALTER TABLE tenant_integration_credentials RENAME TO tic_moved");
    try {
      const listed = await customRoute.GET();
      assert.equal(listed.status, 500, "an error, never an empty list");
      assert.equal((await listed.json()).error, "keys_unreadable");
      const saved = await (await customRoute.POST(json({ key: "S_BLIND", value: "v", suggested_agents: ["sales"] }))).json();
      assert.equal(saved.ok, false);
      assert.match(saved.results[0].error, /^agents_unknown/);
    } finally {
      await db.execute("ALTER TABLE tic_moved RENAME TO tenant_integration_credentials");
      console.error = realError;
    }
  });

  await check("a secret where a name goes is refused and never echoed back", async () => {
    const bare = ["Zm9vYmFy", "YmF6cXV4", "MTIzNDU2Nzg5"].join("");
    const r = await (await customRoute.POST(json({ dotenv: `${bare}==\nGOOD_KEY=v` }))).json();
    assert.deepEqual(r.results.map((x: { key: string; ok: boolean }) => [x.key, x.ok]), [["(a secret without a name)", false], ["GOOD_KEY", true]]);
    assert.ok(!JSON.stringify(r).toLowerCase().includes(bare.slice(0, 8).toLowerCase()), "no part of it in the answer");
    const one = await (await customRoute.POST(json({ key: ["sk-", "ant-", "api03-", "abcdef"].join(""), value: "v" }))).json();
    assert.equal(one.results[0].error, "key_looks_like_a_secret");
    // A short one reads as a name, but "=" padding alone is never a value.
    const short = await (await customRoute.POST(json({ dotenv: "Qk9C==" }))).json();
    assert.deepEqual([short.ok, short.results[0].error], [false, "empty_value"]);
    assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS n FROM tenant_integration_credentials WHERE field_key = 'qk9c'", args: [] })).rows[0].n, 0);
    const keys = (await db.execute({ sql: "SELECT field_key FROM tenant_integration_credentials WHERE service = 'custom'", args: [] })).rows.map((x) => String(x.field_key));
    assert.ok(!keys.some((k) => k.startsWith("zm9v") || k.startsWith("sk")), "neither was stored as a name");
    await customRoute.DELETE(json({ key: "GOOD_KEY" }, "DELETE"));
  });

  await check("APP_TOOLS is whole: every credential read in the runner belongs to a mapped tool", () => {
    const src = read("lib/cloud-tool-runner.ts");
    const reads = (src.match(/get(Kixie|TextTorrent)Credentials\(ctx\.tenantId\)/g) || []).length;
    const mapped = Object.values(rules.APP_TOOLS).filter((slug) => slug === "kixie" || slug === "texttorrent").length;
    assert.equal(reads, mapped, "a new tool that reads an app's credentials must be added to APP_TOOLS");
    assert.doesNotMatch(src, /getTenantIntegrationBundle\(ctx\.tenantId/, "no tool reads a bundle directly");
    const names = new Set(runner.TOOL_DEFINITIONS.map((t) => t.name));
    for (const tool of Object.keys(rules.APP_TOOLS)) assert.ok(names.has(tool), `${tool} is a real tool`);
  });

  await check("the picker: one off from all leaves five, ticking it back is all agents again", async () => {
    const React = await import("react");
    (globalThis as unknown as { React: typeof React }).React = React;
    const { AgentPicker } = await import("../components/os/connections/AgentPicker");
    type Btn = { props: { children: unknown; onClick: () => void; "aria-pressed": boolean } };
    const buttons = (value: unknown, onChange: (v: unknown) => void) => {
      const tree = AgentPicker({ value: value as never, onChange }) as unknown as { props: { children: unknown[] } };
      const [allBtn, rest] = tree.props.children as [Btn, Btn[]];
      return [allBtn, ...rest];
    };
    let got: unknown;
    const sales = (v: unknown) => buttons(v, (x) => (got = x)).find((b) => b.props.children === "Sales")!;
    sales("all").props.onClick();
    const five = ["chief_of_staff", "marketing", "client_success", "finance", "operations"];
    assert.deepEqual(got, five);
    sales(five).props.onClick();
    assert.equal(got, "all", "back where the owner started");
    sales(["sales"]).props.onClick();
    assert.deepEqual(got, []);
    buttons([], (x) => (got = x))[0].props.onClick();
    assert.equal(got, "all");
    assert.equal(buttons("all", () => undefined).every((b) => b.props["aria-pressed"]), true);
  });

  await check("the vault sends agents only when chosen or suggested (tests/custom-keys.test.ts); the drawer says what an app's tools are", () => {
    const vault = read("components/settings/CustomCredentialsVault.tsx");
    assert.match(vault, /body: JSON\.stringify\(\{ key: keyName, value, \.\.\.toSend \}\)/);
    assert.match(vault, /\(\{ key: p\.sendKey, value: p\.value, \.\.\.p\.send \}\)/);
    const drawer = read("components/os/connections/ConnectorDrawer.tsx");
    assert.match(drawer, /Used by<\/h3>\s*<ConnectorAgentAccess key=\{def\.slug\} slug=\{def\.slug\} departments=\{def\.departments\} \/>/);
    const access = read("components/os/connections/ConnectorAgentAccess.tsx");
    assert.match(access, /No agent tool uses this app yet; your choice applies to any that does\./);
  });

  console.log(failures ? `agent access: ${failures} failure(s)` : "agent access: all passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
