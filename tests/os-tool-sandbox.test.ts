/**
 * os-tool-sandbox.test.ts — a client tenant's agent is default-deny: it is
 * never offered, and can never dispatch, a bridge-routed tool, a credential
 * tool or an OASIS-only tool; OASIS's own tenants behave exactly as before.
 *
 * WHY (docs/os-revamp/03-connectors-ai-finance.md F2, §d.4). Before this guard
 * an agent with no tool palette got EVERY tool in TOOL_DEFINITIONS, including
 * the `defer: true` tools that run on OASIS's paired machine (bash, write_file,
 * run_script, send_email) and get_credential, which returns a decrypted vault
 * secret to the model. The only filter was "is the bridge offline", which is
 * an availability check, not a boundary. This test pins the boundary at every
 * layer it now lives in:
 *   1. the registry itself (no bridge/credential/brain tool on it, no phantom
 *      names, the OASIS id list matches the brand map);
 *   2. palette resolution (a client's missing palette is no tools);
 *   3. the offered tool set for every client palette that exists in the code
 *      (the safe default, Helios, every seed agent, "every tool");
 *   4. the dispatcher (executeTool refuses before any tool code runs);
 *   5. the real Anthropic loop, with only the network stubbed: the tools[]
 *      actually sent, a forbidden tool_use the model emits anyway, and a
 *      resumed turn;
 *   6. OASIS unchanged: an independent copy of the pre-change filter chain
 *      must give the same offered set for OASIS over a matrix of inputs.
 *
 * The data layer points at an empty temp libSQL file, so a regression that
 * reached a tool's database code could not touch real data.
 *
 * Run: node --conditions=react-server --import tsx tests/os-tool-sandbox.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = join(mkdtempSync(join(tmpdir(), "os-tool-sandbox-")), "test.db");
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452"; // slug oasis-ai-cc
const OASIS_WEBDEV = "42423fde-be8b-454f-932a-750e8c9b743d"; // slug oasis-webdev
const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110"; // retired client
const UNKNOWN = "9f9f9f9f-0000-4000-8000-00000000009f"; // a self-signup / new client
const CLIENT_TENANTS = [UNKNOWN, SUNBIZ];

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(error);
  }
}

/** Anthropic SSE for one assistant message. */
function sse(events: Array<[string, Record<string, unknown>]>): Response {
  const text = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const endTurn = () =>
  sse([
    ["message_start", { message: { usage: { input_tokens: 3 } } }],
    ["content_block_start", { index: 0, content_block: { type: "text" } }],
    ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
    ["message_stop", {}],
  ]);
const toolUse = (name: string, input: Record<string, unknown>) =>
  sse([
    ["message_start", { message: { usage: { input_tokens: 3 } } }],
    ["content_block_start", { index: 0, content_block: { type: "tool_use", id: `tu_${name}`, name } }],
    ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } }],
    ["message_stop", {}],
  ]);

/** Replace fetch with a queue of Anthropic responses; record each request body. */
function stubAnthropic(responses: Response[]): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    assert.equal(url, "https://api.anthropic.com/v1/messages", `unexpected network call to ${url}`);
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = responses.shift();
    assert.ok(next, "the loop made more model calls than the test scripted");
    return next;
  }) as typeof fetch;
  return bodies;
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

async function main() {
  console.log("os-tool-sandbox:");
  const runner = await import("../lib/cloud-tool-runner");
  const registry = await import("../lib/ai/tools/client-safe-registry");
  const { resolveAgentToolPalette } = await import("../lib/manifest/schema");
  const { SAFE_TENANT_TOOL_PALETTE, HELIOS_TOOL_PALETTE, SUNBIZ_OUTBOUND_TOOLS } = await import("../lib/chat-tool-palettes");
  const { SEED_MANIFESTS } = await import("../lib/manifest/seeds");
  const { TENANT_ID_BRAND } = await import("../lib/email/brand-for-tenant");
  const { filterToolsForMode } = await import("../lib/chat-modes/plan-mode");

  const { TOOL_DEFINITIONS, resolveActiveTools } = runner;
  const ALL_NAMES = TOOL_DEFINITIONS.map((t) => t.name);
  const DEFER_NAMES = new Set(TOOL_DEFINITIONS.filter((t) => t.defer).map((t) => t.name));

  // The independent oracle of what a client must never be offered: every
  // bridge-routed tool, plus the cloud tools that expose secrets, OASIS's
  // brain repo, unauthenticated outbound writes, deletes or outward sends.
  // Kept here, not imported from the registry, so editing the registry cannot
  // quietly edit the test's idea of "forbidden" too.
  const FORBIDDEN = new Set<string>([
    ...DEFER_NAMES,
    "get_credential",
    "add_credential",
    "http_post",
    "load_skill",
    "read_brain_doc",
    "search_memory",
    "delete_record",
    ...SUNBIZ_OUTBOUND_TOOLS,
  ]);
  const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name);
  const assertClientSafe = (offered: string[], label: string) => {
    for (const n of offered) {
      assert.ok(!FORBIDDEN.has(n), `${label}: offered forbidden tool ${n}`);
      assert.ok(registry.isClientSafeTool(n), `${label}: offered ${n}, which is not on the client-safe registry`);
    }
  };

  const BRIDGE_STATES: Array<{ label: string; excludeDeferredTools?: boolean; bridgeAdvertisedTools?: string[] | null }> = [
    { label: "bridge online, no advertisement", excludeDeferredTools: false, bridgeAdvertisedTools: null },
    { label: "bridge online, advertises every bridge tool", excludeDeferredTools: false, bridgeAdvertisedTools: [...DEFER_NAMES] },
    { label: "bridge offline", excludeDeferredTools: true, bridgeAdvertisedTools: null },
  ];

  // ── 1. the registry ──────────────────────────────────────────────────
  await check("every client-safe name is a real tool, none is bridge-routed or forbidden", () => {
    assert.ok(registry.CLIENT_SAFE_TOOLS.size > 0);
    for (const [name, cls] of registry.CLIENT_SAFE_TOOLS) {
      assert.ok(ALL_NAMES.includes(name), `registry names ${name}, which TOOL_DEFINITIONS does not define`);
      assert.ok(!DEFER_NAMES.has(name), `${name} is defer:true (runs on the paired machine)`);
      assert.ok(!FORBIDDEN.has(name), `${name} must never be client-safe`);
      assert.ok(cls === "read" || cls === "draft", `${name} has class ${cls}`);
    }
    // Anti-vacuity: the catalog really does contain the tools this guards against.
    for (const n of ["bash", "write_file", "run_script", "send_email", "load_skill"]) assert.ok(DEFER_NAMES.has(n), n);
    for (const n of ["get_credential", "add_credential", "http_post"]) assert.ok(ALL_NAMES.includes(n), n);
  });

  await check("the OASIS tenant ids are exactly the brand map's OASIS rows, matched by exact id", () => {
    const brandOasis = Object.entries(TENANT_ID_BRAND).filter(([, b]) => b === "oasis").map(([id]) => id).sort();
    assert.deepEqual([...registry.OASIS_INTERNAL_TENANT_IDS].sort(), brandOasis);
    assert.equal(registry.isOasisInternalTenant(OASIS), true);
    assert.equal(registry.isOasisInternalTenant(OASIS_WEBDEV), true);
    for (const t of [SUNBIZ, UNKNOWN, "", null, undefined, "oasis-ai-cc", OASIS.toUpperCase(), ` ${OASIS}`]) {
      assert.equal(registry.isOasisInternalTenant(t), false, `isOasisInternalTenant(${JSON.stringify(t)})`);
    }
  });

  // ── 2. palette resolution ────────────────────────────────────────────
  await check("a client's missing palette resolves to no tools; a populated one to its client-safe part", () => {
    for (const t of [...CLIENT_TENANTS, "", null]) {
      assert.deepEqual(resolveAgentToolPalette(undefined, t), [], `tenant ${t}`);
      assert.deepEqual(
        resolveAgentToolPalette(["bash", "get_credential", "list_records", "send_sms", "web_fetch"], t),
        ["list_records", "web_fetch"],
      );
    }
  });

  await check("an OASIS palette is returned untouched, and a missing one stays 'no filter'", () => {
    for (const t of [OASIS, OASIS_WEBDEV]) {
      assert.equal(resolveAgentToolPalette(undefined, t), undefined);
      const p = ["bash", "get_credential"];
      assert.equal(resolveAgentToolPalette(p, t), p);
      assert.deepEqual(resolveAgentToolPalette([], t), []);
    }
  });

  // ── 3. offered sets for every client palette in the code ─────────────
  await check("an unknown or non-OASIS tenant with no palette is offered zero tools, in every bridge state", () => {
    for (const tenantId of CLIENT_TENANTS) {
      for (const s of BRIDGE_STATES) {
        for (const chatMode of ["build", "plan"] as const) {
          const offered = resolveActiveTools({ tenantId, ...s, toolPalette: undefined, chatMode });
          assert.deepEqual(names(offered), [], `${tenantId} / ${s.label} / ${chatMode}`);
        }
      }
      assert.deepEqual(names(resolveActiveTools({ tenantId, toolPalette: undefined, forceExcludeDeferred: true })), []);
    }
  });

  await check("no client palette, however it is written, yields a bridge, credential or OASIS-only tool", () => {
    const palettes: Array<[string, string[]]> = [
      ["every tool in the catalog", ALL_NAMES],
      ["SAFE_TENANT_TOOL_PALETTE", SAFE_TENANT_TOOL_PALETTE],
      ["HELIOS_TOOL_PALETTE", HELIOS_TOOL_PALETTE],
    ];
    for (const [slug, manifest] of Object.entries(SEED_MANIFESTS)) {
      for (const agent of manifest.agents ?? []) {
        palettes.push([`seed ${slug} / ${agent.slug}`, agent.tool_palette ?? ALL_NAMES]);
      }
    }
    for (const tenantId of CLIENT_TENANTS) {
      for (const [label, palette] of palettes) {
        for (const s of BRIDGE_STATES) {
          const offered = names(resolveActiveTools({ tenantId, ...s, toolPalette: palette }));
          assertClientSafe(offered, `${label} / ${s.label}`);
        }
      }
      // The whole catalog as a palette offers exactly the registry, nothing more.
      const everything = names(resolveActiveTools({ tenantId, ...BRIDGE_STATES[0], toolPalette: ALL_NAMES }));
      assert.deepEqual([...everything].sort(), [...registry.CLIENT_SAFE_TOOLS.keys()].sort());
      // The safe default loses exactly its bridge and credential tools.
      const safe = names(resolveActiveTools({ tenantId, ...BRIDGE_STATES[0], toolPalette: SAFE_TENANT_TOOL_PALETTE }));
      for (const gone of ["send_email", "send_sms", "get_credential", "add_credential"]) {
        assert.ok(SAFE_TENANT_TOOL_PALETTE.includes(gone), `anti-vacuity: ${gone} is in the safe default`);
        assert.ok(!safe.includes(gone), `${gone} survived for a client`);
      }
      assert.ok(safe.includes("list_records") && safe.includes("create_record"), "the client keeps its CRM tools");
    }
  });

  // ── 6 (pure half). OASIS unchanged ───────────────────────────────────
  await check("OASIS's offered tools equal the pre-change filter chain over a matrix of inputs", () => {
    // Verbatim copy of the filter chain as it stood before 2026-09-28.
    const legacy = (a: {
      excludeDeferredTools?: boolean;
      bridgeAdvertisedTools?: string[] | null;
      toolPalette?: string[];
      chatMode?: "plan" | "build";
      forceExcludeDeferred?: boolean;
    }) => {
      let active = TOOL_DEFINITIONS;
      if (a.forceExcludeDeferred || a.excludeDeferredTools) active = active.filter((t) => !t.defer);
      else if (a.bridgeAdvertisedTools !== undefined && a.bridgeAdvertisedTools !== null) {
        const adv = new Set(a.bridgeAdvertisedTools);
        active = active.filter((t) => !t.defer || adv.has(t.name));
      }
      if (a.toolPalette !== undefined) {
        const allow = new Set(a.toolPalette);
        active = active.filter((t) => allow.has(t.name));
      }
      if (a.chatMode === "plan") active = filterToolsForMode(active, "plan");
      return names(active);
    };
    const palettes: Array<string[] | undefined> = [undefined, [], SAFE_TENANT_TOOL_PALETTE, HELIOS_TOOL_PALETTE, ALL_NAMES, ["bash", "list_records", "get_credential"]];
    let compared = 0;
    for (const tenantId of [OASIS, OASIS_WEBDEV]) {
      for (const toolPalette of palettes) {
        for (const s of [...BRIDGE_STATES, { label: "advertises two", excludeDeferredTools: false, bridgeAdvertisedTools: ["bash", "read_file"] }]) {
          for (const chatMode of ["build", "plan"] as const) {
            for (const forceExcludeDeferred of [false, true]) {
              const args = { ...s, toolPalette, chatMode, forceExcludeDeferred };
              assert.deepEqual(names(resolveActiveTools({ tenantId, ...args })), legacy(args), JSON.stringify({ tenantId, ...args, label: undefined }));
              compared += 1;
            }
          }
        }
      }
    }
    assert.ok(compared > 100, "the matrix did not run");
    // And the headline case: CC with no palette and the bridge online still gets everything.
    assert.deepEqual(names(resolveActiveTools({ tenantId: OASIS, ...BRIDGE_STATES[0] })), ALL_NAMES);
  });

  // ── 4. the dispatcher ────────────────────────────────────────────────
  const clientCtx = { tenantId: UNKNOWN, userId: "u1", agentKey: "bravo", authUserId: "u1", isAdmin: true };
  await check("executeTool refuses every non-client-safe tool for a client, before any tool code runs", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      for (const name of ["get_credential", "add_credential", "http_post", "read_brain_doc", "search_memory", "bash", "write_file", "kixie_send_sms", "delete_record"]) {
        const r = await runner.executeTool(name, { name: "STRIPE_SECRET_KEY", value: "x", url: "https://example.test" }, clientCtx);
        assert.equal(r.is_error, true, name);
        assert.deepEqual(JSON.parse(r.content), { error: "tool_not_available_in_this_workspace", tool: name });
      }
      const noTenant = await runner.executeTool("list_records", { entity: "lead" }, { ...clientCtx, tenantId: "" });
      assert.deepEqual(JSON.parse(noTenant.content), { error: "tool_context_missing_tenant", tool: "list_records" });
    } finally {
      console.error = quiet;
    }
  });

  await check("executeTool does not apply the client gate to an OASIS tenant", async () => {
    // bash is bridge-routed, so the cloud dispatcher has no case for it: it
    // reaches dispatch (unknown_tool) instead of being refused by the gate.
    const r = await runner.executeTool("bash", { command: "echo" }, { ...clientCtx, tenantId: OASIS });
    assert.deepEqual(JSON.parse(r.content), { error: "unknown_tool:bash" });
  });

  await check("a tenant the model writes into a tool input is stripped; the session tenant applies", () => {
    const input = { entity: "lead", tenant_id: SUNBIZ, tenantId: SUNBIZ, tenant: "submissions", query: "x" };
    assert.deepEqual(runner.stripModelSuppliedTenant(input), { entity: "lead", query: "x" });
    assert.equal(input.tenant_id, SUNBIZ, "the model's input object is not mutated");
  });

  // ── 5. the real Anthropic loop, network stubbed ──────────────────────
  const loopReq = (toolPalette: string[] | undefined) => ({
    apiKey: "test-key",
    model: "claude-test",
    system: "sys",
    messages: [{ role: "user" as const, content: "hi" }],
    excludeDeferredTools: false,
    bridgeAdvertisedTools: null,
    toolPalette,
  });

  await check("a client turn with no palette sends the model no tools at all", async () => {
    const bodies = stubAnthropic([endTurn()]);
    const events = await collect(runner.streamAnthropicWithTools(loopReq(undefined), clientCtx));
    assert.equal(bodies.length, 1);
    assert.equal("tools" in bodies[0], false, "a client with no palette must not be sent a tools array");
    assert.ok(events.some((e) => e.type === "done"));
  });

  await check("a client turn whose palette names everything sends only client-safe tools", async () => {
    const bodies = stubAnthropic([endTurn()]);
    await collect(runner.streamAnthropicWithTools(loopReq(ALL_NAMES), clientCtx));
    const sent = (bodies[0].tools as Array<{ name: string }>).map((t) => t.name);
    assert.ok(sent.length > 0);
    assertClientSafe(sent, "tools[] sent to the model");
  });

  await check("a forbidden tool_use the model emits anyway is blocked, never executed or sent to the bridge", async () => {
    for (const forbidden of ["get_credential", "bash"]) {
      const bodies = stubAnthropic([toolUse(forbidden, { name: "STRIPE_SECRET_KEY", command: "cat ~/.env" }), endTurn()]);
      const events = await collect(runner.streamAnthropicWithTools(loopReq(ALL_NAMES), clientCtx));
      assert.ok(
        events.some((e) => e.type === "tool_result" && e.name === forbidden && e.ok === false),
        `${forbidden} was not reported blocked`,
      );
      assert.ok(!events.some((e) => e.type === "tool_use" && e.name === forbidden), `${forbidden} was dispatched`);
      assert.ok(!events.some((e) => e.type === "tool_use_pending"), `${forbidden} was handed to the bridge`);
      assert.equal(bodies.length, 2, "the loop should continue after the blocked call");
    }
  });

  await check("a resumed client turn re-applies the tenant filter to the carried palette", async () => {
    const bodies = stubAnthropic([endTurn()]);
    await collect(
      runner.resumeAnthropicTurn(
        { model: "claude-test", system: "sys", history: [], iteration: 0, totalIn: 0, totalOut: 0, toolPalette: ["bash", "get_credential"] },
        "tu_x",
        { content: "{}", is_error: false },
        clientCtx,
        "test-key",
      ),
    );
    assert.equal("tools" in bodies[0], false, "bash/get_credential carried in resume_state reached a client turn");
  });

  await check("OASIS: no palette + bridge online still offers every tool and defers bash to the bridge", async () => {
    const bodies = stubAnthropic([toolUse("bash", { command: "ls" })]);
    const events = await collect(runner.streamAnthropicWithTools(loopReq(undefined), { ...clientCtx, tenantId: OASIS }));
    assert.deepEqual((bodies[0].tools as Array<{ name: string }>).map((t) => t.name), ALL_NAMES);
    assert.ok(events.some((e) => e.type === "tool_use_pending" && e.name === "bash"), "OASIS bridge tools must keep working");
  });

  await check("the prompt block never describes bridge or OASIS-only tools to a client", () => {
    const client = runner.cloudToolsPromptBlockV2({ bridgeOnline: true, tenantId: UNKNOWN });
    for (const n of FORBIDDEN) assert.ok(!client.includes(`- ${n} —`), `client prompt describes ${n}`);
    assert.ok(client.includes("- list_records —"));
    for (const block of [runner.cloudToolsPromptBlockV2({ bridgeOnline: true, tenantId: OASIS }), runner.cloudToolsPromptBlockV2({ bridgeOnline: true })]) {
      assert.ok(block.includes("- bash —") && block.includes("- get_credential —"), "OASIS prompt block changed");
    }
  });

  // The legacy <cloud-tool> marker path (non-native providers) dispatches
  // through runCloudTool, not executeTool, so it needs its own gate.
  await check("the legacy marker path refuses non-client-safe cloud tools for a client, before any tool code runs", async () => {
    const { runCloudTool, CLOUD_TOOLS } = await import("../lib/cloud-tools");
    const forbiddenLegacy = Object.keys(CLOUD_TOOLS).filter((n) => !registry.isClientSafeTool(n));
    assert.ok(forbiddenLegacy.includes("read_brain_doc") && forbiddenLegacy.includes("search_memory"), "oracle drifted");
    for (const tenantId of [...CLIENT_TENANTS, ""]) {
      for (const name of forbiddenLegacy) {
        const r = await runCloudTool({ name, input: {} }, { tenantId, userId: "u-1" });
        assert.deepEqual(r, { ok: false, name, error: "tool_not_available_in_this_workspace" }, `${tenantId || "(empty)"} ran ${name}`);
      }
    }
    const src = (await import("node:fs")).readFileSync("app/api/chat/route.ts", "utf8");
    assert.match(src, /cloudToolsPromptBlockV2\(\{ bridgeOnline: bridgeToolsActive, tenantId \}\)/, "chat route must pass the session tenant to the prompt block");
  });

  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("os tool sandbox tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
