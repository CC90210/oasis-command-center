/**
 * Canonical AI Brain engine-selection contract.
 *
 * Run: node --conditions=react-server --import tsx tests/agent-engine-selection.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const engine = await import("../lib/ai/agent-engine");

  const subscription = {
    mode: "subscription",
    pairingId: "pair-ccpc",
    provider: "codex",
    fallback: "none",
  } as const;
  assert.deepEqual(engine.parseEngineSelection(subscription), subscription);
  assert.deepEqual(engine.parseEngineChoice(subscription), {
    kind: "cli",
    cli: "codex",
    pairingId: "pair-ccpc",
    fallback: "none",
  });

  const local = {
    mode: "local",
    pairingId: "pair-mac",
    modelRef: "ollama/llama3.3",
    fallback: "workspace_api",
  } as const;
  assert.deepEqual(engine.parseEngineSelection(local), local);
  assert.deepEqual(engine.parseEngineChoice(local), {
    kind: "local",
    model: "ollama/llama3.3",
    pairingId: "pair-mac",
    fallback: "workspace_api",
  });

  const api = { mode: "api", provider: "google" } as const;
  assert.deepEqual(engine.parseEngineSelection(api), api);
  assert.deepEqual(engine.parseEngineChoice(api), { kind: "api", provider: "google" });

  assert.equal(engine.parseEngineSelection({ ...subscription, pairingId: "" }), null);
  assert.equal(engine.parseEngineSelection({ ...subscription, provider: "bash" }), null);
  assert.equal(engine.parseEngineSelection({ ...subscription, fallback: "always" }), null);
  assert.equal(engine.parseEngineSelection({ ...local, modelRef: "http://public.example/model" }), null);
  assert.equal(engine.parseEngineSelection({ ...api, provider: "ollama" }), null);

  assert.deepEqual(
    engine.engineFromRow({
      provider: "cli",
      model: "claude",
      computer_pairing_id: "pair-1",
      fallback_policy: "workspace_api",
    }),
    { kind: "cli", cli: "claude", pairingId: "pair-1", fallback: "workspace_api" },
  );
  assert.deepEqual(engine.engineRow({ kind: "cli", cli: "codex", pairingId: "pair-2", fallback: "none" }), {
    provider: "cli",
    model: "codex",
    computerPairingId: "pair-2",
    fallbackPolicy: "none",
  });
  assert.deepEqual(engine.engineFromRow({ provider: "api", model: "google" }), { kind: "api", provider: "google" });
  assert.deepEqual(engine.engineRow({ kind: "api", provider: "openai" }), {
    provider: "api",
    model: "openai",
    computerPairingId: null,
    fallbackPolicy: "none",
  });

  // The coding harness carries the complete saved device binding. A local
  // choice is a real device route too; it must never be rewritten to Claude.
  assert.deepEqual(engine.harnessRouteFor({
    kind: "cli",
    cli: "codex",
    pairingId: "pair-ccpc",
    fallback: "none",
  }), {
    mode: "cli",
    runtime: "codex",
    pairingId: "pair-ccpc",
    engineKind: "subscription",
    engineName: "codex",
    fallback: "none",
    note: null,
  });
  assert.deepEqual(
    engine.harnessRouteFor({
      kind: "local",
      model: "ollama/llama3.3",
      pairingId: "pair-mac",
      fallback: "workspace_api",
    }),
    {
      mode: "cli",
      runtime: null,
      pairingId: "pair-mac",
      engineKind: "local",
      engineName: "ollama/llama3.3",
      fallback: "workspace_api",
      note: null,
    },
  );
  assert.notEqual(engine.harnessRouteFor({ kind: "local", model: "ollama/llama3.3" }).runtime, "claude");
  assert.equal(engine.harnessRouteFor({ kind: "local", model: "ollama/llama3.3" }).mode, "unavailable");
  assert.equal(engine.harnessRouteFor({ kind: "cli", cli: "codex" }).mode, "unavailable");

  const widget = readFileSync(join(process.cwd(), "components/ChatWidget.tsx"), "utf8");
  assert.match(
    widget,
    /if \(route\.mode === "unavailable"\) return;\s*setChatModeState\(route\.mode\);/,
    "an unbound legacy harness route must not replace the active transport",
  );
  assert.match(
    widget,
    /if \(harnessUnavailableMessage\) \{[\s\S]{0,240}setErrorCode\("coding_harness_engine_unavailable"\);[\s\S]{0,120}return;/,
    "every send path must stop before choosing another engine",
  );
  assert.match(
    widget,
    /disabled=\{!ready \|\| streaming \|\| !agentsEngine \|\| Boolean\(harnessUnavailableMessage\)\}/,
    "the composer must stay closed while the canonical engine is unknown or unavailable",
  );
  assert.match(widget, /data-testid="coding-harness-engine-unavailable"/, "the repair guidance is visible beside the composer");
  assert.match(widget, /target_pairing_id:\s*harnessRoute\?\.mode === "cli" \? harnessRoute\.pairingId : undefined/);
  assert.match(widget, /runtime_engine_kind:\s*harnessRoute\?\.mode === "cli" \? harnessRoute\.engineKind : undefined/);
  assert.match(widget, /runtime_engine_name:\s*harnessRoute\?\.mode === "cli" \? harnessRoute\.engineName : undefined/);
  assert.match(widget, /fallback_policy:\s*harnessRoute\?\.mode === "cli" \? harnessRoute\.fallback : undefined/);
  assert.doesNotMatch(widget, /cli_provider:\s*cliRuntime/, "the wire runtime must come from the saved engine, never remembered browser state");

  // Old rows and payloads remain readable while the exact-device rollout is in progress.
  assert.deepEqual(engine.parseEngineChoice({ kind: "cli", cli: "claude" }), { kind: "cli", cli: "claude" });
  assert.deepEqual(engine.engineFromRow({ provider: "local", model: "llama3.3" }), { kind: "local", model: "llama3.3" });
  assert.deepEqual(engine.selectionFromRequest({ kind: "api" }, "google"), { selection: { mode: "api", provider: "google" }, legacy: true });
  assert.deepEqual(engine.selectionFromRequest({ kind: "cli", cli: "codex", pairingId: "pair-ccpc" }), {
    selection: { mode: "subscription", provider: "codex", pairingId: "pair-ccpc", fallback: "none" },
    legacy: true,
  });
  assert.deepEqual(engine.selectionFromRequest({ kind: "cli", cli: "codex" }), { selection: null, legacy: true, needsPairing: true });

  console.log("agent-engine-selection: 28 assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
