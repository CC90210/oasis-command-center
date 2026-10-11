/**
 * tests/tools-worker.test.ts - the tools that run inside the request (Score a
 * hook, Repurpose a post, Learn from a link) and the session routes around them
 * (lib/tools/session-handlers.ts), through the REAL founders gate (a signed
 * session checked against a local libSQL file) and the REAL migration bravo__206.
 *
 * The model and the web are fakes injected through the handler's deps; the fake
 * model meters its call through the real ledger (lib/ai/usage.ts) exactly as
 * lib/providers.ts does, so the ai_usage_events row is the real one.
 *
 * Pins:
 *   - Score a hook equals the Python scorer on every recorded fixture;
 *   - Repurpose runs on the SESSION's workspace account, records a usage row
 *     under tools.repurpose_post, never cuts a version short;
 *   - no usable account (none, a local model, unreadable) fails the run with its
 *     own line and calls no model;
 *   - Learn writes ONE indexed training note for that workspace, in the shape
 *     the background reader writes, and updates it in place on a re-read; a link
 *     already being read is refused, before AND during the run;
 *   - private and loopback addresses are refused, a redirect into one too;
 *   - one workspace never sees another's runs or notes; anyone outside the gate
 *     gets 404; the same click is one run; a cut-off run is shown as stopped.
 *
 * Run: node --conditions=react-server --import tsx tests/tools-worker.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import {
  CLIENT_A,
  OASIS,
  USERS,
  answerOf,
  check,
  emptyDatabase,
  finish,
  later,
  login,
  minutes,
  scalar,
  seedRunner,
  setupToolsDatabase,
} from "./_tools-harness";
import type { ChatRequest, StreamEvent } from "../lib/providers";
import type { WorkspaceAiAccount } from "../lib/ai/workspace-account";
import type { PageAnswer } from "../lib/tools/worker/learn-from-link";

const ACCOUNT: WorkspaceAiAccount = { source: "workspace", provider: "google", model: "gemini-test", encryptedApiKey: "enc", enabled: true };

async function main() {
  console.log("tools worker:");
  const db = await setupToolsDatabase();
  const { handleToolRun, handleToolJobs } = await import("../lib/tools/session-handlers");
  const { modelBudgetMs } = await import("../lib/tools/worker/ai");
  const { resolveToolsViewer } = await import("../lib/tools/access");
  const { fetchFollowing, htmlToText } = await import("../lib/tools/worker/learn-from-link");
  const { INJECTION_GUARD } = await import("../lib/llm-input-boundary");

  /** A fake model on a fake account. It meters the call through the real ledger, as lib/providers.ts does. */
  function fakeAi(
    reply: string | ((req: ChatRequest) => Promise<string> | string),
    account: WorkspaceAiAccount | null | Error = ACCOUNT,
    timeoutMs?: number,
  ) {
    const seen = { tenants: [] as string[], calls: [] as ChatRequest[] };
    const deps = {
      readAccount: async (tenantId: string) => {
        seen.tenants.push(tenantId);
        if (account instanceof Error) throw account;
        return account;
      },
      decrypt: (enc: string) => {
        if (enc !== "enc") throw new Error("decrypt_format_invalid");
        return "test-key";
      },
      stream: async function* (req: ChatRequest): AsyncGenerator<StreamEvent> {
        seen.calls.push(req);
        const call = await req.meter.begin({ provider: req.provider, model: req.model, maxOutputTokens: req.maxTokens ?? 0, promptBytes: req.messages[0].content.length });
        const text = typeof reply === "function" ? await reply(req) : reply;
        yield { type: "delta", text };
        await call.finish({ outcome: "ok", usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } });
        yield { type: "done", inputTokens: 10, outputTokens: 20 };
      },
      usageDb: db,
      timeoutMs,
    };
    return { deps, seen };
  }

  /** A model account that never answers: its stream hangs before its first yield, forever. Proves the bound (lib/tools/worker/ai.ts TOOL_MODEL_TIMEOUT_MS), not a slow-but-real reply. */
  function hungAi(timeoutMs: number) {
    const deps = {
      readAccount: async () => ACCOUNT,
      decrypt: () => "test-key",
      stream: async function* (): AsyncGenerator<StreamEvent> {
        await new Promise<never>(() => {
          /* never resolves: the call under test must time out, not this promise */
        });
      },
      usageDb: db,
      timeoutMs,
    };
    return deps;
  }

  /**
   * A real (short) account-read delay layered onto a normal successful
   * `fakeAi`: proves the budget is recomputed AFTER the account/budget
   * reads, not only once at the top (Codex review round 4, P2). The delay
   * is real wall-clock time (setTimeout), not a backdated clock, because
   * that is exactly what the production bug missed - time actually spent
   * reading the account, between the first budget check and the second.
   */
  function slowAccountAi(delayMs: number) {
    const ai = fakeAi(JSON.stringify({ linkedin: "a", instagram: "b", threads: "c" }));
    const readAccount = ai.deps.readAccount;
    return { deps: { ...ai.deps, readAccount: async (tenantId: string) => { await new Promise((r) => setTimeout(r, delayMs)); return readAccount(tenantId); } }, seen: ai.seen };
  }

  type Page = Partial<PageAnswer> & { status: number };
  function fakeWeb(pages: Record<string, Page>) {
    const asked: string[] = [];
    const fetchPage = async (u: URL): Promise<PageAnswer> => {
      asked.push(u.toString());
      const p = pages[u.toString()];
      if (!p) return { status: 404, contentType: "text/html", body: "", truncated: false, location: null };
      return { contentType: "text/html; charset=utf-8", body: "", truncated: false, location: null, ...p };
    };
    return { fetchPage, asked };
  }

  const deps = (ai = fakeAi("{}").deps, fetchPage?: (u: URL) => Promise<PageAnswer>, d: Client = db, now: () => Date = () => new Date()) => ({
    db: d,
    now,
    viewer: resolveToolsViewer,
    worker: { ai, fetchPage },
  });

  /**
   * A `now()` whose FIRST call (requestStartedAt, captured once at the top of
   * handleToolRun) is already `secondsAgo` in the past; every later call
   * (job timestamps) is the real clock. Simulates a slow pre-model phase
   * without the test actually waiting that long.
   */
  function backdatedNow(secondsAgo: number): () => Date {
    let first = true;
    return () => {
      if (first) {
        first = false;
        return new Date(Date.now() - secondsAgo * 1000);
      }
      return new Date();
    };
  }
  const runReq = (tool: string, input: unknown, key: string = randomUUID()) =>
    new Request("https://oasisai.work/api/tools/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, input, idempotency_key: key }),
    });
  const jobsReq = (q: string) => new Request(`https://oasisai.work/api/tools/jobs?${q}`);
  type Job = { id: string; status: string; error_code: string | null; error_message: string | null; result: Record<string, unknown> | null };
  const run = async (tool: string, input: unknown, d = deps(), key?: string) => answerOf(await handleToolRun(runReq(tool, input, key), d));
  const jobOf = (a: { body: Record<string, unknown> }) => a.body.job as Job;

  await login(USERS.cc);

  // -- Repurpose a post --------------------------------------------------------------
  const POST = "We answered every lead within a minute for 30 days. Bookings went up, and nobody worked late.";
  await check("Repurpose runs on the session workspace's AI account and records a usage row under tools.repurpose_post", async () => {
    const threads = "t".repeat(600);
    const ai = fakeAi(JSON.stringify({ linkedin: "LinkedIn version", instagram: "Instagram version", threads }));
    const a = await run("repurpose_post", { post: POST }, deps(ai.deps));
    assert.equal(a.status, 200);
    const j = jobOf(a);
    assert.equal(j.status, "done", JSON.stringify(j));
    assert.deepEqual(ai.seen.tenants, [OASIS], "the account read is the session's workspace");
    const variants = j.result?.variants as Record<string, { text: string; chars: number; max_chars: number; over_limit: boolean }>;
    assert.deepEqual(Object.keys(variants), ["linkedin", "instagram", "threads"]);
    assert.equal(variants.threads.text, threads, "never cut short");
    assert.deepEqual([variants.threads.chars, variants.threads.max_chars, variants.threads.over_limit], [600, 500, true]);
    assert.deepEqual([variants.linkedin.max_chars, variants.linkedin.over_limit], [3000, false]);
    const call = ai.seen.calls[0];
    assert.equal(call.apiKey, "test-key");
    assert.equal(call.maxTokens, 2500);
    assert.ok(call.system?.includes(INJECTION_GUARD), "the input-boundary rules are in the system prompt");
    assert.ok(call.system?.includes("Keep the author's facts; add no claims."));
    assert.ok(!/friend at 2am/i.test(call.system ?? ""), "not CC's own brand voice");
    assert.ok(call.messages[0].content.includes("<<<UNTRUSTED_INPUT_BEGIN>>>"), "the post is fenced as data");
    const row = (await db.execute({ sql: "SELECT tenant_id, surface, job_id, user_id, billing_mode, outcome FROM ai_usage_events WHERE job_id = ?", args: [j.id] })).rows;
    assert.equal(row.length, 1, "one usage row for the one model call");
    assert.deepEqual(
      [row[0].tenant_id, row[0].surface, row[0].user_id, row[0].billing_mode, row[0].outcome],
      [OASIS, "tools.repurpose_post", USERS.cc.id, "byo_key", "ok"],
    );
  });

  await check("a deadline (deadlineMs): a slow model call returns ai_timeout at once, its stream is closed, and its row says cancelled under its surface and job", async () => {
    const { runToolModelCall } = await import("../lib/tools/worker/ai");
    let closed = false;
    const slow = {
      readAccount: async () => ACCOUNT,
      decrypt: () => "test-key",
      usageDb: db,
      stream: async function* (req: ChatRequest): AsyncGenerator<StreamEvent> {
        const call = await req.meter.begin({ provider: req.provider, model: req.model, maxOutputTokens: req.maxTokens ?? 0, promptBytes: 1 });
        let end: Parameters<typeof call.finish>[0] | null = null;
        try {
          yield { type: "delta", text: "partial" };
          await new Promise((r) => setTimeout(r, 400));
          yield { type: "delta", text: " and the rest" };
          end = { outcome: "ok", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
          yield { type: "done", inputTokens: 1, outputTokens: 1 };
        } finally {
          closed = true;
          await call.finish(end ?? { outcome: "cancelled", usage: null });
        }
      },
    };
    const call = (jobId: string, deadlineMs?: number) =>
      runToolModelCall({ tenantId: OASIS, userId: USERS.cc.id, jobId, surface: "automations.draft", system: "s", prompt: "p", maxTokens: 100, ...(deadlineMs ? { deadlineMs } : {}) }, slow);
    const t0 = Date.now();
    assert.deepEqual(await call("draft-deadline-1", 100), { ok: false, code: "ai_timeout" });
    assert.ok(Date.now() - t0 < 350, `the deadline did not answer at once (${Date.now() - t0} ms)`);
    for (let i = 0; i < 100 && !closed; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(closed, true, "the timed-out stream was never closed");
    const row = (await db.execute({ sql: "SELECT surface, outcome, job_id FROM ai_usage_events WHERE job_id = 'draft-deadline-1'", args: [] })).rows;
    assert.deepEqual(row.map((r) => [r.surface, r.outcome, r.job_id]), [["automations.draft", "cancelled", "draft-deadline-1"]]);
    // Without a deadline the same call finishes.
    closed = false;
    const full = await call("draft-deadline-2");
    assert.ok(full.ok && full.text === "partial and the rest", JSON.stringify(full));
  });

  await check("a saved model the registry knows is gone is sent as its replacement, and the run and the usage row say so", async () => {
    const ai = fakeAi(JSON.stringify({ linkedin: "a", instagram: "b", threads: "c" }), { ...ACCOUNT, model: "gemini-2.5-pro" });
    const j = jobOf(await run("repurpose_post", { post: POST }, deps(ai.deps)));
    assert.equal(j.status, "done", JSON.stringify(j));
    assert.equal(ai.seen.calls[0].model, "gemini-3.8-flash", "the request sends the replacement");
    assert.equal(j.result?.model, "gemini-3.8-flash", "the run names the model it really sent");
    const row = (await db.execute({ sql: "SELECT model, fallback_reason FROM ai_usage_events WHERE job_id = ?", args: [j.id] })).rows[0];
    assert.deepEqual([row.model, row.fallback_reason], ["gemini-3.8-flash", "model_access_limited:gemini-2.5-pro"]);
  });

  await check("no usable AI account (none, switched off, a local model, unreadable): the run fails with its own line and no model is called", async () => {
    const cases: Array<[WorkspaceAiAccount | null | Error, string, string]> = [
      [null, "ai_account_missing", "Connect an AI account in Settings > AI brain to use this tool."],
      [{ ...ACCOUNT, enabled: false }, "ai_account_missing", "Connect an AI account in Settings > AI brain to use this tool."],
      [{ ...ACCOUNT, provider: "ollama" }, "ai_account_missing", "Connect an AI account in Settings > AI brain to use this tool."],
      [{ ...ACCOUNT, encryptedApiKey: "not-decryptable" }, "ai_account_unreadable", "Couldn't read the AI account. Try again."],
      [new Error("agent_model_config read failed"), "ai_account_unreadable", "Couldn't read the AI account. Try again."],
    ];
    const quiet = console.error;
    console.error = () => undefined;
    try {
      for (const [account, code, line] of cases) {
        const ai = fakeAi("{}", account);
        const a = await run("repurpose_post", { post: POST }, deps(ai.deps));
        assert.equal(a.status, 200, "a failed tool is still a 200; the failure is in the run");
        const j = jobOf(a);
        assert.deepEqual([j.status, j.error_code, j.error_message], ["failed", code, line]);
        assert.equal(ai.seen.calls.length, 0, "no model call");
      }
    } finally {
      console.error = quiet;
    }
  });

  await check("a model answer that is not the three versions fails the run as ai_unusable_answer, never 'didn't answer'", async () => {
    const ai = fakeAi("Sure! Here are your posts...");
    const j = jobOf(await run("repurpose_post", { post: POST }, deps(ai.deps)));
    assert.deepEqual(
      [j.status, j.error_code, j.error_message],
      ["failed", "ai_unusable_answer", "The AI answered, but not in a form this tool can use; nothing was saved. Try again."],
    );
  });

  // -- The only Repurpose run in production (tool_jobs 67b30884, 2026-10-10 02:31Z) --
  // Its input was an Instagram reel URL; its model call (google, gemini-3.8-flash)
  // ended http_524 after 132 s; the card said "The AI account didn't answer".
  await check("a post that is only a link is refused up front with a plain line: no run, no model call, no usage row", async () => {
    const ai = fakeAi(JSON.stringify({ linkedin: "a", instagram: "b", threads: "c" }));
    const jobsBefore = Number(await scalar(db, "SELECT COUNT(*) FROM tool_jobs"));
    const usageBefore = Number(await scalar(db, "SELECT COUNT(*) FROM ai_usage_events"));
    for (const post of ["https://www.instagram.com/reels/DeP8Ju0p13h/", "  instagram.com/reel/abc  https://tiktok.com/t/xyz ", "x.co/a"]) {
      const a = await run("repurpose_post", { post }, deps(ai.deps));
      assert.equal(a.status, 422, post);
      assert.deepEqual(
        [a.body.error, a.body.field, a.body.code, a.body.message],
        ["invalid_input", "post", "link_only", "Paste the post's text. Grabbing a post from a link is coming next."],
        post,
      );
    }
    assert.equal(ai.seen.calls.length, 0, "the model was never asked to rewrite a URL");
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM tool_jobs")), jobsBefore, "no run was recorded");
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM ai_usage_events")), usageBefore, "no usage row");
    // A post that carries a link among its words is still a post.
    const ok = jobOf(await run("repurpose_post", { post: `${POST} https://oasisai.work/ai-audit` }, deps(ai.deps)));
    assert.equal(ok.status, "done");
  });

  /** An account whose provider refuses with `message` (lib/providers.ts's error event shapes). */
  function refusingAi(message: string) {
    return {
      readAccount: async () => ACCOUNT,
      decrypt: () => "test-key",
      usageDb: db,
      stream: async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "error", message };
      },
    };
  }

  await check("the provider's own refusal is named: down/timed out, key, model, quota, filter; only an unreadable failure is ai_failed", async () => {
    const cases: Array<[string, string, RegExp]> = [
      ["provider_temporarily_unavailable:google_524", "ai_provider_down", /didn't answer \(it was busy or timed out\)/],
      ["provider_temporarily_unavailable:google_503", "ai_provider_down", /busy or timed out/],
      ["google_400:API key not valid. Please pass a valid API key.", "ai_key_refused", /owner or admin needs to check its key and billing in Settings > AI brain/],
      ["anthropic_401:invalid x-api-key", "ai_key_refused", /Settings > AI brain/],
      ["openrouter_402:Insufficient credits", "ai_key_refused", /billing/],
      ["google_404:models/gemini-x is not found", "ai_model_not_found", /pick another model there/],
      ["provider_temporarily_unavailable:openai_429", "ai_rate_limited", /rate-limited or out of quota/],
      ["empty_reply:blocked", "ai_blocked", /safety filter/],
      ["something nobody wrote down", "ai_failed", /^The AI account didn't answer\. Try again\.$/],
    ];
    for (const [message, code, line] of cases) {
      const j = jobOf(await run("repurpose_post", { post: POST }, deps(refusingAi(message))));
      assert.equal(j.status, "failed", message);
      assert.equal(j.error_code, code, message);
      assert.match(String(j.error_message), line, message);
      assert.doesNotMatch(String(j.error_message), /—/, "no em dash in a line a person reads");
    }
  });

  await check("a model call that never answers times out at the bound: honest message, nothing saved, no ai_failed", async () => {
    const quiet = console.error;
    console.error = () => undefined;
    let j: Job;
    try {
      j = jobOf(await run("repurpose_post", { post: POST }, deps(hungAi(30))));
    } finally {
      console.error = quiet;
    }
    assert.deepEqual(
      [j.status, j.error_code, j.error_message],
      ["failed", "ai_timeout", "The AI account took too long to answer; nothing was saved. Try again."],
    );
    assert.notEqual(j.error_code, "ai_failed", "a timeout is never reported as the generic ai_failed");
  });

  await check("a fast model call, well inside the same bound, still succeeds", async () => {
    const ai = fakeAi(JSON.stringify({ linkedin: "a", instagram: "b", threads: "c" }));
    (ai.deps as { timeoutMs?: number }).timeoutMs = 200;
    const j = jobOf(await run("repurpose_post", { post: POST }, deps(ai.deps)));
    assert.equal(j.status, "done", JSON.stringify(j));
  });

  await check("modelBudgetMs: never more than the model's own cap, shrinks with elapsed time, floors at 0 (pure)", () => {
    // One fixed clock for both sides: reading Date.now() twice let a slow CI
    // runner tick a millisecond between them (54999 !== 55000, PR #583).
    const now = Date.parse("2026-10-11T04:00:00Z");
    const start = (secondsAgo: number) => new Date(now - secondsAgo * 1000);
    assert.equal(modelBudgetMs(start(0), now), 55_000, "nothing elapsed: the full 55 s cap");
    assert.equal(modelBudgetMs(start(10), now), 45_000, "10 s already spent: 60 - 10 - 5 reserve");
    assert.equal(modelBudgetMs(start(56), now), 0, "almost the whole 60 s request budget already spent: no time left");
    assert.equal(modelBudgetMs(start(999), now), 0, "floors at 0, never negative");
  });

  await check(
    "a slow pre-model phase shrinks the model's own budget against the WHOLE request: too little left, and the run fails fast with request_timeout - NEVER ai_timeout, since the AI account is never contacted on this path",
    async () => {
      const ai = fakeAi(JSON.stringify({ linkedin: "a", instagram: "b", threads: "c" })); // would succeed, given the time
      const j = jobOf(await run("repurpose_post", { post: POST }, deps(ai.deps, undefined, db, backdatedNow(56))));
      assert.deepEqual(
        [j.status, j.error_code, j.error_message],
        ["failed", "request_timeout", "This took too long and was stopped; nothing was saved. Try again."],
      );
      assert.equal(ai.seen.calls.length, 0, "no model call was even attempted: no time left to answer AND still record the failure");
    },
  );

  await check(
    "a slow ACCOUNT READ shrinks the budget too, even when the budget was fine when the request started: recomputed right before the stream, never the stale value from before the account/budget reads (Codex review round 4, P2)",
    async () => {
      // The budget is fine at the start (150 ms to spare) - the FIRST check
      // (lib/tools/worker/ai.ts, before readAccount) lets this through. The
      // account read then really does take 500 ms of wall-clock time, which
      // a stale timeout computed before it would never see.
      const slow = slowAccountAi(500);
      const j = jobOf(await run("repurpose_post", { post: POST }, deps(slow.deps, undefined, db, backdatedNow(54.85))));
      assert.deepEqual(
        [j.status, j.error_code, j.error_message],
        ["failed", "request_timeout", "This took too long and was stopped; nothing was saved. Try again."],
        "recorded as a failure, never left running, and never blames the AI account it was never asked",
      );
      assert.equal(slow.seen.calls.length, 0, "the model itself was still never called: the recheck caught it before streaming started");
    },
  );

  // -- Learn from a link ----------------------------------------------------------------
  const ARTICLE_HTML = (title: string) =>
    `<html><head><title>${title}</title><script>var x = "<p>not text</p>";</script><style>p{}</style></head>` +
    `<body><nav>Menu</nav><h1>Why reply speed wins</h1><p>${"Most clinics reply to a new lead the next morning. ".repeat(6)}</p>` +
    `<p>Here &amp; now: answer in one minute.</p></body></html>`;
  const ANALYSIS = { hook: "Most clinics reply the next morning.", pacing: "Short claims, then one example.", tone: "Plain and direct.", structure: ["claim", "proof", "ask"], steal: "Open with the reader's own habit.", avoid: "The clinic statistics." };

  await check(
    "Learn from a link hits the same request_timeout after a slow pre-model phase (here, the page fetch) - tool-neutral wording, never 'a shorter post' on a tool whose input is a link",
    async () => {
      const url = "https://example.com/slow-fetch-no-time-left";
      const web = fakeWeb({ [url]: { status: 200, body: ARTICLE_HTML("slow") } });
      const ai = fakeAi(JSON.stringify(ANALYSIS)); // would succeed, given the time
      const j = jobOf(await run("learn_from_link", { url }, deps(ai.deps, web.fetchPage, db, backdatedNow(56))));
      assert.deepEqual(
        [j.status, j.error_code, j.error_message],
        ["failed", "request_timeout", "This took too long and was stopped; nothing was saved. Try again."],
      );
      assert.doesNotMatch(j.error_message ?? "", /post|AI account/i, "never a post-specific or AI-account-blaming line on this path");
      assert.equal(ai.seen.calls.length, 0, "the AI account was never contacted");
    },
  );

  await check("Learn writes ONE indexed training note for the session's workspace, in the background reader's shape", async () => {
    const url = "https://example.com/blog/reply-speed";
    const web = fakeWeb({ [url]: { status: 200, body: ARTICLE_HTML("Reply speed &amp; bookings") } });
    const ai = fakeAi(JSON.stringify(ANALYSIS));
    const a = await run("learn_from_link", { url, label: "counter_example" }, deps(ai.deps, web.fetchPage));
    const j = jobOf(a);
    assert.equal(j.status, "done", JSON.stringify(j));
    const rows = (await db.execute({ sql: "SELECT * FROM marketing_corpus WHERE source_url = ?", args: [url] })).rows as unknown as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.deepEqual([r.tenant_id, r.kind, r.label, r.state, Number(r.attempts)], [OASIS, "link", "counter_example", "indexed", 1]);
    assert.equal(r.title, "Reply speed & bookings");
    assert.equal(r.contributed_by, USERS.cc.email);
    assert.ok(r.indexed_at, "indexed_at is set");
    assert.equal(r.search_text, `${ANALYSIS.hook} ${ANALYSIS.steal}`);
    assert.ok(String(r.transcript).includes("Here & now: answer in one minute."), "entities decoded");
    assert.ok(!String(r.transcript).includes("not text"), "scripts dropped");
    const ex = JSON.parse(String(r.extraction));
    assert.deepEqual(ex.analysis, ANALYSIS);
    assert.deepEqual([ex.via, ex.tool_job_id, ex.source_kind, ex.model], ["toolkit:learn_from_link", j.id, "web", { provider: "google", model: "gemini-test" }]);
    assert.equal(j.result?.corpus_id, r.id);
    assert.deepEqual(Object.keys(j.result?.analysis as object), ["hook", "pacing", "tone", "structure", "steal", "avoid"]);
    const usage = await scalar(db, "SELECT surface FROM ai_usage_events WHERE job_id = ?", [j.id]);
    assert.equal(usage, "tools.learn_from_link");
    // Read again: the same note is updated in place, never a second row.
    const again = jobOf(await run("learn_from_link", { url, label: "exemplar" }, deps(fakeAi(JSON.stringify(ANALYSIS)).deps, web.fetchPage)));
    assert.equal(again.status, "done");
    const after = (await db.execute({ sql: "SELECT id, label, attempts FROM marketing_corpus WHERE source_url = ?", args: [url] })).rows;
    assert.equal(after.length, 1);
    assert.deepEqual([after[0].id, after[0].label, Number(after[0].attempts)], [r.id, "exemplar", 2]);
  });

  await check("a link already being read is refused (already_being_read) before the page or a model is touched", async () => {
    const url = "https://example.com/queued";
    await db.execute({
      sql: "INSERT INTO marketing_corpus (tenant_id, kind, label, source_url, state) VALUES (?, 'link', 'exemplar', ?, 'queued')",
      args: [OASIS, url],
    });
    const web = fakeWeb({ [url]: { status: 200, body: ARTICLE_HTML("x") } });
    const ai = fakeAi(JSON.stringify(ANALYSIS));
    const j = jobOf(await run("learn_from_link", { url }, deps(ai.deps, web.fetchPage)));
    assert.deepEqual([j.status, j.error_code, j.error_message], ["failed", "already_being_read", "This link is already being read."]);
    assert.equal(web.asked.length, 0);
    assert.equal(ai.seen.calls.length, 0);
  });

  await check("a read that starts DURING the run wins: the note is not written and the run says so", async () => {
    const url = "https://example.com/race";
    const web = fakeWeb({ [url]: { status: 200, body: ARTICLE_HTML("race") } });
    const ai = fakeAi(async () => {
      // The Training page queues the same link while the model is thinking.
      await db.execute({ sql: "INSERT INTO marketing_corpus (tenant_id, kind, label, source_url, state) VALUES (?, 'link', 'exemplar', ?, 'queued')", args: [OASIS, url] });
      return JSON.stringify(ANALYSIS);
    });
    const j = jobOf(await run("learn_from_link", { url }, deps(ai.deps, web.fetchPage)));
    assert.deepEqual([j.status, j.error_code], ["failed", "already_being_read"]);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM marketing_corpus WHERE source_url = ? AND state = 'indexed'", [url])), 0);
  });

  await check("thin, non-HTML, unreachable and unanswerable pages fail with their own lines (and a 200)", async () => {
    const thin = "https://example.com/thin";
    const pdf = "https://example.com/file";
    const gone = "https://example.com/gone";
    const nulls = "https://example.com/nulls";
    const prose = "https://example.com/prose";
    const web = fakeWeb({
      [thin]: { status: 200, body: "<html><title>t</title><body>Sign in to continue.</body></html>" },
      // Long enough to read as text: only its type makes it unreadable.
      [pdf]: { status: 200, contentType: "application/pdf", body: `%PDF-1.7 ${"stream of words ".repeat(30)}` },
      [nulls]: { status: 200, body: ARTICLE_HTML("n") },
      [prose]: { status: 200, body: ARTICLE_HTML("p") },
    });
    const expect = async (url: string, reply: string, code: string, line: string) => {
      const j = jobOf(await run("learn_from_link", { url }, deps(fakeAi(reply).deps, web.fetchPage)));
      assert.deepEqual([j.status, j.error_code, j.error_message], ["failed", code, line], url);
    };
    // A model that WOULD answer: only the page's own emptiness or type may refuse it.
    await expect(thin, JSON.stringify(ANALYSIS), "page_unreadable", "That page had no readable text. It may need a sign-in.");
    await expect(pdf, JSON.stringify(ANALYSIS), "page_unreadable", "That page had no readable text. It may need a sign-in.");
    await expect(gone, "{}", "fetch_failed", "Couldn't open that link.");
    await expect(nulls, JSON.stringify({ hook: null, pacing: null, tone: null, structure: null, steal: null, avoid: null }), "page_unreadable", "That page had no readable text. It may need a sign-in.");
    await expect(prose, "I think this page is about reply speed.", "ai_failed", "The AI account didn't answer. Try again.");
  });

  await check("private and loopback addresses are refused at the door, and a redirect into one is never followed", async () => {
    for (const url of ["http://127.0.0.1/admin", "http://localhost:3000/", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/", "https://user:pw@example.com/"]) {
      const a = await run("learn_from_link", { url });
      assert.deepEqual([a.status, a.body.error, a.body.field], [422, "invalid_input", "url"], url);
    }
    const asked: string[] = [];
    const r = await fetchFollowing("https://example.com/redirect", async (u) => {
      asked.push(u.toString());
      return { status: 302, contentType: "text/html", body: "", truncated: false, location: "http://169.254.169.254/latest/meta-data" };
    });
    assert.deepEqual(r, { ok: false, code: "fetch_failed" });
    assert.deepEqual(asked, ["https://example.com/redirect"], "the private hop is never requested");
    let hops = 0;
    const loop = await fetchFollowing("https://example.com/a", async (u) => {
      hops += 1;
      return { status: 301, contentType: "text/html", body: "", truncated: false, location: `${u.toString()}x` };
    });
    assert.deepEqual([loop.ok, hops], [false, 4], "at most three redirects are followed");
  });

  await check("HTML to text: title from og:title, scripts and styles dropped, entities decoded, whitespace collapsed", () => {
    const r = htmlToText(`<head><meta property="og:title" content="A &amp; B"><title>ignored</title></head><body><script>bad()</script><p>One&nbsp;two</p>\n\n<p>&#39;three&#x27;</p></body>`);
    assert.equal(r.title, "A & B");
    assert.equal(r.text, "One two 'three'");
  });

  // -- the session routes ----------------------------------------------------------------
  await check("one workspace never sees another's runs", async () => {
    await login(USERS.clientA);
    const ai = fakeAi(JSON.stringify({ linkedin: "a", instagram: "b", threads: "c" }));
    const theirs = jobOf(await run("repurpose_post", { post: POST }, deps(ai.deps)));
    assert.equal(theirs.status, "done");
    await login(USERS.cc);
    const list = await answerOf(await handleToolJobs(jobsReq("tool=repurpose_post&limit=20"), deps()));
    assert.ok(!(list.body.jobs as Job[]).some((j) => j.id === theirs.id), "OASIS's list does not hold the client's run");
    const one = await answerOf(await handleToolJobs(jobsReq(`id=${theirs.id}`), deps()));
    assert.deepEqual([one.status, one.body.error], [404, "not_found"]);
  });

  await check("Learn from a link is operator-only: a founder of another workspace is refused on run AND jobs; the platform operator is allowed", async () => {
    await login(USERS.clientA);
    const refusedRun = await answerOf(await handleToolRun(runReq("learn_from_link", { url: "https://example.com/op-only" }), deps()));
    assert.deepEqual([refusedRun.status, refusedRun.body.error], [404, "not_found"], "a founder who is not a platform operator may not start it");
    const refusedJobs = await answerOf(await handleToolJobs(jobsReq("tool=learn_from_link"), deps()));
    assert.deepEqual([refusedJobs.status, refusedJobs.body.error], [404, "not_found"], "nor read its run history");

    await login(USERS.cc);
    const url = "https://example.com/op-only-ok";
    const web = fakeWeb({ [url]: { status: 200, body: ARTICLE_HTML("operator ok") } });
    const ai = fakeAi(JSON.stringify(ANALYSIS));
    const j = jobOf(await run("learn_from_link", { url }, deps(ai.deps, web.fetchPage)));
    assert.equal(j.status, "done", JSON.stringify(j));
    const okJobs = await answerOf(await handleToolJobs(jobsReq(`id=${j.id}`), deps()));
    assert.equal(okJobs.status, 200, "a platform operator reads it back by id");
    const okList = await answerOf(await handleToolJobs(jobsReq("tool=learn_from_link"), deps()));
    assert.equal(okList.status, 200, "and by its run history");

    // The gate stands even with the job id known (never 403, which would
    // confirm it exists; the same "not_found" the viewer gate itself answers).
    await login(USERS.clientA);
    const stillRefused = await answerOf(await handleToolJobs(jobsReq(`id=${j.id}`), deps()));
    assert.deepEqual([stillRefused.status, stillRefused.body.error], [404, "not_found"]);
    await login(USERS.cc);
  });

  await check(
    "the operator check reads the SESSION's own email, never user_profiles.email: a profile whose stored email is the alias, with no platform_operators row, is still refused",
    async () => {
      // The squat lib/platform-operator.ts's own doc comment names: an OASIS
      // owner row whose user_profiles.email COLUMN happens to be the alias
      // string, but whose real authenticated session is someone else
      // entirely (not an alias, not on the operator domain, no
      // platform_operators row). The founders gate still admits them (an
      // OASIS owner is a founder); the operator gate must not.
      const squatterAuthId = "0e000000-0000-4000-8000-00000000a11a";
      const stamp = new Date().toISOString();
      // The REAL auth identity (what verifySessionAgainstDb actually trusts,
      // lib/turso-auth.ts: it reads _supabase_auth_users.email, never the
      // signed cookie's own email field) is the attacker's own address.
      await db.execute({
        sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`,
        args: [squatterAuthId, "squatter@attacker.test"],
      });
      // The SPOOFED column: an OASIS owner profile whose user_profiles.email
      // the squatter set to the alias string - the exact squat
      // lib/platform-operator.ts's own doc comment names.
      await db.execute({
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, joined_at, updated_at)
              VALUES ('p-squatter-alias-email', ?, ?, ?, 'owner', 1, ?, ?, ?)`,
        args: [squatterAuthId, "conaugh@oasisai.work", OASIS, stamp, stamp, stamp],
      });
      await login({ id: squatterAuthId, email: "squatter@attacker.test" });
      // Prove the founders/viewer gate ADMITS this session (an OASIS owner
      // row) before proving the operator check refuses it specifically - a
      // tool with no operatorOnly flag must still work for them.
      const passesFoundersGate = jobOf(await run("repurpose_post", { post: POST }, deps()));
      assert.equal(passesFoundersGate.status, "failed", "reaches the run (a non-operator tool is not refused outright)");
      assert.notEqual(passesFoundersGate.error_code, "not_found" as unknown, "sanity: this is a job outcome, not a gate refusal");
      const refusedRun = await answerOf(await handleToolRun(runReq("learn_from_link", { url: "https://example.com/squat-attempt" }), deps()));
      assert.deepEqual([refusedRun.status, refusedRun.body.error], [404, "not_found"], "a spoofed profile email never passes the operator check");
      const refusedJobs = await answerOf(await handleToolJobs(jobsReq("tool=learn_from_link"), deps()));
      assert.deepEqual([refusedJobs.status, refusedJobs.body.error], [404, "not_found"]);
      await login(USERS.cc);
    },
  );

  await check("outside the gate (a sales rep, signed out): 404 not_found on run and jobs, nothing written", async () => {
    const before = Number(await scalar(db, "SELECT COUNT(*) FROM tool_jobs"));
    for (const who of [USERS.rep, null]) {
      await login(who);
      const r = await answerOf(await handleToolRun(runReq("repurpose_post", { post: POST }), deps()));
      assert.deepEqual([r.status, r.body.error], [404, "not_found"]);
      const l = await answerOf(await handleToolJobs(jobsReq("tool=repurpose_post"), deps()));
      assert.deepEqual([l.status, l.body.error], [404, "not_found"]);
    }
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM tool_jobs")), before);
    await login(USERS.cc);
  });

  await check("the same click is one run; the same key for another input is refused", async () => {
    const key = randomUUID();
    const a = jobOf(await run("repurpose_post", { post: POST }, deps(), key));
    const b = jobOf(await run("repurpose_post", { post: POST }, deps(), key));
    assert.equal(a.id, b.id);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM tool_jobs WHERE idempotency_key = ?", [key])), 1);
    const c = await run("repurpose_post", { post: "A different long enough post to repurpose into other things." }, deps(), key);
    assert.deepEqual([c.status, c.body.error], [409, "idempotency_key_reused"]);
    const notUuid = await run("repurpose_post", { post: POST }, deps(), "not-a-uuid");
    assert.deepEqual([notUuid.status, notUuid.body.field], [422, "idempotency_key"]);
  });

  await check("a run cut off mid-request is shown as stopped after 5 minutes (interrupted), with its line", async () => {
    const id = randomUUID();
    const old = later(new Date(), -minutes(6)).toISOString();
    await db.execute({
      sql: `INSERT INTO tool_jobs (id, tenant_id, tool_key, runs_on, status, input_json, input_hash, created_at, updated_at)
            VALUES (?, ?, 'repurpose_post', 'worker', 'running', '{"post":"x"}', 'h', ?, ?)`,
      args: [id, OASIS, old, old],
    });
    const one = await answerOf(await handleToolJobs(jobsReq(`id=${id}`), deps()));
    const j = one.body.job as Job;
    assert.deepEqual([j.status, j.error_code, j.error_message], ["failed", "interrupted", "This run stopped before it finished. Run it again."]);
  });

  await check("Download a video: refused while no runner is live, queued once a runner is, a link in flight is reused, five at most", async () => {
    const url = "https://www.instagram.com/reel/DownloadMe1/";
    const off = await run("video_download", { url });
    assert.deepEqual([off.status, off.body.error, off.body.message], [409, "runner_offline", "The computer that runs downloads was offline, so this didn't run."]);
    await seedRunner(db, new Date());
    const a = await run("video_download", { url: "http://instagram.com/reel/DownloadMe1/?igsh=abc" });
    assert.equal(a.status, 200);
    const j = jobOf(a);
    assert.equal(j.status, "queued");
    const row = (await db.execute({ sql: "SELECT input_json, created_by_email FROM tool_jobs WHERE id = ?", args: [j.id] })).rows[0];
    assert.deepEqual(JSON.parse(String(row.input_json)), { url, platform: "instagram" }, "canonical https link, tracking stripped");
    assert.equal(row.created_by_email, USERS.cc.email);
    const again = await run("video_download", { url });
    assert.deepEqual([again.status, again.body.reused, jobOf(again).id], [200, true, j.id]);
    for (let n = 2; n <= 5; n += 1) assert.equal((await run("video_download", { url: `https://www.instagram.com/reel/DownloadMe${n}/` })).status, 200);
    const sixth = await run("video_download", { url: "https://www.instagram.com/reel/DownloadMe6/" });
    assert.deepEqual([sixth.status, sixth.body.error, sixth.body.message], [429, "too_many_in_flight", "Five downloads are already in progress."]);
  });

  await check("the catalog: Repurpose by the account's state; Download ONLY while a live runner lists it; Learn from a link only in the operator audience", async () => {
    const { getToolCatalog } = await import("../lib/tools/catalog");
    const now = new Date();
    const keys = (c: Awaited<ReturnType<typeof getToolCatalog>>) => (c.installed ? c.tools.map((t) => `${t.key}:${t.state}`) : ["not installed"]);
    // No runner seen for CLIENT_A, ever: no Download card. The default
    // ("client") audience never carries learn_from_link: it is operatorOnly.
    const client = await getToolCatalog({ tenantId: CLIENT_A }, { db, now, readAccount: async () => null });
    assert.deepEqual(keys(client), ["repurpose_post:needs_ai_account"]);
    const local = await getToolCatalog({ tenantId: CLIENT_A }, { db, now, readAccount: async () => ({ ...ACCOUNT, provider: "ollama" }) });
    assert.deepEqual(keys(local), ["repurpose_post:needs_ai_account"], "a local model is no account here");
    const quiet = console.error;
    console.error = () => undefined;
    const broken = await getToolCatalog({ tenantId: CLIENT_A }, { db, now, readAccount: async () => { throw new Error("read failed"); } }).finally(() => {
      console.error = quiet;
    });
    assert.deepEqual(keys(broken), ["repurpose_post:ai_account_unreadable"]);
    // OASIS with a runner seen 4 minutes ago: the Download card, naming the runner.
    await seedRunner(db, later(now, -minutes(4)));
    const live = await getToolCatalog({ tenantId: OASIS }, { db, now, readAccount: async () => ACCOUNT });
    assert.deepEqual(keys(live), ["repurpose_post:ready", "video_download:ready"]);
    const dl = live.installed ? live.tools.find((t) => t.key === "video_download") : undefined;
    // The catalog hands the grid the check-in time itself; the grid counts the minutes on the viewer's clock.
    assert.equal(dl?.runner?.label, "CC's PC");
    assert.equal(Math.round((now.getTime() - Date.parse(dl?.runner?.lastSeenAt ?? "")) / 60_000), 4, "the runner's check-in time, 4 minutes ago");
    // Eleven minutes: not live, no card.
    await seedRunner(db, later(now, -minutes(11)));
    const stale = await getToolCatalog({ tenantId: OASIS }, { db, now, readAccount: async () => ACCOUNT });
    assert.ok(!keys(stale).some((k) => k.startsWith("video_download")));
    assert.deepEqual(await getToolCatalog({ tenantId: OASIS }, { db: emptyDatabase(), now, readAccount: async () => ACCOUNT }), { installed: false });

    // The "operator" audience (Admin > Agent training): ONLY the operatorOnly
    // tool, whichever tenant asks - getToolCatalog itself does not know who
    // is an operator, it only picks WHICH tools; lib/tools/session-handlers.ts
    // is what actually refuses a non-operator (proved above).
    const operatorView = await getToolCatalog({ tenantId: OASIS }, { db, now, readAccount: async () => ACCOUNT }, { audience: "operator" });
    assert.deepEqual(keys(operatorView), ["learn_from_link:ready"]);
    const operatorNeedsAccount = await getToolCatalog({ tenantId: CLIENT_A }, { db, now, readAccount: async () => null }, { audience: "operator" });
    assert.deepEqual(keys(operatorNeedsAccount), ["learn_from_link:needs_ai_account"]);
  });

  await check("tables not installed: run and jobs answer 503 not_set_up with the plain line", async () => {
    const empty = emptyDatabase();
    const r = await answerOf(await handleToolRun(runReq("repurpose_post", { post: POST }), deps(undefined, undefined, empty)));
    assert.deepEqual([r.status, r.body.error, r.body.message], [503, "not_set_up", "Tools are not set up yet."]);
    const l = await answerOf(await handleToolJobs(jobsReq("tool=repurpose_post"), deps(undefined, undefined, empty)));
    assert.deepEqual([l.status, l.body.error], [503, "not_set_up"]);
  });

  finish("tools worker");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
