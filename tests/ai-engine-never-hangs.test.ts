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
 *   1. The browser call ends for every outcome (202, 422 with JSON, 500, a
 *      non-JSON 502/504, a dropped connection, a connection that never
 *      answers, a body that never arrives, Cancel) with a plain sentence.
 *   2. A probe is queued on one exact pairing, polling follows only that job,
 *      terminal failures stay terminal, and Stop waiting aborts the poll.
 *   3. The server's probe for one short answer waits 75 s, not 150 s, and the
 *      browser waits a little longer than that.
 *   4. The bridge's failure codes each have their own plain sentence.
 *   5. The consolidated panel invalidates a receipt when the device/runtime
 *      changes and only unlocks Save for the matching selection and scope.
 *   6. The "AI setup" section is gone; its key management lives in the engine
 *      panel, and #providers still resolves.
 *
 * Run: node --conditions=react-server --import tsx tests/ai-engine-never-hangs.test.ts
 */
import assert from "node:assert/strict";
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
const OPENCODE = { mode: "subscription", provider: "opencode", pairingId: "pair-ccpc", fallback: "none" } as const;
const BRIDGE_OPENCODE = { kind: "cli", cli: "opencode" } as const;

async function main() {
  // A promise that never settles must not let node exit 0 mid-suite (it would read as a pass).
  setInterval(() => undefined, 1000);
  const client = await import("../components/settings/agent-engine-client");
  const bridge = await import("../lib/ai/bridge-turn");
  const outcome = await import("../lib/os/channel/outcome");
  const cliStatus = await import("../lib/bridge-cli-status");

  console.log("1. the browser call always ends");
  await check("a 422 with JSON hands back the server's own sentence (Save and Test)", async () => {
    const sentence = "It did not pass the test, so nothing was changed. The app's maker does not allow this sign-in on that computer.";
    const fetch422 = async () => json(422, { ok: false, error: "engine_test_failed", message: sentence });
    assert.deepEqual(await client.saveEngine(OPENCODE, null, fetch422), { ok: false, message: sentence });
    assert.deepEqual(await client.queueEngineProbe(OPENCODE, "person", fetch422), { ok: false, message: sentence });
  });
  await check("a 500, a non-JSON 502 and a 504 each end in a plain sentence, never a status code or HTML", async () => {
    for (const [status, raw] of [
      [500, "Internal Server Error"],
      [502, "<html><body>Bad gateway</body></html>"],
      [504, ""],
      [524, "error code: 524"],
    ] as const) {
      const f = async () => new Response(raw, { status });
      for (const r of [await client.saveEngine(OPENCODE, null, f), await client.queueEngineProbe(OPENCODE, "person", f)]) {
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
    const r = await client.saveEngine(OPENCODE, null, f);
    assert.deepEqual(r, { ok: false, message: "We couldn't reach OASIS just now. Check your connection, then try again. Nothing was changed." });
  });
  await check("a connection that never answers ends at the deadline, even when fetch ignores its signal", async () => {
    const never = () => new Promise<Response>(() => undefined);
    const started = Date.now();
    const r = await client.queueEngineProbe(OPENCODE, "person", never, { deadlineMs: 40 });
    assert.ok(Date.now() - started < 1000, "the call must end at its own deadline");
    assert.equal(r.ok, false);
    assert.match((r as { message: string }).message, /didn't answer in time\. Try again, or pick another app\./);
    const s = await client.saveEngine(OPENCODE, null, never, { deadlineMs: 40 });
    assert.match((s as { message: string }).message, /In use/, "a save that timed out points at the page's own truth");
    assert.equal((s as { stopped?: boolean }).stopped, true, "and says it was stopped, so the panel re-reads");
  });
  await check("a body that never arrives also ends at the deadline", async () => {
    const stuck = async () => ({ ok: true, status: 200, json: () => new Promise(() => undefined) }) as unknown as Response;
    const r = await client.queueEngineProbe(OPENCODE, "person", stuck, { deadlineMs: 40 });
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
    const pending = client.queueEngineProbe(OPENCODE, "person", waits, { signal: ctl.signal });
    ctl.abort();
    const r = await pending;
    assert.equal(seen?.aborted, true, "the request itself was aborted");
    assert.deepEqual(r, { ok: false, message: "Stopped waiting for the test. Nothing was changed." });
    const already = new AbortController();
    already.abort();
    assert.equal((await client.queueEngineProbe(OPENCODE, "person", waits, { signal: already.signal })).ok, false, "an already-cancelled call ends at once");
  });
  await check("a stopped call says the right thing for what it was doing (save, provider switch, key removal, test)", async () => {
    const never = () => new Promise<Response>(() => undefined);
    const save = await client.saveEngine(OPENCODE, null, never, { deadlineMs: 30 });
    assert.match((save as { message: string }).message, /"In use" above shows what your agents really run on/);
    const sw = await client.switchProvider("openai", never, { deadlineMs: 30 });
    assert.match((sw as { message: string }).message, /provider didn't answer in time\. The AI account shown is what your agents really use/);
    assert.doesNotMatch((sw as { message: string }).message, /app on your paired computer|In use/);
    const rm = await client.removeSavedKey("openai", never, { deadlineMs: 30 });
    assert.match((rm as { message: string }).message, /key couldn't be removed in time\. The saved keys listed show whether it was/);
    const ctl = new AbortController();
    const pend = client.removeSavedKey("openai", never, { signal: ctl.signal });
    ctl.abort();
    assert.match(((await pend) as { message: string }).message, /^Stopped waiting\. The saved keys listed/);
    const sendsVersion: string[] = [];
    await client.saveEngine(OPENCODE, "v-7", async (_u: string, init: RequestInit) => {
      sendsVersion.push(String(init.body));
      return json(200, { ok: true });
    });
    assert.deepEqual(
      JSON.parse(sendsVersion[0]),
      { engine: OPENCODE, scope: "person", expected_version: "v-7" },
      "a save hands back the exact selection, scope and version the page read",
    );
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
        engine: BRIDGE_OPENCODE,
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
  await check("cli_account_unsupported says why the app cannot run, in plain words", async () => {
    assert.equal(outcome.classifyStreamError("cli_error:cli_account_unsupported"), "cli_account_unsupported");
    const c = outcome.failureCopy("cli_account_unsupported", { canManageAi: true });
    assert.equal(c.sentence, "The app's maker does not allow this sign-in on your paired computer. Pick another app, or use an AI account.");
    assert.equal(cliStatus.CLI_UNSUPPORTED_DETAIL, c.sentence, "the card and the run error say the same words");
    const r = await bridge.testBridgeEngine({
      caller: { target: { baseUrl: "http://bridge.invalid", bearerToken: "t" }, tenantId: "t", userId: "u", teamRole: "owner" } as never,
      engine: BRIDGE_OPENCODE,
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
    const opencode = { installed: true, authenticated: false, version: null, probe: "unsupported" };
    const snap = cliStatus.normalizeCliSnapshot({ providers: { claude, codex, opencode } }, new Date().toISOString());
    assert.ok(snap.ok);
    if (!snap.ok) return;
    const g = snap.data.opencode;
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
    const machine = (id: string, opencode: ReturnType<typeof info>) => ({ id, label: id, data: { claude: ok, codex: ok, opencode } });
    assert.deepEqual(cliStatus.unsupportedProviders([machine("a", info(true))]), ["opencode"]);
    assert.deepEqual(cliStatus.unsupportedProviders([machine("a", info(true)), machine("b", info(true))]), ["opencode"]);
    assert.deepEqual(cliStatus.unsupportedProviders([machine("a", info(true)), machine("b", info(false, true))]), [], "one computer where it works means it is not refused");
    assert.deepEqual(cliStatus.unsupportedProviders([]), []);
  });

  console.log("5. queued jobs, polling, cancellation and the consolidated panel");
  await check("a probe is queued once, then polling follows its exact job to a successful receipt", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const statuses = ["queued", "running", "completed"] as const;
    let read = 0;
    const fetcher = async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : null });
      if (url === "/api/ai/engine") return json(202, { ok: true, job_id: "probe-pair-ccpc" });
      const status = statuses[Math.min(read++, statuses.length - 1)];
      return json(200, {
        ok: true,
        job: {
          id: "probe-pair-ccpc",
          status,
          action: "probe",
          engine: { kind: "cli", name: "opencode" },
          result: status === "completed" ? { reply: "Hello", latency_ms: 4200 } : null,
        },
      });
    };
    const queued = await client.queueEngineProbe(OPENCODE, "person", fetcher);
    assert.deepEqual(queued, { ok: true, jobId: "probe-pair-ccpc" });
    const updates: string[] = [];
    const done = await client.pollRuntimeJob("probe-pair-ccpc", fetcher, { intervalMs: 0, onUpdate: (job) => updates.push(job.status) });
    assert.equal(done.ok && done.job.status, "done");
    if (done.ok) {
      assert.equal(done.job.engine?.name, "opencode");
      assert.deepEqual(done.job.result, { reply: "Hello", latencyMs: 4200 });
    }
    assert.deepEqual(updates, ["queued", "running", "done"]);
    assert.deepEqual(calls[0], {
      url: "/api/ai/engine",
      method: "POST",
      body: { engine: OPENCODE, scope: "person" },
    });
    assert.ok(calls.slice(1).every((call) => call.url === "/api/bridge/runtime-jobs/probe-pair-ccpc" && call.method === "GET"));
  });

  await check("a failed runtime job is terminal and returns its contextual repair code", async () => {
    const result = await client.pollRuntimeJob(
      "probe-failed",
      async () =>
        json(200, {
          ok: true,
          job: {
            id: "probe-failed",
            status: "failed",
            action: "probe",
            engine: { kind: "cli", name: "opencode" },
            error_code: "unsupported_personal_sign_in",
            message: "The app's maker does not allow this sign-in on that computer.",
          },
        }),
      { intervalMs: 0 },
    );
    assert.deepEqual(result, {
      ok: false,
      message: "The app's maker does not allow this sign-in on that computer.",
      code: "unsupported_personal_sign_in",
    });
    assert.match(client.repairForCode("unsupported_personal_sign_in") ?? "", /does not allow this sign-in/);
  });

  await check("polling a connection that never answers aborts at its browser deadline", async () => {
    let signal: AbortSignal | null = null;
    const never = (_url: string, init: RequestInit) => {
      signal = init.signal;
      return new Promise<Response>(() => undefined);
    };
    const started = Date.now();
    const result = await client.pollRuntimeJob("probe-hung", never, { deadlineMs: 40, intervalMs: 0 });
    assert.ok(Date.now() - started < 1000);
    assert.equal(result.ok, false);
    assert.match((result as { message: string }).message, /didn't answer in time/);
    assert.equal(signal?.aborted, true, "the in-flight status request is aborted, not abandoned");
  });

  await check("Stop waiting cancels queued-job polling during the interval", async () => {
    const ctl = new AbortController();
    let reads = 0;
    const pending = client.pollRuntimeJob(
      "probe-cancelled",
      async () => {
        reads += 1;
        return json(200, { ok: true, job: { id: "probe-cancelled", status: "queued", action: "probe", engine: { kind: "cli", name: "codex" } } });
      },
      {
        signal: ctl.signal,
        intervalMs: 60_000,
        onUpdate: () => ctl.abort(),
      },
    );
    const result = await pending;
    assert.equal(reads, 1);
    assert.deepEqual(result, { ok: false, message: "Stopped waiting for the test. Nothing was changed." });
  });

  await check("the panel keeps the page open, invalidates stale probe receipts and exposes Stop waiting", () => {
    const src = read("components/settings/AgentEnginePanel.tsx");
    assert.doesNotMatch(src, /pointer-events-none|\binert\b/, "a runtime job must not install a page-wide interaction lock");
    assert.match(src, /function setDraft\([^)]*\)[\s\S]*?setProbeReceipt\(null\)/, "changing computer/runtime invalidates the prior test receipt");
    assert.match(src, /probeReceipt\?\.key === draftKey/, "Save is unlocked only by a receipt matching the exact current selection and scope");
    assert.match(src, /data-testid="engine-cancel"[\s\S]*?stop\.current\?\.abort\(\)/, "the active poll can be stopped without leaving Settings");
    assert.match(src, /pollRuntimeJob\(queued\.jobId[\s\S]*?onUpdate: setJob/, "the dashboard polls the selected job in place");
  });

  console.log("5b. a link to #providers opens and scrolls to the card even when it draws late");
  const hashMod = await import("../components/settings/OpenSectionOnHash");
  await check("a #providers that mounts AFTER the first look is found, its section opened, and scrolled to", async () => {
    type Fake = { tagName: string; open?: boolean; parent?: Fake; closest: (s: string) => Fake | null; scrollIntoView: () => void; scrolled: number };
    const mk = (tagName: string, parent?: Fake): Fake => {
      const el: Fake = {
        tagName,
        open: false,
        parent,
        scrolled: 0,
        closest: (sel) => (sel === "details" ? (el.tagName === "DETAILS" ? el : el.parent?.closest(sel) ?? null) : null),
        scrollIntoView: () => {
          el.scrolled++;
        },
      };
      return el;
    };
    const details = mk("DETAILS");
    const card = mk("DIV", details);
    let mounted = false;
    let notify: (() => void) | null = null;
    let timers = 0;
    const env = {
      hash: () => "#providers",
      find: (sel: string) => (sel === "#providers" && mounted ? card : null),
      watch: (cb: () => void) => {
        notify = cb;
        return () => {
          notify = null;
        };
      },
      afterLayout: (run: () => void) => run(),
      setTimeout: () => ++timers,
      clearTimeout: () => undefined,
    };
    const stop = hashMod.openHashTarget(env as never);
    assert.equal(details.open, false, "nothing to open yet");
    assert.ok(notify, "it waits for the page to change instead of giving up");
    mounted = true; // the panel's fetch finished and drew the card
    notify!();
    assert.equal(details.open, true, "the section that holds it opened");
    assert.equal(card.scrolled, 1, "and the card was scrolled to");
    assert.equal(notify, null, "it stopped watching");
    stop();
    // Already there on first look: opened at once, no watching.
    const there = { ...env, find: () => card, watch: () => { throw new Error("must not watch"); } };
    details.open = false;
    hashMod.openHashTarget(there as never);
    assert.equal(details.open, true);
    // A malformed fragment is not a crash; a target that never comes stops waiting.
    hashMod.openHashTarget({ ...env, hash: () => "#a[", find: () => { throw new SyntaxError("bad"); } } as never);
    mounted = false;
    let gaveUp: (() => void) | null = null;
    const waiting = hashMod.openHashTarget({ ...env, setTimeout: (run: () => void) => ((gaveUp = run), 1) } as never);
    gaveUp!();
    assert.equal(notify, null, "after the wait limit it stops watching");
    waiting();
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
