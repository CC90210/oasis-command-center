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
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

type Fixture = { hook: string; caption?: string; expected: Record<string, unknown> };

async function main() {
  console.log("tools worker:");
  const db = await setupToolsDatabase();
  const { handleToolRun, handleToolJobs } = await import("../lib/tools/session-handlers");
  const { resolveToolsViewer } = await import("../lib/tools/access");
  const { scoreHook } = await import("../lib/tools/worker/score-hook");
  const { fetchFollowing, htmlToText } = await import("../lib/tools/worker/learn-from-link");
  const { INJECTION_GUARD } = await import("../lib/llm-input-boundary");

  /** A fake model on a fake account. It meters the call through the real ledger, as lib/providers.ts does. */
  function fakeAi(reply: string | ((req: ChatRequest) => Promise<string> | string), account: WorkspaceAiAccount | null | Error = ACCOUNT) {
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
    };
    return { deps, seen };
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

  const deps = (ai = fakeAi("{}").deps, fetchPage?: (u: URL) => Promise<PageAnswer>, d: Client = db) => ({
    db: d,
    now: () => new Date(),
    viewer: resolveToolsViewer,
    worker: { ai, fetchPage },
  });
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

  // -- Score a hook ------------------------------------------------------------
  await check("Score a hook equals the Python scorer on every recorded fixture (score, max, pct, verdicts, type, suggestions)", () => {
    const fx = JSON.parse(readFileSync(join(__dirname, "fixtures", "tools", "hook-scorer-parity.json"), "utf8")) as { scorer_version: string; cases: Fixture[] };
    assert.equal(fx.scorer_version, "1.0.0");
    assert.ok(fx.cases.length >= 10, "at least ten recorded hooks");
    for (const c of fx.cases) {
      const got = scoreHook(c.hook, c.caption ?? "");
      const e = c.expected;
      assert.equal(got.score.toFixed(3), Number(e.score).toFixed(3), `score: ${c.hook}`);
      assert.equal(got.max_score.toFixed(3), Number(e.max_score).toFixed(3), `max_score: ${c.hook}`);
      assert.ok(Math.abs(got.score_pct - Number(e.score_pct)) <= 0.1, `score_pct ${got.score_pct} vs ${e.score_pct}: ${c.hook}`);
      assert.equal(got.passed, e.passed, `passed: ${c.hook}`);
      assert.deepEqual(got.hard_fails, e.hard_fails, `hard_fails: ${c.hook}`);
      assert.deepEqual(got.warns, e.warns, `warns: ${c.hook}`);
      assert.equal(got.hook_type, e.hook_type, `hook_type: ${c.hook}`);
      assert.deepEqual(got.suggestions, e.suggestions, `suggestions: ${c.hook}`);
    }
  });

  await login(USERS.cc);
  await check("Score a hook through the route: done in the same request, the score in the run", async () => {
    const a = await run("score_hook", { hook: "If you run a clinic, stop answering the phone at 9pm", caption: "" });
    assert.equal(a.status, 200);
    const j = jobOf(a);
    assert.equal(j.status, "done");
    assert.equal(j.result?.score_pct, 92.6);
    assert.equal(j.result?.scorer, "hook_scorer 1.0.0 text-mode port");
  });

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

  await check("a model answer that is not the three versions fails the run as ai_failed", async () => {
    const ai = fakeAi("Sure! Here are your posts...");
    const j = jobOf(await run("repurpose_post", { post: POST }, deps(ai.deps)));
    assert.deepEqual([j.status, j.error_code, j.error_message], ["failed", "ai_failed", "The AI account didn't answer. Try again."]);
  });

  // -- Learn from a link ----------------------------------------------------------------
  const ARTICLE_HTML = (title: string) =>
    `<html><head><title>${title}</title><script>var x = "<p>not text</p>";</script><style>p{}</style></head>` +
    `<body><nav>Menu</nav><h1>Why reply speed wins</h1><p>${"Most clinics reply to a new lead the next morning. ".repeat(6)}</p>` +
    `<p>Here &amp; now: answer in one minute.</p></body></html>`;
  const ANALYSIS = { hook: "Most clinics reply the next morning.", pacing: "Short claims, then one example.", tone: "Plain and direct.", structure: ["claim", "proof", "ask"], steal: "Open with the reader's own habit.", avoid: "The clinic statistics." };

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
  await check("one workspace never sees another's runs or notes", async () => {
    await login(USERS.clientA);
    const theirs = jobOf(await run("score_hook", { hook: "Clinic owners: your phone is ringing" }));
    const url = "https://example.com/shared-article";
    const web = fakeWeb({ [url]: { status: 200, body: ARTICLE_HTML("shared") } });
    const theirNote = jobOf(await run("learn_from_link", { url }, deps(fakeAi(JSON.stringify(ANALYSIS)).deps, web.fetchPage)));
    assert.equal(theirNote.status, "done");
    await login(USERS.cc);
    const list = await answerOf(await handleToolJobs(jobsReq("tool=score_hook&limit=20"), deps()));
    assert.ok(!(list.body.jobs as Job[]).some((j) => j.id === theirs.id), "OASIS's list does not hold the client's run");
    const one = await answerOf(await handleToolJobs(jobsReq(`id=${theirs.id}`), deps()));
    assert.deepEqual([one.status, one.body.error], [404, "not_found"]);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM marketing_corpus WHERE source_url = ? AND tenant_id = ?", [url, OASIS])), 0);
    // OASIS learning the same link makes its OWN note, never touching the client's.
    const ours = jobOf(await run("learn_from_link", { url }, deps(fakeAi(JSON.stringify(ANALYSIS)).deps, web.fetchPage)));
    assert.equal(ours.status, "done");
    const tenants = (await db.execute({ sql: "SELECT tenant_id FROM marketing_corpus WHERE source_url = ? ORDER BY tenant_id", args: [url] })).rows.map((r) => r.tenant_id);
    assert.deepEqual(tenants, [CLIENT_A, OASIS].sort());
  });

  await check("outside the gate (a sales rep, signed out): 404 not_found on run and jobs, nothing written", async () => {
    const before = Number(await scalar(db, "SELECT COUNT(*) FROM tool_jobs"));
    for (const who of [USERS.rep, null]) {
      await login(who);
      const r = await answerOf(await handleToolRun(runReq("score_hook", { hook: "x" }), deps()));
      assert.deepEqual([r.status, r.body.error], [404, "not_found"]);
      const l = await answerOf(await handleToolJobs(jobsReq("tool=score_hook"), deps()));
      assert.deepEqual([l.status, l.body.error], [404, "not_found"]);
    }
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM tool_jobs")), before);
    await login(USERS.cc);
  });

  await check("the same click is one run; the same key for another input is refused", async () => {
    const key = randomUUID();
    const a = jobOf(await run("score_hook", { hook: "Stop losing leads after 5pm" }, deps(), key));
    const b = jobOf(await run("score_hook", { hook: "Stop losing leads after 5pm" }, deps(), key));
    assert.equal(a.id, b.id);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM tool_jobs WHERE idempotency_key = ?", [key])), 1);
    const c = await run("score_hook", { hook: "Something else" }, deps(), key);
    assert.deepEqual([c.status, c.body.error], [409, "idempotency_key_reused"]);
    const notUuid = await run("score_hook", { hook: "x" }, deps(), "not-a-uuid");
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

  await check("the catalog: Score always; Repurpose and Learn by the account's state; Download ONLY while a live runner lists it", async () => {
    const { getToolCatalog } = await import("../lib/tools/catalog");
    const now = new Date();
    const keys = (c: Awaited<ReturnType<typeof getToolCatalog>>) => (c.installed ? c.tools.map((t) => `${t.key}:${t.state}`) : ["not installed"]);
    // No runner seen for CLIENT_A, ever: no Download card.
    const client = await getToolCatalog({ tenantId: CLIENT_A }, { db, now, readAccount: async () => null });
    assert.deepEqual(keys(client), ["score_hook:ready", "repurpose_post:needs_ai_account", "learn_from_link:needs_ai_account"]);
    const local = await getToolCatalog({ tenantId: CLIENT_A }, { db, now, readAccount: async () => ({ ...ACCOUNT, provider: "ollama" }) });
    assert.deepEqual(keys(local), ["score_hook:ready", "repurpose_post:needs_ai_account", "learn_from_link:needs_ai_account"], "a local model is no account here");
    const quiet = console.error;
    console.error = () => undefined;
    const broken = await getToolCatalog({ tenantId: CLIENT_A }, { db, now, readAccount: async () => { throw new Error("read failed"); } }).finally(() => {
      console.error = quiet;
    });
    assert.deepEqual(keys(broken), ["score_hook:ready", "repurpose_post:ai_account_unreadable", "learn_from_link:ai_account_unreadable"]);
    // OASIS with a runner seen 4 minutes ago: the Download card, naming the runner.
    await seedRunner(db, later(now, -minutes(4)));
    const live = await getToolCatalog({ tenantId: OASIS }, { db, now, readAccount: async () => ACCOUNT });
    assert.deepEqual(keys(live), ["score_hook:ready", "repurpose_post:ready", "learn_from_link:ready", "video_download:ready"]);
    const dl = live.installed ? live.tools.find((t) => t.key === "video_download") : undefined;
    assert.deepEqual(dl?.runner, { label: "CC's PC", lastSeenMinutes: 4 });
    // Eleven minutes: not live, no card.
    await seedRunner(db, later(now, -minutes(11)));
    const stale = await getToolCatalog({ tenantId: OASIS }, { db, now, readAccount: async () => ACCOUNT });
    assert.ok(!keys(stale).some((k) => k.startsWith("video_download")));
    assert.deepEqual(await getToolCatalog({ tenantId: OASIS }, { db: emptyDatabase(), now, readAccount: async () => ACCOUNT }), { installed: false });
  });

  await check("tables not installed: run and jobs answer 503 not_set_up with the plain line", async () => {
    const empty = emptyDatabase();
    const r = await answerOf(await handleToolRun(runReq("score_hook", { hook: "x" }), deps(undefined, undefined, empty)));
    assert.deepEqual([r.status, r.body.error, r.body.message], [503, "not_set_up", "Tools are not set up yet."]);
    const l = await answerOf(await handleToolJobs(jobsReq("tool=score_hook"), deps(undefined, undefined, empty)));
    assert.deepEqual([l.status, l.body.error], [503, "not_set_up"]);
  });

  finish("tools worker");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
