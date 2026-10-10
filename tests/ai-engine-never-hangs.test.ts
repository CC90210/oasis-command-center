/**
 * ai-engine-never-hangs.test.ts - Settings > AI brain > "What powers your
 * agents": a Test or Save always ends, says why in one plain sentence, and
 * never locks the page (CC, 2026-10-10).
 *
 * WHAT HAPPENED. CC chose "An app on your paired computer" > Gemini CLI and
 * pressed the button. It sat on "Testing a short answer..." with no end and
 * nothing else on the page could be clicked. The server had answered 422 after
 * 90 s. The browser's fetch had NO deadline and NO way to stop (the one
 * unbounded wait, components/settings/agent-engine-client.ts call), and every
 * radio, the app picker and the model box were `disabled` while it waited.
 *
 * PINNED HERE
 *   1. The browser call ends for every outcome (200, 422 with JSON, 500, a
 *      non-JSON 502/504, a dropped connection, a connection that never
 *      answers, a body that never arrives, Cancel) with a plain sentence.
 *   2. The panel, drawn by real hooks (tests/ai-engine-never-hangs.render.ts),
 *      ends its busy state, shows the sentence, offers Cancel and an elapsed
 *      counter while it waits, and disables ONLY the Test and Save buttons.
 *   3. The server's probe for one short answer waits 75 s, not 150 s, and the
 *      browser waits a little longer than that.
 *   4. The bridge's failure codes each have their own plain sentence.
 *   5. An app the vendor refuses ("unsupported") is its own finished state and
 *      is not offered a Test or Save.
 *   6. The "AI setup" section is gone; its key management lives in the engine
 *      panel, and #providers still resolves.
 *
 * Run: node --conditions=react-server --import tsx tests/ai-engine-never-hangs.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    // A check that never ends is the bug under test: fail it, do not wait on it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("never ended within 8 s (the hang)")), 8000);
      }),
    ]).finally(() => clearTimeout(timer));
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${(err as Error).message.slice(0, 600).split("\n").join("\n        ")}`);
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const GEMINI = { kind: "cli", cli: "gemini" } as const;

async function main() {
  // A promise that never settles must not let node exit 0 mid-suite (it would read as a pass).
  setInterval(() => undefined, 1000);
  const client = await import("../components/settings/agent-engine-client");
  const bridge = await import("../lib/ai/bridge-turn");
  const outcome = await import("../lib/os/channel/outcome");
  const cliStatus = await import("../lib/bridge-cli-status");

  console.log("1. the browser call always ends");
  await check("a 422 with JSON hands back the server's own sentence (Save and Test)", async () => {
    const sentence = "It did not pass the test, so nothing was changed. Google no longer lets Gemini CLI run on a personal Google sign-in.";
    const fetch422 = async () => json(422, { ok: false, error: "engine_test_failed", message: sentence });
    assert.deepEqual(await client.saveEngine(GEMINI, fetch422), { ok: false, message: sentence });
    assert.deepEqual(await client.testEngine(GEMINI, fetch422), { ok: false, message: sentence });
  });
  await check("a 500, a non-JSON 502 and a 504 each end in a plain sentence, never a status code or HTML", async () => {
    for (const [status, raw] of [
      [500, "Internal Server Error"],
      [502, "<html><body>Bad gateway</body></html>"],
      [504, ""],
      [524, "error code: 524"],
    ] as const) {
      const f = async () => new Response(raw, { status });
      for (const r of [await client.saveEngine(GEMINI, f), await client.testEngine(GEMINI, f)]) {
        assert.equal(r.ok, false);
        const message = (r as { message: string }).message;
        assert.match(message, /^[A-Z][^<>]*[.]$/, `${status}: ${message}`);
        assert.doesNotMatch(message, /\b(50\d|52\d|html|SyntaxError|JSON)\b/i, `${status}: ${message}`);
        assert.match(message, status >= 504 ? /took too long/ : /had a problem/);
      }
    }
  });
  await check("a dropped connection says so plainly", async () => {
    const f = async () => {
      throw new TypeError("Failed to fetch");
    };
    const r = await client.saveEngine(GEMINI, f);
    assert.deepEqual(r, { ok: false, message: "We couldn't reach OASIS just now. Check your connection, then try again. Nothing was changed." });
  });
  await check("a connection that never answers ends at the deadline, even when fetch ignores its signal", async () => {
    const never = () => new Promise<Response>(() => undefined);
    const started = Date.now();
    const r = await client.testEngine(GEMINI, never, { deadlineMs: 40 });
    assert.ok(Date.now() - started < 1000, "the call must end at its own deadline");
    assert.equal(r.ok, false);
    assert.match((r as { message: string }).message, /didn't answer in time\. Try again, or pick another app\./);
    const s = await client.saveEngine(GEMINI, never, { deadlineMs: 40 });
    assert.match((s as { message: string }).message, /may have been saved/, "a save that timed out says it may have landed");
  });
  await check("a body that never arrives also ends at the deadline", async () => {
    const stuck = async () => ({ ok: true, status: 200, json: () => new Promise(() => undefined) }) as unknown as Response;
    const r = await client.testEngine(GEMINI, stuck, { deadlineMs: 40 });
    assert.equal(r.ok, false);
    assert.match((r as { message: string }).message, /didn't answer in time/);
  });
  await check("Cancel aborts the request and says nothing was changed", async () => {
    let seen: AbortSignal | undefined;
    const waits = (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        seen = init.signal ?? undefined;
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const ctl = new AbortController();
    const pending = client.testEngine(GEMINI, waits, { signal: ctl.signal });
    ctl.abort();
    const r = await pending;
    assert.equal(seen?.aborted, true, "the request itself was aborted");
    assert.deepEqual(r, { ok: false, message: "Stopped waiting for the test. Nothing was changed." });
    const already = new AbortController();
    already.abort();
    assert.equal((await client.testEngine(GEMINI, waits, { signal: already.signal })).ok, false, "an already-cancelled call ends at once");
  });
  await check("the browser waits a little longer than the server's one-short-answer probe, which is 75 s", () => {
    assert.equal(bridge.BRIDGE_TEST_TIMEOUT_MS, 75_000);
    assert.ok(client.ENGINE_CLIENT_DEADLINE_MS > bridge.BRIDGE_TEST_TIMEOUT_MS);
    assert.ok(client.ENGINE_CLIENT_DEADLINE_MS <= bridge.BRIDGE_TEST_TIMEOUT_MS + 15_000, "slightly above, not far above");
  });

  console.log("2. the server probe");
  await check("the probe for one short answer gives up at 75 s with the plain sentence, and stops reading the app", async () => {
    const waits: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 75_000) {
        waits.push(ms);
        return realSetTimeout(fn, 5, ...rest);
      }
      return realSetTimeout(fn, ms, ...rest);
    }) as typeof setTimeout;
    let returned = false;
    try {
      async function* silent() {
        try {
          await new Promise(() => undefined);
          yield { type: "delta" as const, text: "never" };
        } finally {
          returned = true;
        }
      }
      const r = await bridge.testBridgeEngine({
        caller: { target: { baseUrl: "http://bridge.invalid", bearerToken: "t" }, tenantId: "t", userId: "u", teamRole: "owner" } as never,
        engine: GEMINI,
        tenantSlug: "oasis",
        system: "s",
        ask: "a",
        maxTokens: 10,
        stream: silent as never,
      });
      assert.deepEqual(waits, [75_000], "the default deadline is 75 s");
      assert.deepEqual(r, { ok: false, code: "timeout", message: "The app on your paired computer didn't answer in time. Try again, or pick another app." });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    void returned;
  });

  console.log("3. the bridge's failure codes, in plain words");
  await check("cli_account_unsupported says why Gemini CLI cannot run, in CC's words", async () => {
    assert.equal(outcome.classifyStreamError("cli_error:cli_account_unsupported"), "cli_account_unsupported");
    const c = outcome.failureCopy("cli_account_unsupported", { canManageAi: true });
    assert.equal(c.sentence, "Google no longer lets Gemini CLI run on a personal Google sign-in. Pick Claude Code or Codex, or use an AI account.");
    assert.equal(cliStatus.CLI_UNSUPPORTED_DETAIL, c.sentence, "the card and the run error say the same words");
    const r = await bridge.testBridgeEngine({
      caller: { target: { baseUrl: "http://bridge.invalid", bearerToken: "t" }, tenantId: "t", userId: "u", teamRole: "owner" } as never,
      engine: GEMINI,
      tenantSlug: "oasis",
      system: "s",
      ask: "a",
      maxTokens: 10,
      stream: async function* () {
        yield { type: "error" as const, message: "cli_error:cli_account_unsupported" };
      } as never,
    });
    assert.deepEqual(r, { ok: false, code: "cli_account_unsupported", message: c.sentence });
  });
  await check("every code the bridge sends has its own sentence; an unknown one stays the generic app sentence", () => {
    // The codes are the part before "|" in bravo_cli/bridge_chat_server.py's RuntimeError messages.
    const codes = ["cli_account_unsupported", "cli_auth_required", "cli_not_found", "cli_outdated", "cli_empty_output", "cli_nonzero_exit", "cli_timeout"];
    const seen = new Set<string>();
    for (const code of codes) {
      assert.equal(outcome.classifyStreamError(`cli_error:${code}`), code);
      assert.ok(outcome.isAccountScoped(code as never), `${code}: one engine per workspace`);
      const c = outcome.failureCopy(code, { canManageAi: true });
      assert.match(c.sentence, /^[A-Z][^|<>]*[.]$/, code);
      assert.doesNotMatch(c.sentence, /cli_|exit code|stderr/i, code);
      assert.ok(!seen.has(c.sentence), `${code} shares a sentence with another code`);
      seen.add(c.sentence);
      assert.notEqual(c.sentence, outcome.failureCopy("cli_failed", { canManageAi: true }).sentence, code);
    }
    assert.match(outcome.failureCopy("cli_auth_required", { canManageAi: true }).sentence, /not signed in/);
    assert.match(outcome.failureCopy("cli_not_found", { canManageAi: true }).sentence, /not installed/);
    assert.match(outcome.failureCopy("cli_outdated", { canManageAi: true }).sentence, /too old/);
    assert.equal(outcome.classifyStreamError("cli_error:something_new"), "cli_failed");
    assert.equal(outcome.classifyStreamError("cli_error:http_412"), "cli_failed");
  });

  console.log("4. an app the vendor refuses is a finished state");
  await check("probe 'unsupported' is its own state: never Ready, never Needs sign-in, never 'not confirmed'", () => {
    const claude = { installed: true, authenticated: true, version: "2.1.270" };
    const codex = { installed: true, authenticated: true, version: "0.146" };
    const gemini = { installed: true, authenticated: false, version: null, probe: "unsupported" };
    const snap = cliStatus.normalizeCliSnapshot({ providers: { claude, codex, gemini } }, new Date().toISOString());
    assert.ok(snap.ok);
    if (!snap.ok) return;
    const g = snap.data.gemini;
    assert.equal(g.unsupported, true);
    assert.equal(g.checked, true, "a verdict, not a check that failed to finish");
    assert.equal(cliStatus.cliStatusState(g), "unsupported");
    assert.equal(cliStatus.CLI_STATE_LABEL.unsupported, "Not supported on this sign-in");
    assert.notEqual(cliStatus.cliStatusState(g), "needs_sign_in");
    assert.notEqual(cliStatus.cliStatusState(g), "unknown");
    assert.notEqual(cliStatus.cliStatusState(g), "ready");
    // Even if a bridge also said authenticated, a refused sign-in is never Ready.
    assert.equal(cliStatus.cliStatusState({ installed: true, authenticated: true, checked: true, unsupported: true }), "unsupported");
    // A missing app is not "unsupported".
    assert.equal(cliStatus.cliStatusState({ installed: false, authenticated: false, checked: true, unsupported: true }), "not_detected");
    assert.equal(snap.data.claude.unsupported, false);
  });
  await check("an app is listed as refused only when every computer that has it says so", () => {
    const info = (unsupported: boolean, ready = false) => ({ installed: true, authenticated: ready, version: "1", install_hint_url: "x", checked: true, unsupported });
    const ok = info(false, true);
    const machine = (id: string, gemini: ReturnType<typeof info>) => ({ id, label: id, data: { claude: ok, codex: ok, gemini } });
    assert.deepEqual(cliStatus.unsupportedProviders([machine("a", info(true))]), ["gemini"]);
    assert.deepEqual(cliStatus.unsupportedProviders([machine("a", info(true)), machine("b", info(true))]), ["gemini"]);
    assert.deepEqual(cliStatus.unsupportedProviders([machine("a", info(true)), machine("b", info(false, true))]), [], "one computer where it works means it is not refused");
    assert.deepEqual(cliStatus.unsupportedProviders([]), []);
  });

  console.log("5. the panel, drawn by real hooks");
  type Scenario = {
    before: { buttons: string[]; unsupportedNote: boolean };
    started: boolean;
    mid?: { disabled: string[]; locks: number; cancel: boolean; elapsed: string; accountCardPresent: boolean; accountButtonDisabled: boolean };
    ended?: boolean;
    stillBusy?: boolean;
    note?: string | null;
    noteRole?: string | null;
    stillDisabled?: string[];
    signalAborted?: boolean | null;
  };
  // The render needs whole React: drop the suite's react-server condition (CI sets it in NODE_OPTIONS, which children inherit).
  const nodeOptions = (process.env.NODE_OPTIONS || "")
    .split(/\s+/)
    .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
    .join(" ");
  const childEnv: NodeJS.ProcessEnv = Object.assign({}, process.env, { NODE_OPTIONS: nodeOptions });
  if (!nodeOptions) delete childEnv.NODE_OPTIONS;
  const run = spawnSync(process.execPath, ["--import", "tsx", "tests/ai-engine-never-hangs.render.ts"], { cwd: ROOT, encoding: "utf8", env: childEnv, timeout: 120_000 });
  let sc: Record<string, Scenario> = {};
  try {
    sc = JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}") as Record<string, Scenario>;
  } catch {
    sc = {};
  }
  await check("the render driver ran", () => {
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`.slice(0, 1500));
    assert.ok(Object.keys(sc).length >= 12, "the scenarios did not all print");
  });

  const ENDS: Array<[string, RegExp]> = [
    ["422 json", /Google no longer lets Gemini CLI run on a personal Google sign-in/],
    ["test 422 json", /didn't answer in time\. Try again, or pick another app\./],
    ["500 plain text", /OASIS had a problem answering just now\. Nothing was changed\./],
    ["502 html", /OASIS had a problem answering just now/],
    ["504", /OASIS took too long to answer/],
    ["network drop", /We couldn't reach OASIS just now/],
    ["client timeout", /didn't answer in time\. Try again, or pick another app\./],
    ["client timeout on test", /didn't answer in time\. Try again, or pick another app\./],
    ["cancel", /Stopped waiting for the test\. Nothing was changed\./],
  ];
  for (const [name, expected] of ENDS) {
    await check(`'${name}': the busy state ends, one plain sentence shows, nothing stays disabled`, () => {
      const s = sc[name];
      assert.ok(s?.started, `${name} did not start`);
      assert.equal(s.ended, true, "the Cancel button and busy state were still there");
      assert.equal(s.stillBusy, false);
      assert.match(s.note ?? "", expected);
      assert.equal(s.noteRole, "alert");
      assert.doesNotMatch(s.note ?? "", /<|SyntaxError|\b50\d\b/);
      assert.deepEqual(s.stillDisabled, [], "a control stayed disabled after the request ended");
    });
  }
  await check("a connection that never answers is aborted at the browser deadline (the request is stopped, not abandoned)", () => {
    assert.equal(sc["client timeout"].signalAborted, true);
    assert.equal(sc["client timeout on test"].signalAborted, true);
    assert.equal(sc["cancel"].signalAborted, true, "Cancel aborts the request");
  });
  await check("while it waits: Cancel and a seconds counter show, and ONLY the Test and Save buttons are disabled", () => {
    for (const name of ["client timeout", "client timeout on test", "cancel", "elapsed counter"]) {
      const m = sc[name].mid;
      assert.ok(m, name);
      assert.equal(m.cancel, true, `${name}: no Cancel button while waiting`);
      assert.match(m.elapsed, /^Testing\.\.\. \d+ s\. An app's first answer can take up to a minute\.$/, name);
      assert.equal(m.locks, 0, `${name}: something blocks the page (inert / aria-busy / pointer-events-none)`);
      // Disabled: the Test button and the Use-this button, nothing else (not a radio, not the app picker, not the AI account card).
      for (const d of m.disabled) assert.match(d, /^button:(Test|Testing\.\.\.|Use this for my agents|Testing a short answer\.\.\.)$/, `${name}: ${d} is disabled while waiting`);
      assert.ok(m.disabled.length >= 1 && m.disabled.length <= 2, `${name}: ${m.disabled.join(" | ")}`);
      assert.equal(m.accountCardPresent, true);
      assert.equal(m.accountButtonDisabled, false, `${name}: the AI account card was locked`);
    }
    assert.match(sc["elapsed counter"].mid?.elapsed ?? "", /^Testing\.\.\. [1-9]\d* s\./, "the counter counts seconds");
    assert.equal(sc["elapsed counter"].note, 'Gemini CLI answered in 2.2 s: "Hi"');
  });
  await check("success names the app that answered, and ends the busy state", () => {
    assert.equal(sc["ok"].note, 'Gemini CLI answered in 4.2 s: "Hello"');
    assert.equal(sc["ok"].noteRole, "status");
    assert.equal(sc["ok"].stillBusy, false);
  });
  await check("an app the vendor refuses shows its reason inline and is not offered a Test or Save", () => {
    for (const name of ["unsupported gemini", "unsupported gemini save"]) {
      const s = sc[name];
      assert.equal(s.started, false, `${name}: Test/Save was offered for Gemini CLI`);
      assert.equal(s.before.unsupportedNote, true);
      assert.ok(s.before.buttons.includes("Gemini CLI Not supported"), s.before.buttons.join(" | "));
      assert.ok(!s.before.buttons.some((b) => b === "Test" || b === "Use this for my agents"));
    }
    // Picking a working app brings Test and Save back.
    assert.equal(sc["claude with gemini unsupported"].started, true);
    assert.equal(sc["claude with gemini unsupported"].before.unsupportedNote, false);
    assert.match(sc["claude with gemini unsupported"].note ?? "", /^Claude Code answered/);
  });
  await check("the radios, the app picker and the model box are never disabled by a pending request (source)", () => {
    const src = read("components/settings/AgentEnginePanel.tsx");
    assert.doesNotMatch(src, /busy !== null/, "the old page-wide busy lock is back");
    assert.doesNotMatch(src, /pointer-events-none|\binert\b/);
    const radio = /type="radio"[\s\S]*?disabled=\{([^}]*)\}/.exec(src)?.[1] ?? "";
    assert.equal(radio.trim(), "!canManage", "the engine radios must only be gated by who may manage");
  });

  console.log("6. the 'AI setup' section is gone and nothing it did is lost");
  await check("no separate AI setup section; the AI account sits inside 'What powers your agents' and #providers resolves", () => {
    const content = read("components/settings/SettingsContent.tsx");
    assert.doesNotMatch(content, /title="AI setup"/, "the duplicate section is back");
    const providers = content.search(/^\s+id="providers"\s*$/m);
    const engine = content.search(/^\s+id="engine"\s*$/m);
    const next = content.indexOf("<SettingsSection", engine + 10);
    assert.ok(engine !== -1 && providers > engine && providers < next, "#providers must sit inside the engine section");
    const idx = content.indexOf("<ProviderAccountsCard");
    assert.ok(idx > engine && idx < next, "the AI account card (connect / replace / remove a key, the model, Test) must be mounted in the engine section");
    assert.match(content, /<AgentEnginePanel>\s*<div\s+id="providers"[^>]*>\s*<SafeBoundary label="AI provider accounts">/);
    const card = read("components/settings/ProviderAccountsCard.tsx");
    for (const kept of ["Replace key", "Connect", "DisconnectButton", "TestConnectionButton", "DepartmentBrainPanel"]) assert.ok(card.includes(kept), `${kept} was lost`);
    // The panel still shows the account when its own read failed.
    assert.match(read("components/settings/AgentEnginePanel.tsx"), /if \(readError\) \{[\s\S]*?<AccountSection/);
  });
  await check("the nav word 'AI setup' no longer points anywhere", () => {
    for (const f of ["components/ChatWidget.tsx", "components/settings/SettingsContent.tsx"]) {
      assert.doesNotMatch(read(f).replace(/\/\*[\s\S]*?\*\//g, ""), /Settings → AI setup|Profile, AI setup/, f);
    }
  });

  if (failures > 0) {
    console.log(`\nai-engine-never-hangs: ${failures} failed`);
    process.exit(1);
  }
  console.log("\nai-engine-never-hangs: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
