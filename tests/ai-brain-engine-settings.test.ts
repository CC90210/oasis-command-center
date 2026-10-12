/**
 * Settings > AI brain: one repairable runtime control.
 *
 * Run: node --conditions=react-server --import tsx tests/ai-brain-engine-settings.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
let failures = 0;

async function check(name: string, work: () => void | Promise<void>) {
  try {
    await work();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${String((error as Error).stack ?? error).split("\n").slice(0, 7).join("\n        ")}`);
  }
}

async function main() {
  const client = await import("../components/settings/agent-engine-client");
  const rollout = await import("../lib/ai/engine-rollout");
  const settings = await import("../components/settings/settings-sections");
  const { startCliSignIn } = await import("../components/settings/LocalCliProvidersCard");

  await check("browser polling outlives the connector's longest restricted probe", () => {
    assert.equal(client.CONNECTOR_PROBE_MAX_MS, 540_000);
    assert.ok(
      client.RUNTIME_JOB_DEADLINE_MS >= client.CONNECTOR_PROBE_MAX_MS + 60_000,
      "probe polling needs queue/network margin beyond the connector ceiling",
    );
  });

  await check("the consolidated panel exposes exactly the three runtime choices and the two manager scopes", () => {
    const panel = readFileSync(join(ROOT, "components/settings/AgentEnginePanel.tsx"), "utf8");
    for (const label of ["Subscription app", "Pure local", "API key", "My setup", "Workspace default"]) {
      assert.match(panel, new RegExp(`(?:>|\\\")${label}(?:<|\\\")`), label);
    }
    assert.doesNotMatch(panel, />\s*(?:An app on your paired computer|An AI account \(fallback\)|A local model)\s*</);
    assert.match(panel, /fallback/i, "the no-silent-fallback control is visible in the one panel");
    assert.match(panel, /state\.canManage\s*\?\s*API_PROVIDERS\.filter/, "only managers can choose among saved API providers");
    assert.doesNotMatch(panel, /await switchProvider\(/, "the browser must not switch the API account before the engine CAS");
    const route = readFileSync(join(ROOT, "app/api/ai/engine/route.ts"), "utf8");
    assert.match(route, /connectWorkspaceAccountAndEngineInOneStep/, "provider activation and the engine CAS use one server transaction");
    assert.match(route, /readLatestRuntimeProbeReceipts/, "readiness is derived from completed probe receipts");
    assert.doesNotMatch(route, /lastTestedAt:[^\n]*lastSeenAt/, "a heartbeat timestamp must never be reported as a test timestamp");
    assert.match(route, /code === null \|\| code === "ready" \|\| code === "probe_required"/, "a fresh receipt cannot override an explicit heartbeat failure");
    assert.match(panel, /addEventListener\("oasis:agent-configs-changed"/, "connecting a key below refreshes the engine panel immediately");
    assert.match(panel, /status\?\.label === "Unsupported"/, "an unsupported Gemini account disables reconnect and offers the API path");
    assert.match(panel, /provider === "gemini" \?/, "Gemini never renders the unsupported CLI auth action");
    assert.match(panel, /Managed Gemini CLI account detected/, "a connector-detected managed Gemini account keeps Test without a fake reconnect");
    assert.match(panel, /Choose a computer to finish upgrading this saved setup\./, "legacy unbound rows explain the one required upgrade action");
    const connectFlow = panel.slice(panel.indexOf("async function connect"), panel.indexOf("const modeOption"));
    assert.match(connectFlow, /await pollRuntimeJob\(/, "the dashboard stays open and polls the selected computer's auth job");
    assert.match(connectFlow, /text:\s*started\.text/, "the exact vendor command stays visible while the selected computer authenticates");
    assert.match(connectFlow, /await testSelection\(\)/, "a completed sign-in automatically re-tests the same selected setup");
    assert.match(panel, /Installed apps and local models/, "the consolidated panel retains the per-computer inventory");
    assert.match(panel, /inventoryRuntimeLabel/, "inventory distinguishes installed, signed-in and execution-tested runtimes");
  });

  await check("Codex subscription rollout is limited to approved OASIS computers", () => {
    assert.equal(rollout.subscriptionRolloutError("codex", false), "codex_oasis_rollout_only");
    assert.equal(rollout.subscriptionRolloutError("codex", true), null);
    assert.equal(rollout.subscriptionRolloutError("claude", false), null);
    const route = readFileSync(join(ROOT, "app/api/ai/engine/route.ts"), "utf8");
    assert.match(route, /subscriptionRolloutError\(selection\.provider, oasis\)/, "probe and save use the server-side rollout gate");
    assert.match(route, /pairingForSelection/, "the rollout gate is followed by exact-pairing approval checks");
    const runSession = readFileSync(join(ROOT, "lib/os/runs/session.ts"), "utf8");
    assert.match(
      runSession,
      /subscriptionRolloutError\(selectedEngine\.cli, oasisWorkspace\)/,
      "department execution reapplies the rollout gate to legacy and already-saved rows",
    );
  });

  await check("every member can open AI brain and Devices for their own setup, while workspace controls remain manager-only", () => {
    const member = { canManage: false, isOperator: false, canSeeTeamPerformance: false, oasisWorkspace: false };
    assert.equal(settings.maySeeSettingsSection(member, "ai"), true);
    assert.equal(settings.maySeeSettingsSection(member, "devices"), true);
    assert.equal(settings.maySeeSettingsSection(member, "brand"), false);
    assert.equal(settings.maySeeSettingsSection(member, "billing"), false);
    const route = readFileSync(join(ROOT, "app/api/ai/engine/route.ts"), "utf8");
    assert.match(route, /const visiblePairings = canManage \? pairings : pairings\.filter\(\(pairing\) => pairing\.user_id === ctx\.authUserId\)/, "members must never receive teammate device labels, owners, or inventory");
    assert.match(route, /inventoryByPairing\(tenantId, visiblePairings\)/, "even the inventory lookup is limited to devices visible to the caller");
    assert.match(route, /if \(scope !== "workspace"\)[\s\S]*api_provider_workspace_scope_required/, "a personal choice must never activate a workspace-wide API provider");
  });

  await check("the old separately-mounted cards render nothing", () => {
    const person = readFileSync(join(ROOT, "components/settings/PersonEngineCard.tsx"), "utf8");
    const local = readFileSync(join(ROOT, "components/settings/LocalCliProvidersCard.tsx"), "utf8");
    const content = readFileSync(join(ROOT, "components/settings/SettingsContent.tsx"), "utf8");
    assert.match(person, /export function PersonEngineCard\([^)]*\)\s*\{\s*return null;\s*\}/s);
    assert.match(local, /export function LocalCliProvidersCard\([^)]*\)\s*\{[\s\S]*?return null;\s*\}/);
    assert.doesNotMatch(content, /<PersonEngineCard\b|<LocalCliProvidersCard\b|title="How your departments think"/);
    assert.match(content, /section !== "ai" && section !== "devices"/, "members must reach their personal AI and Devices surfaces");
  });

  const DEVICE = {
    pairingId: "pair-win",
    label: "CCPC (Windows)",
    ownerName: "CC",
    ownedByViewer: true,
    workspaceEligible: true,
    os: "windows",
    lastSeenAt: "2026-10-12T06:00:00.000Z",
    approved: true,
    online: true,
    busy: false,
    protocols: ["department_task_v2", "runtime_action_v1", "coding_harness_task_v1"],
    runtimes: {
      claude: { installed: true, signedIn: true, executionReady: false, unsupported: false, version: "2.1.270", lastTestedAt: null, code: null },
      codex: { installed: true, signedIn: true, executionReady: true, unsupported: false, version: "0.146.0", lastTestedAt: "2026-10-12T06:00:00.000Z", code: null },
      gemini: { installed: true, signedIn: false, executionReady: false, unsupported: true, version: "0.63.0", lastTestedAt: null, code: "unsupported_personal_sign_in" },
    },
    localModels: [{ ref: "ollama/llama3.3", label: "Llama 3.3", adapter: "ollama", state: "ready", lastTestedAt: "2026-10-12T06:00:00.000Z" }],
  } as const;

  await check("GET parsing keeps person scope, exact devices and execution verification, while old responses still parse", async () => {
    const next = await client.readEngine(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          engine: { mode: "subscription", provider: "codex", pairingId: "pair-win", fallback: "none" },
          engineVersion: "v2",
          engineVersions: { person: null, workspace: "workspace-v5" },
          personEngine: { source: "person", selection: { mode: "subscription", provider: "codex", pairingId: "pair-win", fallback: "none" } },
          devices: [DEVICE],
          canManage: true,
          workspace: "oasis",
          account: null,
          savedProviders: [],
        }),
        { status: 200 },
      ),
    );
    assert.equal(next.ok, true);
    if (next.ok) {
      assert.equal(next.state.personEngine.source, "person");
      assert.deepEqual(next.state.engineVersions, { person: null, workspace: "workspace-v5" }, "an absent personal row stays null; it never borrows the workspace version");
      assert.equal(next.state.devices[0].pairingId, "pair-win");
      assert.equal(next.state.devices[0].workspaceEligible, true);
      assert.equal(next.state.devices[0].runtimes.claude.executionReady, false, "signed in is not execution verified");
      assert.equal(next.state.devices[0].runtimes.codex.executionReady, true);
    }

    const legacy = await client.readEngine(async () =>
      new Response(JSON.stringify({ ok: true, engine: { kind: "api" }, bridge: { reachable: true }, canManage: false, workspace: "client" }), { status: 200 }),
    );
    assert.equal(legacy.ok, true);
    if (legacy.ok) {
      assert.deepEqual(legacy.state.devices, []);
      assert.equal(legacy.state.personEngine.source, "workspace");
      assert.deepEqual(legacy.state.engineVersions, { person: null, workspace: null });
    }
  });

  await check("device choices are scoped: members get their computers and workspace defaults get only the agents owner's computers", () => {
    const mine = DEVICE;
    const teammate = { ...DEVICE, pairingId: "pair-team", ownedByViewer: false, workspaceEligible: false };
    const owner = { ...DEVICE, pairingId: "pair-owner", ownedByViewer: false, workspaceEligible: true };
    assert.deepEqual(client.engineDevicesForScope([mine, teammate, owner], "person").map((item) => item.pairingId), ["pair-win"]);
    assert.deepEqual(client.engineDevicesForScope([mine, teammate, owner], "workspace").map((item) => item.pairingId), ["pair-win", "pair-owner"]);
  });

  await check("signed in never becomes execution verified without a successful probe", () => {
    assert.deepEqual(client.describeRuntime(DEVICE, "claude"), {
      label: "Needs test",
      verified: false,
      repair: "Test Claude Code on CCPC (Windows) before using it for agents.",
    });
    assert.deepEqual(client.describeRuntime(DEVICE, "codex"), {
      label: "Ready for agents",
      verified: true,
      repair: null,
    });
    const gemini = client.describeRuntime(DEVICE, "gemini");
    assert.equal(gemini.label, "Unsupported");
    assert.equal(gemini.verified, false);
    assert.match(gemini.repair ?? "", /Google API key/);
    assert.equal(client.describeRuntime({ ...DEVICE, busy: true }, "gemini").label, "Unsupported", "busy never masks an unsupported account");
    assert.equal(
      client.describeRuntime({
        ...DEVICE,
        runtimes: {
          ...DEVICE.runtimes,
          gemini: { ...DEVICE.runtimes.gemini, unsupported: false, installed: true, signedIn: false },
        },
      }, "gemini").label,
      "Unsupported",
      "an installed Gemini CLI without a connector-detected managed account offers Google API instead of a login loop",
    );
    assert.match(client.repairForCode("runtime_unavailable", "CCPC") ?? "", /oasis bridge restart/);
    assert.match(client.repairForCode("not_authenticated", "CCPC") ?? "", /Sign in/);
    assert.match(client.repairForCode("engine_not_found", "CCPC") ?? "", /Start Ollama or LM Studio/);
    assert.match(client.repairForCode("not_authenticated", "CCPC", "claude") ?? "", /claude\n\/login/);
    assert.match(client.repairForCode("not_authenticated", "CCPC", "gemini") ?? "", /Google API key/);
    assert.equal(client.describeRuntime({ ...DEVICE, approved: false }, "codex").label, "Approval needed");
    assert.equal(client.describeRuntime({ ...DEVICE, online: false }, "codex").label, "Offline");
    assert.equal(client.describeRuntime({ ...DEVICE, busy: true }, "codex").label, "Busy");
    assert.equal(
      client.describeRuntime(
        { ...DEVICE, runtimes: { ...DEVICE.runtimes, codex: { ...DEVICE.runtimes.codex, installed: false, executionReady: false } } },
        "codex",
      ).label,
      "Not installed",
    );
    assert.equal(
      client.describeRuntime(
        { ...DEVICE, runtimes: { ...DEVICE.runtimes, codex: { ...DEVICE.runtimes.codex, signedIn: false, executionReady: false } } },
        "codex",
      ).label,
      "Sign-in needed",
    );
    const unidentifiedClaude = client.describeRuntime(
      {
        ...DEVICE,
        runtimes: {
          ...DEVICE.runtimes,
          claude: {
            ...DEVICE.runtimes.claude,
            installed: true,
            signedIn: true,
            executionReady: false,
            code: "account_identity_unavailable",
          },
        },
      },
      "claude",
    );
    assert.equal(unidentifiedClaude.label, "Sign-in needed");
    assert.match(unidentifiedClaude.repair ?? "", /Open Claude Code once on CCPC \(Windows\)/);
    assert.match(unidentifiedClaude.repair ?? "", /restart the OASIS connector/);
    assert.equal(client.describeLocalModel(DEVICE, DEVICE.localModels[0]).label, "Ready for agents");
    assert.equal(client.describeLocalModel(DEVICE, { ...DEVICE.localModels[0], state: "probe_required" }).label, "Needs test");
    assert.equal(client.describeLocalModel(DEVICE, { ...DEVICE.localModels[0], state: "unavailable" }).label, "Offline");
    assert.equal(client.describeLocalModel({ ...DEVICE, busy: true }, DEVICE.localModels[0]).label, "Busy");
    assert.equal(client.describeLocalModel(DEVICE, undefined).label, "Not installed");
    const oldConnector = { ...DEVICE, protocols: ["department_task_v2", "runtime_action_v1"] };
    assert.equal(client.describeRuntime(oldConnector, "codex").label, "Needs test");
    assert.equal(client.describeLocalModel(oldConnector, oldConnector.localModels[0]).label, "Needs test");
  });

  await check("Test queues and polls the exact pairing; Use includes the successful probe receipt", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetcher = async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : null });
      if (url === "/api/ai/engine" && init.method === "POST") return new Response(JSON.stringify({ job_id: "job-7" }), { status: 202 });
      if (url === "/api/bridge/runtime-jobs/job-7") {
        return new Response(JSON.stringify({ ok: true, job: { id: "job-7", status: "done", action: "probe", engine: { kind: "cli", name: "codex" }, errorCode: null, message: null, result: { reply: "ok", latency_ms: 410 } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, engineVersion: "v3" }), { status: 200 });
    };
    const selection = { mode: "subscription", provider: "codex", pairingId: "pair-win", fallback: "none" } as const;
    const queued = await client.queueEngineProbe(selection, "person", fetcher);
    assert.deepEqual(queued, { ok: true, jobId: "job-7" });
    const job = await client.readRuntimeJob("job-7", fetcher);
    assert.equal(job.ok && job.job.status, "done");
    const saved = await client.saveEngine(selection, "v2", fetcher, { scope: "person", probeJobId: "job-7" });
    assert.equal(saved.ok, true);
    assert.deepEqual(calls[0], {
      url: "/api/ai/engine",
      method: "POST",
      body: { engine: selection, scope: "person" },
    });
    assert.deepEqual(calls[1], { url: "/api/bridge/runtime-jobs/job-7", method: "GET", body: null });
    assert.deepEqual(calls[2], {
      url: "/api/ai/engine",
      method: "PUT",
      body: { engine: selection, scope: "person", expected_version: "v2", probe_job_id: "job-7" },
    });
  });

  await check("job polling follows queued and waiting-user states to the exact terminal receipt", async () => {
    const statuses = ["queued", "waiting_user", "done"] as const;
    const urls: string[] = [];
    const updates: string[] = [];
    const result = await client.pollRuntimeJob(
      "job-8",
      async (url) => {
        urls.push(url);
        const status = statuses[Math.min(urls.length - 1, statuses.length - 1)];
        return new Response(
          JSON.stringify({
            ok: true,
            job: {
              id: "job-8",
              status,
              action: "auth",
              engine: { kind: "cli", name: "codex" },
              errorCode: null,
              message: status === "waiting_user" ? "Finish sign-in." : null,
              result: status === "waiting_user" ? { instructions: "Open the browser on CCPC." } : status === "done" ? { reply: "ok" } : null,
            },
          }),
          { status: 200 },
        );
      },
      { intervalMs: 0, onUpdate: (job) => updates.push(job.status) },
    );
    assert.equal(result.ok && result.job.status, "done");
    assert.deepEqual(updates, ["queued", "waiting_user", "done"]);
    assert.deepEqual(urls, Array(3).fill("/api/bridge/runtime-jobs/job-8"));
  });

  await check("Connect names the provider and exact pairing", async () => {
    const calls: string[] = [];
    const result = await startCliSignIn("codex", "pair-win", async (url, init) => {
      calls.push(`${init.method} ${url} ${String(init.body)}`);
      return new Response(JSON.stringify({ job_id: "auth-2", command: "codex login", message: "Open the sign-in window on CCPC." }), { status: 202 });
    });
    assert.equal(result.ok, true);
    assert.equal(result.jobId, "auth-2");
    assert.deepEqual(calls, ['POST /api/bridge/cli-auth {"provider":"codex","pairing_id":"pair-win"}']);

    let geminiCalled = false;
    const unsupported = await startCliSignIn("gemini", "pair-win", async () => {
      geminiCalled = true;
      return new Response(null, { status: 204 });
    });
    assert.equal(unsupported.ok, false);
    assert.equal(geminiCalled, false, "Gemini personal CLI never enters an auth loop");
    assert.match(unsupported.text, /Google API key/);
  });

  await check("Connect returns the hard-coded vendor instructions while the dashboard polls", async () => {
    const result = await startCliSignIn("claude", "pair-mac", async () =>
      new Response(
        JSON.stringify({
          ok: true,
          job_id: "auth-claude-1",
          command: "claude then /login",
          message: "Sign-in was queued for MacBook.",
          instructions: "Launch claude, then type /login on MacBook. This page will update automatically.",
        }),
        { status: 202 },
      ),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.match(result.text, /Launch claude, then type \/login/);
      assert.equal(result.command, "claude then /login");
      assert.equal(result.jobId, "auth-claude-1");
    }
  });

  await check("switching a saved API provider changes the workspace account before engine save", async () => {
    const calls: string[] = [];
    const switched = await client.switchProvider("google", async (url, init) => {
      calls.push(`${init.method} ${url} ${String(init.body)}`);
      return new Response(JSON.stringify({ ok: true, label: "Google Gemini" }), { status: 200 });
    });
    assert.deepEqual(switched, { ok: true, label: "Google Gemini" });
    assert.deepEqual(calls, ['POST /api/agent-config/workspace-provider {"provider":"google"}']);
  });

  await check("a member can explicitly return to workspace inheritance", async () => {
    const calls: string[] = [];
    const result = await client.inheritWorkspaceEngine("v2", async (url, init) => {
      calls.push(`${init.method} ${url} ${String(init.body)}`);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calls, ['PUT /api/ai/engine {"scope":"person","use_workspace_default":true,"expected_version":"v2"}']);
  });

  await check("API key mode saves without a computer probe job", async () => {
    const calls: string[] = [];
    const result = await client.saveEngine(
      { mode: "api", provider: "google" },
      "workspace-v5",
      async (url, init) => {
        calls.push(`${init.method} ${url} ${String(init.body)}`);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      { scope: "workspace" },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ['PUT /api/ai/engine {"engine":{"mode":"api","provider":"google"},"scope":"workspace","expected_version":"workspace-v5"}']);
  });

  if (failures) {
    console.log(`ai-brain-engine-settings: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("ai-brain-engine-settings: all passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
