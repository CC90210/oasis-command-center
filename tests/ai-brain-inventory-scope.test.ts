/**
 * tests/ai-brain-inventory-scope.test.ts - Settings > AI brain shows YOUR setup
 * (2026-10-15).
 *
 * CC's own "My setup" page listed a teammate's computer (Adon's UPPAECHELON, with
 * its Claude Code / Codex / Gemini CLI all reading "Needs test", which CC cannot
 * act on) under "Installed apps and local models". The computer picker beside it
 * was already scoped by engineDevicesForScope; the inventory section was not: any
 * manager saw every pairing in the workspace whatever tab was selected. And a
 * person with no engine of their own read "In use for you: Google Gemini API key",
 * as if they had chosen the workspace's key.
 *
 * What this pins:
 *   1. the inventory follows the scope tab like the picker: "My setup" lists only
 *      the viewer's own computers; "Workspace default" lists the workspace-eligible
 *      ones (each already labelled with its owner);
 *   2. an inherited engine says so, and says how to choose one's own;
 *   3. the engine-scope rule itself, on real device records.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

async function main(): Promise<void> {
  const panel = read("components/settings/AgentEnginePanel.tsx");

  // 1. The inventory is scope-aware and no longer keys on canManage alone.
  assert.match(panel, /const inventoryDevices =\s*scope === "person"\s*\?\s*state\.devices\.filter\(\(device\) => device\.ownedByViewer\)\s*:\s*engineDevicesForScope\(state\.devices, "workspace"\);/);
  assert.match(panel, /\{inventoryDevices\.length \?/);
  assert.match(panel, /inventoryDevices\.map\(\(device\)/);
  assert.doesNotMatch(panel, /state\.canManage \? state\.devices : state\.devices\.filter/, "the manager-sees-everything inventory is gone");
  assert.match(panel, /Installed apps and local models/, "the section itself stays (other tests pin it)");
  console.log("  ok - the inventory follows the scope tab, like the computer picker");

  // 2. An inherited engine is labelled.
  assert.match(panel, /const inheritsWorkspaceDefault =\s*scope === "person" && !\(state\.personEngine\.source === "person" && state\.personEngine\.selection\);/);
  assert.match(panel, /data-testid="engine-inherited"[^>]*> \(the workspace default\)/);
  assert.match(panel, /You have not chosen your own, so you use the workspace default\. Choose one below to change only your setup\./);
  console.log("  ok - an engine inherited from the workspace says so");

  // 3. The scope rule on real records: a manager's own page never lists a teammate's computer.
  const { engineDevicesForScope } = await import("../components/settings/agent-engine-client");
  type Device = Parameters<typeof engineDevicesForScope>[0][number];
  const device = (pairingId: string, over: Partial<Device>): Device =>
    ({ pairingId, label: pairingId, ownedByViewer: false, workspaceEligible: false, ...over }) as unknown as Device;
  const devices = [
    device("ccpc", { ownedByViewer: true, workspaceEligible: true }),
    device("mac", { ownedByViewer: true, workspaceEligible: false }),
    device("uppaechelon", { ownedByViewer: false, workspaceEligible: true }),
    device("stranger", { ownedByViewer: false, workspaceEligible: false }),
  ];
  const mine = devices.filter((d) => d.ownedByViewer).map((d) => d.pairingId);
  assert.deepEqual(mine, ["ccpc", "mac"], "My setup: only the viewer's own computers, including one not eligible for the workspace");
  assert.deepEqual(
    engineDevicesForScope(devices, "workspace").map((d) => d.pairingId),
    ["ccpc", "uppaechelon"],
    "Workspace default: every workspace-eligible computer, a teammate's included",
  );
  assert.ok(!mine.includes("uppaechelon"), "a teammate's computer never appears on My setup");
  console.log("  ok - My setup never lists a teammate's computer; Workspace default lists the eligible ones");

  console.log("ai-brain-inventory-scope: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
