/**
 * tests/ai-brain-inventory-scope.test.ts - Settings > AI brain shows YOUR setup
 * (2026-10-15), and says it in the same words as Settings > Devices (2026-10-16).
 *
 * CC's own "My setup" page listed a teammate's computer (Adon's UPPAECHELON, with
 * its Claude Code / Codex / OpenCode all reading "Needs test", which CC cannot
 * act on) under "Installed apps and local models". The computer picker beside it
 * was already scoped by engineDevicesForScope; the inventory section was not: any
 * manager saw every pairing in the workspace whatever tab was selected. And a
 * person with no engine of their own read "In use for you: Google Gemini API key",
 * as if they had chosen the workspace's key.
 *
 * CC 2026-10-16: that inherited line told the person to "choose one below" with
 * nothing to press, and the same computer and app read "Ready for agents" here,
 * "signed in" under Devices, and "Ready for department work" on the Devices row.
 *
 * What this pins:
 *   1. the inventory follows the scope tab like the picker: "My setup" lists only
 *      the viewer's own computers; "Workspace default" lists the workspace-eligible
 *      ones (each already labelled with its owner);
 *   2. an inherited engine says so, and a real "Choose your own" button takes the
 *      person to the runtime choices (drawn and pressed, tests/*.render.ts);
 *   3. the engine-scope rule itself, on real device records;
 *   4. ONE status vocabulary: for the same computers, Devices' app lines read
 *      exactly the words AI brain's inventory reads, from one shared mapping;
 *   5. ONE presence vocabulary: a computer's own state (Online, Idle, Busy,
 *      Offline since ...) reads the same word on AI brain's computer cards, the
 *      Your computers / Team computers rows and Devices (advanced), from
 *      lib/devices/presence.ts presenceWords.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

  // 2. An inherited engine is labelled, and offers a real way to choose one's own.
  assert.match(panel, /const inheritsWorkspaceDefault =\s*scope === "person" && !\(state\.personEngine\.source === "person" && state\.personEngine\.selection\);/);
  assert.match(panel, /data-testid="engine-inherited"[^>]*> \(the workspace default\)/);
  assert.match(panel, /You have not chosen your own, so you use the workspace default\. Choosing your own changes only your setup\./);
  assert.doesNotMatch(panel, /Choose one below to change only your setup/, "the instruction with nothing to press is gone");
  console.log("  ok - an engine inherited from the workspace says so");

  // 3. The scope rule on real records: a manager's own page never lists a teammate's computer.
  const { engineDevicesForScope, describeRuntime, runtimeStatusLabel } = await import("../components/settings/agent-engine-client");
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

  // 4a. One mapping from a state to its words, and every state either screen
  //     reaches goes through it (no word typed twice).
  const words = await import("../lib/bridge-cli-status");
  assert.deepEqual(words.RUNTIME_STATUS_WORDS, {
    ready: "Ready for agents",
    needs_test: "Needs test",
    sign_in_needed: "Sign-in needed",
    not_installed: "Not installed",
    unsupported: "Unsupported",
    limit_reached: "Subscription limit reached",
    busy: "Busy",
    offline: "Offline",
    approval_needed: "Approval needed",
  });
  assert.equal("departmentInventoryLine" in words, false, "the Devices-only inventory vocabulary is retired");
  // Code only: a comment may quote the old words to explain the change.
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const client = code(read("components/settings/agent-engine-client.ts"));
  const card = code(read("components/settings/YourComputersCard.tsx"));
  for (const word of Object.values(words.RUNTIME_STATUS_WORDS)) {
    assert.ok(!client.includes(`"${word}"`), `agent-engine-client.ts types "${word}" itself instead of runtimeStatusWords`);
    assert.ok(!card.includes(`"${word}"`) && !card.includes(`· ${word}`), `YourComputersCard.tsx types "${word}" itself`);
  }
  assert.ok(!/Ready for department work|signed in`|not detected`/.test(card), "a Devices-only word is back");
  assert.match(panel, /runtimeStatusLabel\(device, provider, state\.oasis\)/, "AI brain's inventory reads the shared per-app label");
  assert.match(card, /runtimeStatusLabel\(device, p, oasisWorkspace\)/, "Devices' app lines read the same per-app label");
  assert.match(card, /readEngine\(\)/, "Devices reads the same device runtimes AI brain reads");
  // The rollout gate is part of the shared label: Codex outside OASIS is
  // "Unsupported" on both screens, whatever the computer reports.
  const tested = {
    label: "PC",
    os: "windows",
    approved: true,
    online: true,
    busy: false,
    agentClaimEligible: true,
    protocols: ["runtime_action_v1", "department_task_v2", "coding_harness_task_v1"],
    runtimes: {
      claude: { installed: true, signedIn: true, executionReady: true, unsupported: false, version: null, lastTestedAt: null, code: null },
      codex: { installed: true, signedIn: true, executionReady: true, unsupported: false, version: null, lastTestedAt: null, code: null },
      opencode: { installed: false, signedIn: false, executionReady: false, unsupported: false, version: null, lastTestedAt: null, code: null },
    },
  };
  assert.equal(runtimeStatusLabel(tested, "codex", false), "Unsupported");
  assert.equal(runtimeStatusLabel(tested, "codex", true), describeRuntime(tested, "codex").label);
  assert.equal(runtimeStatusLabel(tested, "claude", false), "Ready for agents");
  console.log("  ok - one mapping from a runtime's state to its words, used by both screens");

  // 2 + 4b. Drawn by the components' real hooks (a child process: this suite
  // runs under react-server, where client hooks cannot run).
  const nodeOptions = (process.env.NODE_OPTIONS || "")
    .split(/\s+/)
    .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
    .join(" ");
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: nodeOptions };
  if (!nodeOptions) delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/ai-brain-inventory-scope.render.ts"], {
    cwd: join(__dirname, ".."),
    encoding: "utf8",
    env,
    timeout: 120_000,
  });
  assert.equal(r.status, 0, `the render process failed:\n${r.stderr || r.stdout}`);
  const out = JSON.parse(r.stdout.trim().split("\n").pop() || "{}") as {
    panel: {
      chooseOwnPresent: boolean;
      chooseOwnText: string | null;
      radiogroupHasRef: boolean;
      radios: Array<{ value: string; checked: boolean }>;
      pressed: { scrolled: unknown; focused: string | null; focusOptions: unknown };
      inUseLine: string;
      inheritedNote: string;
      ownHasButton: boolean;
      ownInherited: boolean;
    };
    aiBrain: Record<string, Record<string, string>>;
    aiBrainPresence: Record<string, string>;
    advancedPresence: Record<string, string>;
    devices: Record<string, { row: string; apps: Record<string, string> }>;
    team: { present: boolean; open: boolean | null; rows: string[] };
    caption: string;
    fetched: string[];
  };

  const p = out.panel;
  assert.equal(p.inUseLine, "In use for you: Anthropic Direct API key (the workspace default)");
  assert.equal(p.inheritedNote, "You have not chosen your own, so you use the workspace default. Choosing your own changes only your setup.");
  assert.equal(p.chooseOwnPresent, true, "an inherited setup offers a Choose your own button");
  assert.equal(p.chooseOwnText, "Choose your own");
  assert.equal(p.radiogroupHasRef, true, "the runtime choices are the button's target");
  assert.deepEqual(p.radios.map((x) => x.value), ["cli", "local", "api"]);
  assert.ok(p.pressed.scrolled, "pressing Choose your own brings the runtime choices into view");
  assert.equal(p.pressed.focused, "api", "and puts the keyboard on the choice in use (the workspace's API key)");
  assert.deepEqual(p.pressed.focusOptions, { preventScroll: true }, "one scroll, not a second jump from focus");
  assert.equal(p.ownHasButton, false, "a person with their own setup is not offered Choose your own");
  assert.equal(p.ownInherited, false);
  console.log("  ok - Choose your own: drawn for an inherited setup, and pressing it moves to the choices");

  // The same four computers, both screens.
  const brain = out.aiBrain;
  // A client workspace: Codex and OpenCode are held to OASIS's own computers
  // (lib/ai/engine-rollout.ts), so both read Unsupported whatever the computer says.
  assert.deepEqual(brain, {
    "Studio PC": { "Claude Code": "Ready for agents", Codex: "Unsupported", OpenCode: "Unsupported" },
    "Old Mac": { "Claude Code": "Needs test", Codex: "Unsupported", OpenCode: "Unsupported" },
    Laptop: { "Claude Code": "Approval needed", Codex: "Unsupported", OpenCode: "Unsupported" },
    Tower: { "Claude Code": "Offline", Codex: "Unsupported", OpenCode: "Unsupported" },
  });
  const installed: Record<string, string[]> = {
    "Studio PC": ["Claude Code", "Codex"],
    "Old Mac": ["Claude Code", "OpenCode"],
    Laptop: ["Claude Code"],
    Tower: ["Claude Code"],
  };
  assert.deepEqual(Object.keys(out.devices).sort(), Object.keys(brain).sort(), "Devices drew a line for each of the same computers");
  const statesCompared = new Set<string>();
  for (const [label, apps] of Object.entries(installed)) {
    const shown = out.devices[label].apps;
    assert.deepEqual(Object.keys(shown), apps, `${label}: Devices lists exactly the installed apps`);
    for (const app of apps) {
      assert.equal(shown[app], brain[label][app], `${label} / ${app}: Devices reads "${shown[app]}", AI brain reads "${brain[label][app]}"`);
      statesCompared.add(shown[app]);
    }
  }
  assert.ok(statesCompared.size >= 5, `the comparison covers several states, not one: ${[...statesCompared].join(", ")}`);
  assert.ok(out.fetched.includes("GET /api/ai/engine") && !out.fetched.includes("GET /api/bridge/cli-status"), "Devices reads AI brain's source, not a second inventory");
  console.log("  ok - the same computers read the same words on AI brain and Devices");

  // The Devices row line uses the same words for the computer's own state.
  assert.equal(out.devices["Studio PC"].row, "Studio PC · Ready for agents, checked 5 s ago");
  assert.equal(out.devices.Laptop.row, "Laptop · Approval needed");
  assert.match(out.devices.Tower.row, /^Tower · Offline since /);
  assert.match(out.caption, /Each app reads the same here as in Settings > AI brain\. “Needs test” means it is installed and signed in/);
  console.log("  ok - the Devices row line reads the shared words too");

  // E2 rides along: the same render shows Team computers open.
  assert.equal(out.team.present, true);
  assert.equal(out.team.open, true, "Team computers starts open (a closed list read as none)");
  assert.deepEqual(out.team.rows, [
    "Riley's laptop · Ready for agents, checked 5 s ago · Riley's computer",
    "Riley's desktop · Online · Approval needed from Riley",
    "Riley's old PC · Idle · Approval needed from Riley",
  ]);
  console.log("  ok - Team computers is drawn open, in the shared words");

  // 5. ONE presence vocabulary (CC 2026-10-16): a computer's own state reads the same word on AI brain's
  // computer cards, the Your computers / Team computers rows and Devices (advanced). The audit found
  // "Online" typed on two screens and machineState's raw "online" as a badge on the third.
  const { presenceWords } = await import("../lib/devices/presence");
  const brainSays = out.aiBrainPresence;
  const advancedSays = out.advancedPresence;
  const cardSays = (row: string, label: string) => row.slice(`${label} · `.length).split(" · ")[0];
  const teamRow = (label: string) => out.team.rows.find((row) => row.startsWith(`${label} · `))!;
  // Offline, the same computer on all three: Tower, last seen three days ago.
  const offline = brainSays.Tower;
  assert.match(offline, /^Offline since [A-Z][a-z]{2} \d{1,2}/, `an offline computer says since when: ${offline}`);
  assert.doesNotMatch(offline, /\bago\b/, `Offline since names the moment, not a duration: ${offline}`);
  assert.equal(advancedSays.Tower, offline, "Devices (advanced) says what AI brain says for Tower");
  assert.equal(cardSays(out.devices.Tower.row, "Tower"), offline, "and so does its Your computers row");
  // Online: AI brain's cards, Devices (advanced) and a Team computers row whose heartbeat is fresh.
  assert.deepEqual(
    [brainSays["Studio PC"], advancedSays["Studio PC"], advancedSays["Riley's desktop"], cardSays(teamRow("Riley's desktop"), "Riley's desktop")],
    ["Online", "Online", "Online", "Online"],
  );
  // Idle (AI brain has no idle: a computer there is online or not): Devices (advanced) and the Team row agree.
  assert.equal(advancedSays["Riley's old PC"], "Idle");
  assert.equal(cardSays(teamRow("Riley's old PC"), "Riley's old PC"), "Idle");
  // Every word on every screen is presenceWords' own, never a raw state key.
  const presenceShown = [...Object.values(brainSays), ...Object.values(advancedSays)];
  assert.ok(presenceShown.length >= 10, `all three screens were drawn: ${JSON.stringify({ brainSays, advancedSays })}`);
  for (const w of presenceShown) {
    assert.ok([presenceWords("online"), presenceWords("idle"), presenceWords("busy"), presenceWords("offline")].some((p) => w.startsWith(p)), `"${w}" is not one of presenceWords' words`);
    assert.doesNotMatch(w, /^(online|idle|offline)$/, "machineState's raw key on screen");
  }
  assert.equal(presenceWords("offline", null), "Offline", "never seen: plain Offline, not 'since never'");
  console.log("  ok - one presence word per state on AI brain, Your computers and Devices (advanced)");

  console.log("ai-brain-inventory-scope: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
