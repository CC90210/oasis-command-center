/**
 * tests/dv1-connector-and-status.test.ts - DV1: "Connect your computer"
 * (a connector code, for every signed-in person, not only this workspace's
 * computer owner) and the deferred O4 status line in a department chat.
 *
 * WHAT IS CHECKED
 *   1. "Connect your computer" (components/settings/YourComputersCard.tsx
 *      ConnectYourComputerCard) is wired into BOTH of SettingsContent.tsx's
 *      render paths -- the manager branch and PersonalSettingsView, the
 *      non-manager branch -- under the "profile" section. The dedicated
 *      Devices page is now also member-visible and scopes each person to
 *      their own computers. Mutation-checked: the SAME guard-matcher this
 *      test trusts is first proven against a synthetic gated snippet (fails)
 *      and a synthetic ungated one (passes), the way
 *      tests/devices-copy-guard.test.ts proves its own scanner before
 *      trusting it against the real files.
 *   2. The card mints a 'connector'-purpose code (never the old full-install
 *      one-liner or the private harness repo's name), and its idle render
 *      carries no trace of either. Mutation-checked the same way: the
 *      leak-matcher is proven against a synthetic clean string and a
 *      synthetic leaking one before it is trusted against the real files.
 *   3. DV0's two "on its way" notices (DevicesEditor.tsx OwnerOnlyConnectNotice,
 *      app/settings/devices/install/page.tsx OwnerOnlyInstallNotice) now tell
 *      the truth: the connector app, not a nonexistent installer, and no new
 *      harness leak. Updated D0 (2026-10-12): "there is nothing to install
 *      today" was itself false (the connector already runs on OASIS's own
 *      team computers) — this now pins the HONEST replacement copy instead
 *      of the line it was previously proving existed.
 *   4. The deferred O4 status line (components/agents/chat-shared.ts
 *      computerStatusLine): queued/busy/running copy, null for every run not
 *      dispatched to a person's own computer, and never a house-agent name
 *      -- as a pure function, and as what components/agents/DepartmentChat.tsx
 *      Message actually draws.
 *   5. lib/os/runs/sse.ts puts RunHead's `executor` on the wire (it was on
 *      the type since O4, but dropped at the SSE encode step until DV1).
 *
 * Run: node --conditions=react-server --import tsx tests/dv1-connector-and-status.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

let failures = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

// ── Mutation-checked matcher #1: is this ConnectYourComputerCard mount ungated? ──

/** The nearest enclosing section guard line above `fromIdx`, or null. */
function nearestGuard(lines: string[], fromIdx: number): string | null {
  for (let i = fromIdx; i >= 0; i--) {
    if (/\{(?:show\(|section === "devices")/.test(lines[i])) return lines[i];
  }
  return null;
}

/**
 * True when the nearest guard above a `<ConnectYourComputerCard` mount is
 * `show("profile")` with no further `isOperator` (or any other) condition
 * joined to it -- i.e. every signed-in person who can open Settings at all
 * reaches it. False for a guard that adds `isOperator` (or any section key
 * other than "profile"), or when no guard is found at all.
 */
function mountIsUngated(src: string): boolean[] {
  const lines = src.split("\n");
  const results: boolean[] = [];
  lines.forEach((line, i) => {
    if (!/<ConnectYourComputerCard\s*\/>/.test(line)) return;
    const guard = nearestGuard(lines, i);
    results.push(Boolean(guard && /show\("profile"\)/.test(guard) && !/isOperator/.test(guard)));
  });
  return results;
}

const SYNTHETIC_UNGATED = [
  '{show("profile") && (',
  "  <SettingsSection id=\"connect-your-computer\" title=\"Connect your computer\">",
  "    <ConnectYourComputerCard />",
  "  </SettingsSection>",
  ")}",
].join("\n");

const SYNTHETIC_GATED = [
  '{show("devices") && isOperator && (',
  "  <SettingsSection id=\"connect-your-computer\" title=\"Connect your computer\">",
  "    <ConnectYourComputerCard />",
  "  </SettingsSection>",
  ")}",
].join("\n");

/**
 * D0: the Devices section's own TOP-of-page "Add a device" mount is gated
 * on the focused `section === "devices"`, deliberately WITHOUT isOperator -- unlike
 * "Your computers" and "Devices (advanced)" beside it, which show OTHER
 * people's bridge pairings and stay operator-only. True only for a guard
 * that is exactly the focused Devices section with no `isOperator` joined to it.
 */
function mountIsDevicesUngated(src: string): boolean[] {
  const lines = src.split("\n");
  const results: boolean[] = [];
  lines.forEach((line, i) => {
    if (!/<ConnectYourComputerCard\s*\/>/.test(line)) return;
    const guard = nearestGuard(lines, i);
    results.push(Boolean(guard && /section === "devices"/.test(guard) && !/isOperator/.test(guard)));
  });
  return results;
}

const SYNTHETIC_DEVICES_UNGATED = ['{section === "devices" && (', "  <ConnectYourComputerCard />", ")}"].join("\n");
const SYNTHETIC_DEVICES_GATED = ['{section === "devices" && isOperator && (', "  <ConnectYourComputerCard />", ")}"].join("\n");

// ── Mutation-checked matcher #2: does this text leak the old harness path? ──

// Repo names, the private-repo API call, the clone/download commands -- never
// "installRepo" or "HARNESS_REPO" on their own (those are the existing, correct
// plumbing that gates the full install to this workspace's agents owner; the
// variable existing is not a leak, a repo NAME or a one-liner printed to screen
// is) and never "Claude Code" (the AI app's own real name, said truthfully
// elsewhere on these same files, e.g. "Claude Code is signed out" -- not a
// harness-install tell on its own).
const HARNESS_LEAKS = ["CEO-Agent", "CC90210", "gh api", "gh auth", "raw.githubusercontent", "git clone", "install.ps1", "install.sh"];
const containsHarnessLeak = (src: string): boolean => HARNESS_LEAKS.some((t) => src.includes(t));

console.log("dv1-connector-and-status:");

async function main() {
  // -- 1 & 2: the matchers themselves, proven on synthetic fixtures first ----
  console.log("The matchers (proven before they are trusted against real files)");
  await check("mountIsUngated: a synthetic show(profile)-only mount passes, a show(devices)+isOperator mount fails", () => {
    assert.deepEqual(mountIsUngated(SYNTHETIC_UNGATED), [true]);
    assert.deepEqual(mountIsUngated(SYNTHETIC_GATED), [false]);
  });
  await check("mountIsDevicesUngated: a focused Devices mount passes and an operator-gated one fails", () => {
    assert.deepEqual(mountIsDevicesUngated(SYNTHETIC_DEVICES_UNGATED), [true]);
    assert.deepEqual(mountIsDevicesUngated(SYNTHETIC_DEVICES_GATED), [false]);
  });
  await check("containsHarnessLeak: a synthetic leaking string is caught, a clean one is not", () => {
    assert.equal(containsHarnessLeak("run `gh api repos/CC90210/CEO-Agent/contents/install.ps1`"), true);
    assert.equal(containsHarnessLeak("Connecting a computer runs through the OASIS connector app."), false);
  });

  // -- 1: "Connect your computer" reaches every signed-in person ------------
  console.log("1. Connect your computer, every signed-in person");
  const settingsContentSrc = read("components/settings/SettingsContent.tsx");
  await check(
    "ConnectYourComputerCard is mounted exactly four times: two Profile mounts (manager branch, PersonalSettingsView) and two TOP-of-Devices mounts (D0, same two branches) — all four ungated on isOperator",
    () => {
      const profileResults = mountIsUngated(settingsContentSrc);
      const devicesResults = mountIsDevicesUngated(settingsContentSrc);
      assert.equal(profileResults.length, 4, "expected exactly four <ConnectYourComputerCard /> mounts");
      assert.equal(devicesResults.length, 4);
      assert.equal(profileResults.filter(Boolean).length, 2, "two mounts are ungated show(\"profile\") only");
      assert.equal(devicesResults.filter(Boolean).length, 2, "two mounts are ungated focused Devices mounts (Add a device)");
      assert.deepEqual(
        profileResults.map((p, i) => p || devicesResults[i]),
        [true, true, true, true],
        "every mount must be ungated by isOperator one way or the other",
      );
    },
  );
  await check("the full Settings page never mounts a second pair-code card", () => {
    assert.equal((settingsContentSrc.match(/\{section === "devices" && \(/g) || []).length, 2);
    assert.doesNotMatch(settingsContentSrc, /\{show\("devices"\) && \(\s*<SettingsSection[^>]*id="add-a-device"/);
  });
  await check("the Devices page uses the shared member-visible section gate", () => {
    // The two Profile mounts are both inside `show("profile")` (proven
    // above); the devices page only ever calls SettingsContent with
    // section="devices", so a show("profile") block can never be the one
    // it renders. The THIRD mount (Add a device, D0) is deliberately the
    // opposite: it IS inside the devices section, and the devices page's
    // own operator-only 404 is still the real-traffic gate for who ever
    // reaches it — unchanged by this test, asserted below.
    const devicesPage = read("app/settings/devices/page.tsx");
    const sections = read("components/settings/settings-sections.ts");
    assert.match(devicesPage, /requireSettingsSection\("devices"\)/);
    assert.match(sections, /key: "devices"[^\n]+audience: "everyone"/);
    assert.match(devicesPage, /section="devices"/);
  });

  // -- 2: mints a connector code, no full-install leak -----------------------
  console.log("2. A connector code, never the old full-install path");
  const cardSrc = read("components/settings/YourComputersCard.tsx");
  await check("the mint call requests purpose 'connector' against the real pair-code endpoint", () => {
    assert.match(cardSrc, /fetch\("\/api\/auth\/pair-code"/);
    assert.match(cardSrc, /purpose:\s*"connector"/);
  });
  await check("ConnectYourComputerCard's own source carries no full-install command or private repo name", () => {
    assert.equal(containsHarnessLeak(cardSrc), false, "YourComputersCard.tsx leaks the harness path");
  });

  // -- 3: DV0's two notices tell the truth now -------------------------------
  console.log("3. DV0 notices: accurate, consistent, no new leak");
  for (const [label, rel] of [
    ["DevicesEditor's OwnerOnlyConnectNotice", "components/settings/DevicesEditor.tsx"],
    ["the install page's OwnerOnlyInstallNotice", "app/settings/devices/install/page.tsx"],
  ] as const) {
    await check(`${label}: names the connector app, says it runs today on OASIS's own team computers (never "nothing to install today"), names the one-click installer as coming, pauses chats, no harness leak`, () => {
      const src = read(rel);
      assert.match(src, /OASIS connector app/);
      assert.match(src, /runs today on OASIS(&apos;|')s own team computers/);
      assert.match(src, /one-click installer/i);
      assert.doesNotMatch(src, /nothing to\s*\n?\s*install today/, "must not still say there is nothing to install today — the connector already runs on OASIS's own team computers");
      assert.match(src, /pause/i);
      assert.doesNotMatch(src, /on its way and is not ready yet/);
      assert.equal(containsHarnessLeak(src), false, `${rel} leaks the harness path`);
    });
  }

  // -- 4: the deferred O4 status line, as a pure function --------------------
  console.log("4. The deferred status line (pure function + what Message draws)");
  const { computerStatusLine } = await import("../components/agents/chat-shared");
  const identity = await import("../lib/os/channel/identity");
  const LABEL = "ANN-LAPTOP (Windows)";
  await check("queued, nothing ahead of it: Waiting for {label} to pick this up", () => {
    assert.equal(computerStatusLine({ executor: "computer", status: "queued", label: LABEL, busy: false }), `Waiting for ${LABEL} to pick this up`);
  });
  await check("queued, busy with another reply in the same chat: {label} is busy with another reply", () => {
    assert.equal(computerStatusLine({ executor: "computer", status: "queued", label: LABEL, busy: true }), `${LABEL} is busy with another reply`);
  });
  await check("running: {label} · Claude Code", () => {
    assert.equal(computerStatusLine({ executor: "computer", status: "running", label: LABEL, busy: false }), `${LABEL} · Claude Code`);
  });
  await check("unknown label falls back to a plain, truthful 'your computer' / 'Your computer' (never empty, never a guess at a name)", () => {
    assert.equal(computerStatusLine({ executor: "computer", status: "queued", label: null, busy: false }), "Waiting for your computer to pick this up");
    assert.equal(computerStatusLine({ executor: "computer", status: "running", label: null, busy: false }), "Your computer · Claude Code");
  });
  await check("null for any run not dispatched to a person's own computer, and for a finished run", () => {
    assert.equal(computerStatusLine({ executor: "worker", status: "queued", label: LABEL, busy: false }), null);
    assert.equal(computerStatusLine({ executor: null, status: "queued", label: LABEL, busy: false }), null);
    assert.equal(computerStatusLine({ executor: "computer", status: "done", label: LABEL, busy: false }), null);
    assert.equal(computerStatusLine({ executor: "computer", status: "failed", label: LABEL, busy: false }), null);
  });
  await check("none of the three lines ever names a house agent", () => {
    for (const line of [
      computerStatusLine({ executor: "computer", status: "queued", label: LABEL, busy: false }),
      computerStatusLine({ executor: "computer", status: "queued", label: LABEL, busy: true }),
      computerStatusLine({ executor: "computer", status: "running", label: LABEL, busy: false }),
    ]) {
      assert.ok(line && !identity.namesPersona(line), `a persona name reached the status line: ${line}`);
    }
  });

  // -- Render: what Message and ConnectYourComputerCard actually draw -------
  console.log("What is drawn");
  const nodeOptions = (process.env.NODE_OPTIONS || "")
    .split(/\s+/)
    .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
    .join(" ");
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: nodeOptions };
  if (!nodeOptions) delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/dv1-connector-and-status.render.ts"], { encoding: "utf8", env, timeout: 120_000 });
  const html = r.status === 0 ? (JSON.parse(r.stdout.trim().split("\n").pop() || "{}") as Record<string, string>) : ({} as Record<string, string>);
  const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  await check("the render process ran", () => {
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.ok(Object.keys(html).length >= 5);
  });
  await check("ConnectYourComputerCard, idle: mints a code, names the connector app, no harness leak", () => {
    assert.match(text(html.connectIdle), /Get a connector code/);
    assert.match(text(html.connectIdle), /OASIS connector app/);
    assert.equal(containsHarnessLeak(html.connectIdle), false);
  });
  await check("a worker-dispatched queued message is unchanged: 'Queued - goes next'", () => {
    assert.match(text(html.msgQueuedWorker), /Queued - goes next/);
  });
  await check("a computer-dispatched queued message with nothing ahead of it: 'Waiting for {label} to pick this up', not 'Queued - goes next'", () => {
    assert.match(text(html.msgQueuedComputerWaiting), new RegExp(`Waiting for ${LABEL.replace(/[().]/g, "\\$&")} to pick this up`));
    assert.doesNotMatch(text(html.msgQueuedComputerWaiting), /Queued - goes next/);
  });
  await check("a computer-dispatched queued message behind a running one: '{label} is busy with another reply'", () => {
    assert.match(text(html.msgQueuedComputerBusy), new RegExp(`${LABEL.replace(/[().]/g, "\\$&")} is busy with another reply`));
  });
  await check("a computer-dispatched running message shows '{label} · Claude Code'", () => {
    assert.match(text(html.msgRunningComputer), new RegExp(`${LABEL.replace(/[().]/g, "\\$&")} · Claude Code`));
  });
  await check("a worker-dispatched running message carries no computer status line", () => {
    assert.doesNotMatch(text(html.msgRunningWorker), /Claude Code/);
  });
  await check("nothing drawn here names a house agent", () => {
    for (const key of Object.keys(html)) {
      assert.ok(!identity.namesPersona(text(html[key])), `${key}: a persona name reached the page`);
    }
  });

  // -- 5: RunHead's executor reaches the wire --------------------------------
  console.log("5. executor on the SSE wire");
  await check("lib/os/runs/sse.ts's head() puts executor on every run/end frame", () => {
    const src = read("lib/os/runs/sse.ts");
    assert.match(src, /executor:\s*h\.executor/);
  });

  // -- 6: a permanent refusal says so (independent review, DV1) -------------
  console.log("6. a 403 from the code route is told plainly, never 'try again'");
  await check("a 403 sets a forbidden state with its own sentence and no retry button", () => {
    const card = read("components/settings/YourComputersCard.tsx");
    assert.match(card, /if \(r\.status === 403\) \{\s*setState\(\{ phase: "forbidden" \}\);/);
    assert.match(card, /This account cannot connect a computer in this workspace\./);
    assert.match(card, /\(state\.phase === "idle" \|\| state\.phase === "minting" \|\| state\.phase === "error"\) && \(/, "the retry button never renders for forbidden");
  });

  // -- 7: the new-pairing check compares server time with server time ------
  console.log("7. pairing detection follows the code's authoritative redemption");
  await check("new and re-paired computers are detected by consumed_by_pairing_id, never created_at", () => {
    const card = read("components/settings/YourComputersCard.tsx");
    const route = read("app/api/auth/pair-code/route.ts");
    assert.match(card, /fetch\(`\/api\/auth\/pair-code\?code=\$\{encodeURIComponent\(code\)\}`\)/);
    assert.ok(!card.includes("new Date(d.created_at)"));
    assert.match(route, /consumed_by_pairing_id/);
    assert.match(route, /status: "connected"/);
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
