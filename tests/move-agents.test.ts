/**
 * Settings > Devices "Use for agents", and AI brain keeping its computers on
 * screen (CC 2026-10-27).
 *
 *   - "whenever I'm using a different computer, I select which computer I'm
 *     working on": one press moves the agents' setup to another computer, but
 *     only after the same Test AI brain runs passes there. A failed Test never
 *     saves, and the agents stay where they were.
 *   - "the computer ... sometimes disappears": a failed refresh keeps the last
 *     reading on screen, and a failed agents-owner read is retried instead of
 *     emptying the computer list.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`);
  }
}

type Runtime = { installed: boolean; signedIn: boolean; executionReady: boolean; unsupported: boolean; version: string | null; lastTestedAt: string | null; code: string | null };
const rt = (over: Partial<Runtime> = {}): Runtime => ({ installed: false, signedIn: false, executionReady: false, unsupported: false, version: null, lastTestedAt: null, code: null, ...over });

const device = (over: Record<string, unknown> = {}) => ({
  pairingId: "pair-mac",
  label: "192.168.11.27 (Mac)",
  ownerName: null,
  ownedByViewer: true,
  workspaceEligible: true,
  agentClaimEligible: true,
  os: "Mac",
  lastSeenAt: new Date().toISOString(),
  approved: true,
  online: true,
  busy: false,
  protocols: ["department_task_v2", "runtime_action_v1", "coding_harness_task_v1"],
  runtimes: {
    claude: rt({ installed: true, signedIn: true, code: "probe_failed" }),
    codex: rt({ installed: true, signedIn: true, executionReady: true, code: "ready" }),
    opencode: rt({ installed: true, signedIn: false, code: "needs_sign_in" }),
  },
  localModels: [],
  ...over,
});

const pc = device({ pairingId: "pair-pc", label: "CCPC (Windows)", online: false, os: "Windows" });

/** CC's workspace on 2026-10-27: the workspace default was Codex on the PC, which had been off since October 22. */
const state = (over: Record<string, unknown> = {}) => ({
  engine: { mode: "subscription", pairingId: "pair-pc", provider: "codex", fallback: "none" },
  personEngine: { source: "workspace", selection: null },
  devices: [device(), pc],
  account: null,
  savedProviders: [],
  savedKeyReceipts: {},
  bridgeReachable: true,
  canManage: true,
  oasis: true,
  engineVersion: "v-1",
  engineVersions: { person: null, workspace: "v-1" },
  ...over,
});

async function main() {
  const move = await import("../components/settings/move-agents");

  await check("the agents' setup is My setup when chosen, else the workspace default for a manager", () => {
    assert.equal(move.agentsSetup(state() as never).scope, "workspace");
    const own = { mode: "api", provider: "anthropic" };
    assert.deepEqual(move.agentsSetup(state({ personEngine: { source: "person", selection: own } }) as never), { scope: "person", selection: own });
    assert.equal(move.agentsSetup(state({ canManage: false }) as never).scope, "person", "a member who cannot change the default moves their own setup");
  });

  await check("the same app moves when the computer has it signed in; otherwise the first other signed-in app", () => {
    const current = state().engine as never;
    assert.deepEqual(move.selectionFor(device() as never, current, true), {
      ok: true,
      selection: { mode: "subscription", pairingId: "pair-mac", provider: "codex", fallback: "none" },
    });
    const noCodex = device({ runtimes: { ...device().runtimes, codex: rt() } });
    const picked = move.selectionFor(noCodex as never, current, true);
    assert.equal(picked.ok && picked.selection.mode === "subscription" && picked.selection.provider, "claude", "Claude Code is signed in there: Needs test, so it can be tried");
    const nothing = device({ runtimes: { claude: rt(), codex: rt(), opencode: rt({ installed: true }) } });
    const none = move.selectionFor(nothing as never, current, true);
    assert.equal(none.ok, false);
    assert.match(!none.ok ? none.reason : "", /No AI app is signed in and ready on 192\.168\.11\.27 \(Mac\)/);
    // A client workspace never gets Codex or OpenCode picked for it.
    const client = move.selectionFor(device({ runtimes: { ...device().runtimes, claude: rt() } }) as never, current, false);
    assert.equal(client.ok, false);
  });

  await check("a local model moves to the same model on the new computer", () => {
    const local = { mode: "local", pairingId: "pair-pc", modelRef: "ollama/llama3.3", fallback: "workspace_api" } as never;
    const withModel = device({ localModels: [{ ref: "ollama/llama3.3", label: "Llama 3.3", adapter: "ollama", state: "ready", lastTestedAt: null }] });
    assert.deepEqual(move.selectionFor(withModel as never, local, true), {
      ok: true,
      selection: { mode: "local", pairingId: "pair-mac", modelRef: "ollama/llama3.3", fallback: "workspace_api" },
    });
    // The same model reported unavailable there: the next usable one is tried instead.
    const stale = device({ localModels: [
      { ref: "ollama/llama3.3", label: "Llama 3.3", adapter: "ollama", state: "unavailable", lastTestedAt: null },
      { ref: "ollama/qwen3", label: "Qwen 3", adapter: "ollama", state: "ready", lastTestedAt: null },
    ] });
    const picked = move.selectionFor(stale as never, local, true);
    assert.equal(picked.ok && picked.selection.mode === "local" && picked.selection.modelRef, "ollama/qwen3");
    // No local model there: refused, never switched to a signed-in hosted app (Claude Code and Codex are signed in on this device).
    const none = move.selectionFor(device() as never, local, true);
    assert.equal(none.ok, false);
    assert.match(!none.ok ? none.reason : "", /has no local model/);
  });

  const realFetch = globalThis.fetch;
  async function withFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>, fn: () => Promise<void>) {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {})) as typeof fetch;
    try {
      await fn();
    } finally {
      globalThis.fetch = realFetch;
    }
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  await check("Use for agents: Test on that computer, then Use with that exact probe; never the other way round", async () => {
    const calls: string[] = [];
    let saved: Record<string, unknown> | null = null;
    await withFetch(async (url, init) => {
      calls.push(`${init.method ?? "GET"} ${url}`);
      if (url === "/api/ai/engine" && init.method === "POST") return json(202, { ok: true, job_id: "job-1" });
      if (url.startsWith("/api/bridge/runtime-jobs/")) return json(200, { ok: true, job: { id: "job-1", status: "completed", action: "probe", result: { reply: "ok" } } });
      if (url === "/api/ai/engine" && init.method === "PUT") {
        saved = JSON.parse(String(init.body));
        return json(200, { ok: true });
      }
      return json(500, {});
    }, async () => {
      const progress: string[] = [];
      const result = await move.moveAgentsToComputer(device() as never, state() as never, (w) => progress.push(w));
      assert.deepEqual(result, { ok: true, words: "Your workspace's agents now run on Codex on 192.168.11.27 (Mac)." });
      assert.deepEqual(progress, ["Testing Codex on 192.168.11.27 (Mac)…", "Codex on 192.168.11.27 (Mac) passed. Putting it in use…"]);
    });
    assert.deepEqual(calls, ["POST /api/ai/engine", "GET /api/bridge/runtime-jobs/job-1", "PUT /api/ai/engine"]);
    assert.deepEqual(saved, {
      engine: { mode: "subscription", pairingId: "pair-mac", provider: "codex", fallback: "none" },
      scope: "workspace",
      expected_version: "v-1",
      probe_job_id: "job-1",
    });
  });

  await check("a failed Test saves nothing, says why with the repair, and says the agents stayed put", async () => {
    const calls: string[] = [];
    await withFetch(async (url, init) => {
      calls.push(`${init.method ?? "GET"} ${url}`);
      if (url === "/api/ai/engine" && init.method === "POST") return json(202, { ok: true, job_id: "job-2" });
      return json(200, { ok: true, job: { id: "job-2", status: "failed", action: "probe", error_code: "cli_update_required", message: "Claude Code on this computer is out of date." } });
    }, async () => {
      const noCodex = device({ runtimes: { ...device().runtimes, codex: rt() } });
      const result = await move.moveAgentsToComputer(noCodex as never, state() as never, () => {});
      assert.equal(result.ok, false);
      assert.match(result.words, /^Claude Code on 192\.168\.11\.27 \(Mac\): Claude Code on this computer is out of date\./);
      assert.match(result.words, /npm install -g @anthropic-ai\/claude-code@latest/);
      assert.match(result.words, /Your agents still run where they did\.$/);
    });
    assert.equal(calls.some((c) => c.startsWith("PUT")), false, "no save after a failed test");
  });

  await check("a computer that cannot run the workspace's agents is refused before anything is queued", async () => {
    const calls: string[] = [];
    await withFetch((url, init) => {
      calls.push(`${init.method} ${url}`);
      return json(500, {});
    }, async () => {
      const teammates = device({ workspaceEligible: false });
      const result = await move.moveAgentsToComputer(teammates as never, state() as never, () => {});
      assert.equal(result.ok, false);
    });
    assert.deepEqual(calls, []);
  });

  await check("Devices names the computer the agents run on, flags it offline, and offers Use for agents on the others", () => {
    const card = readFileSync(join(ROOT, "components/settings/YourComputersCard.tsx"), "utf8");
    assert.match(card, /data-testid="agents-run-on"/);
    assert.match(card, /it is offline, so they cannot answer/);
    assert.match(card, /it is offline, so the workspace API account answers until it is back/, "an armed API fallback is not 'cannot answer'");
    assert.match(card, /a computer that is not in your list here/);
    assert.match(card, /data-testid="runs-agents-badge"/);
    assert.match(card, /device\.pairingId !== agentsOn && device\.online && device\.approved && device\.agentClaimEligible && eligibleFor\(device, setup\.scope\)/);
    assert.match(card, /moveAgentsToComputer\(device, engine\.state, setNotice\)/);
  });

  await check("AI brain keeps its last reading when a refresh fails, and re-reads its computers while open", () => {
    const panel = readFileSync(join(ROOT, "components/settings/AgentEnginePanel.tsx"), "utf8");
    assert.match(panel, /if \(hasStateRef\.current\) setRefreshWarning\(`\$\{result\.message\} Showing the last reading\.`\);\n\s+else setReadError\(result\.message\);/);
    assert.match(panel, /ENGINE_AUTO_REFRESH_MS = 30_000/);
    assert.match(panel, /hasStateRef\.current && activityRef\.current === null && document\.visibilityState === "visible"\) void refreshComputers\(\)/, "only when idle and in view");
    // Codex review of #758: the background read must not move the Save's version
    // or key receipts under an unsaved draft, nor clear a running Test's activity.
    const background = panel.slice(panel.indexOf("async function refreshComputers"), panel.indexOf("async function load("));
    assert.ok(background.length > 100, "refreshComputers exists before load");
    assert.match(background, /if \(seq !== readSeq\.current \|\| activityRef\.current !== null\) return;/, "a stale or overtaken read is discarded");
    assert.match(background, /setState\(\(current\) => \(current \? \{ \.\.\.current, devices: result\.state\.devices, bridgeReachable: result\.state\.bridgeReachable \} : current\)\)/);
    for (const banned of ["setActivity", "setStagedKeyReceipts", "setDraft", "engineVersions", "setScopeState"]) {
      assert.equal(background.includes(banned), false, `the background read must not touch ${banned}`);
    }
    const load = panel.slice(panel.indexOf("async function load("), panel.indexOf("useEffect(() => {"));
    assert.match(load, /\+\+readSeq\.current;/, "an explicit read overtakes any background read in flight");
  });

  await check("a failed agents-owner read is retried, then fails loudly instead of hiding every computer", () => {
    const route = readFileSync(join(ROOT, "app/api/ai/engine/route.ts"), "utf8");
    assert.match(route, /const agentsOwner = firstOwnerRead\.state === "unavailable" \? await readAgentsOwner\(tenantId\) : firstOwnerRead;\n\s+if \(agentsOwner\.state === "unavailable"\) throw new Error/);
  });

  console.log(`\n${failures ? `${failures} failed` : "all passed"}`);
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
