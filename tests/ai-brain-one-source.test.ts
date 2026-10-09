/**
 * ai-brain-one-source.test.ts - a department reply arrives or says why not, the
 * header tells the truth about the last turn, and ONE place (Settings > AI
 * brain) chooses what powers the departments.
 *
 * WHY (CC, 2026-10-09). OASIS's Chief of Staff answered "yo" with "The reply
 * came back empty. Try again." while its header said "Not working: the AI
 * model was not found" and the usage ledger recorded the turn as "ok" with no
 * output (gemini-3.8-flash, 19.6 s). Gemini 3.x thinks before it answers, by
 * default at a medium level, and its thinking tokens count against
 * maxOutputTokens (Gemini docs, "Thinking"): a reply can spend its whole cap
 * thinking and end MAX_TOKENS with no answer text, billed. The adapter sent no
 * thinking setting, read only part.text and never read finishReason, so the
 * empty stream was a "success". Separately: the header kept a stale failure,
 * AI brain could not show or switch the model in use, its "Test" sent a
 * one-token ping that passes where a department answer fails, a per-agent
 * override table claimed to choose providers, and the Local AI CLIs card's
 * "Active CLI" read as if it chose the department brain.
 *
 * Driven against REAL libSQL (bravo__192 + bravo__204, as Bravo applies them)
 * with only the provider's HTTP stubbed, like tests/ai-usage-ledger.test.ts.
 *
 * Run: node --conditions=react-server --import tsx tests/ai-brain-one-source.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const ROOT = process.cwd();
const dbFile = join(mkdtempSync(join(tmpdir(), "ai-brain-one-source-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;

const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006b";
const USER = "0f000000-0000-4000-8000-000000000001";

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

/** scripts/apply_turso_migration.py split_statements: a trigger body stays one statement. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let depth = 0;
  for (const line of sql.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("--")) continue;
    buf.push(line);
    const upper = stripped.toUpperCase();
    if (/\bBEGIN\b/.test(upper)) depth += 1;
    if (/\bEND\s*;/.test(upper)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        out.push(buf.join("\n").trim().replace(/;$/, "").trim());
        buf = [];
        continue;
      }
    }
    if (depth === 0 && stripped.endsWith(";")) {
      out.push(buf.join("\n").trim().replace(/;$/, "").trim());
      buf = [];
    }
  }
  const tail = buf.join("\n").trim().replace(/;$/, "").trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

// -- provider stub ------------------------------------------------------------
type Sent = { url: string; body: string };
let sent: Sent[] = [];
let script: Array<(s: Sent) => Response | Promise<Response>> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const s = { url: String(input instanceof Request ? input.url : input), body: String(init?.body ?? "") };
  sent.push(s);
  const next = script.shift();
  assert.ok(next, `unscripted network call to ${s.url}`);
  return next(s);
}) as typeof fetch;
function play(...responses: Array<Response | ((s: Sent) => Response | Promise<Response>)>) {
  sent = [];
  script = responses.map((r) => (typeof r === "function" ? r : () => r));
}
const sse = (frames: Array<[string | null, unknown]>) =>
  new Response(frames.map(([e, d]) => `${e ? `event: ${e}\n` : ""}data: ${typeof d === "string" ? d : JSON.stringify(d)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
/** One Gemini stream chunk. */
const gem = (parts: Array<Record<string, unknown>> | null, extra: Record<string, unknown> = {}) => ({
  ...(parts ? { candidates: [{ content: { role: "model", parts }, ...(extra.finishReason ? { finishReason: extra.finishReason } : {}) }] } : {}),
  ...(extra.usageMetadata ? { usageMetadata: extra.usageMetadata } : {}),
  ...(extra.promptFeedback ? { promptFeedback: extra.promptFeedback } : {}),
});

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  for (const f of ["bravo__192_ai_usage.sql", "bravo__204_model_prices_current.sql"]) {
    for (const s of splitStatements(readFileSync(join(ROOT, "database", "turso", f), "utf8"))) await db.execute(s);
  }

  const usage = await import("../lib/ai/usage");
  const providers = await import("../lib/providers");
  const outcome = await import("../lib/os/channel/outcome");

  const meter = () =>
    usage.modelCallMeter({ tenantId: CLIENT, surface: "agents.chat", authKind: "api_key", billingMode: "byo_key", userId: USER, departmentKey: "chief_of_staff" });
  async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const ev of gen) out.push(ev);
    return out;
  }
  const chat = (provider: import("../lib/providers").Provider, model: string, maxTokens = 4096) =>
    drain(providers.streamChat({ provider, model, apiKey: "k", system: "You are the Chief of Staff.", messages: [{ role: "user", content: "yo" }], maxTokens, meter: meter() }));
  type Row = Record<string, unknown>;
  const allRows = async (): Promise<Row[]> => (await db.execute("SELECT * FROM ai_usage_events ORDER BY id")).rows as unknown as Row[];
  const newRows = async (mark: number) => (await allRows()).slice(mark);
  const total = async () => (await allRows()).length;

  // -- 1. A department reply arrives, or fails with its real reason -----------
  console.log("1. replies arrive");
  await check("Gemini 3.x is asked to think LOW, with the answer's budget plus thinking headroom", async () => {
    play(sse([[null, gem([{ text: "Hey! What can I do for you?" }], { finishReason: "STOP", usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 9, thoughtsTokenCount: 120 } })]]));
    const events = await chat("google", "gemini-3.8-flash");
    assert.deepEqual(events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text), ["Hey! What can I do for you?"]);
    assert.equal(events.at(-1)?.type, "done");
    const body = JSON.parse(sent[0].body) as { generationConfig: Record<string, unknown> };
    assert.deepEqual(body.generationConfig, { maxOutputTokens: 4096 + providers.THINKING_HEADROOM_TOKENS, thinkingConfig: { thinkingLevel: "low" } });
    assert.equal(providers.THINKING_HEADROOM_TOKENS, 4096);
    // Only Gemini 3.x takes thinkingLevel (2.5 takes a thinkingBudget: a level is a 400).
    assert.equal(providers.geminiTakesThinkingLevel("gemini-3.8-flash"), true);
    assert.equal(providers.geminiTakesThinkingLevel("gemini-3.1-pro-preview"), true);
    assert.equal(providers.geminiTakesThinkingLevel("gemini-3-flash-preview"), true);
    assert.equal(providers.geminiTakesThinkingLevel("gemini-2.5-flash"), false);
    assert.equal(providers.geminiTakesThinkingLevel("gemini-30"), false);
  });

  await check("the 10-09 Chief of Staff turn: all thinking, MAX_TOKENS, no text -> a FAILED turn with its reason; the ledger records the billed thinking as an error, never 'ok'", async () => {
    const mark = await total();
    // What Google sends when the cap is spent thinking: a thought signature,
    // no answer text, finishReason MAX_TOKENS, and usage with NO
    // candidatesTokenCount (zero answer tokens), only thoughtsTokenCount.
    play(
      sse([
        [null, gem([{ text: "", thoughtSignature: "c2ln" }], { usageMetadata: { promptTokenCount: 2100, thoughtsTokenCount: 8100, totalTokenCount: 10200 } })],
        [null, gem([{ text: "" }], { finishReason: "MAX_TOKENS", usageMetadata: { promptTokenCount: 2100, thoughtsTokenCount: 8192, totalTokenCount: 10292 } })],
      ]),
    );
    const events = await chat("google", "gemini-3.8-flash");
    assert.deepEqual(events, [{ type: "error", message: "empty_reply:thinking" }], "an empty stream must not end in done");
    const r = await newRows(mark);
    assert.equal(r.length, 1, "exactly one ledger row");
    assert.equal(r[0].outcome, "error");
    assert.equal(r[0].error_code, "empty_reply_thinking");
    assert.deepEqual([Number(r[0].input_tokens), Number(r[0].output_tokens)], [2100, 8192], "the thinking Google billed is recorded");
    assert.ok(r[0].cost_micro_usd !== null && Number(r[0].cost_micro_usd) > 0, "a billed empty turn has a cost");
    assert.equal(outcome.classifyStreamError("empty_reply:thinking"), "reply_empty_thinking");
    const copy = outcome.failureCopy("reply_empty_thinking", { canManageAi: true });
    assert.equal(copy.sentence, "The AI model used its whole answer budget thinking and sent no answer. Try again, or pick a faster model in AI settings.");
    assert.equal(copy.short, "the AI model used its answer budget thinking");
  });

  await check("a thought part is never answer text; the answer after it is", async () => {
    play(
      sse([
        [null, gem([{ text: "**Considering the greeting** The user said yo.", thought: true }])],
        [null, gem([{ text: "Yo! Ready when you are." }], { finishReason: "STOP", usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 6, thoughtsTokenCount: 40 } })],
      ]),
    );
    const events = await chat("google", "gemini-3.8-flash");
    assert.deepEqual(events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text), ["Yo! Ready when you are."]);
  });

  await check("only a thought part and nothing else is an empty reply, not an answer", async () => {
    play(sse([[null, gem([{ text: "thinking about it", thought: true }], { finishReason: "STOP", usageMetadata: { promptTokenCount: 50, thoughtsTokenCount: 40 } })]]));
    assert.deepEqual(await chat("google", "gemini-3.8-flash"), [{ type: "error", message: "empty_reply:empty" }]);
  });

  await check("a safety stop, or a blocked prompt, with no text is 'blocked', in plain words", async () => {
    play(sse([[null, gem([], { finishReason: "SAFETY", usageMetadata: { promptTokenCount: 50 } })]]));
    assert.deepEqual(await chat("google", "gemini-3.8-flash"), [{ type: "error", message: "empty_reply:blocked" }]);
    play(sse([[null, gem(null, { promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, usageMetadata: { promptTokenCount: 50 } })]]));
    assert.deepEqual(await chat("google", "gemini-3.8-flash"), [{ type: "error", message: "empty_reply:blocked" }]);
    assert.equal(outcome.classifyStreamError("empty_reply:blocked"), "reply_blocked");
    assert.equal(outcome.failureCopy("reply_blocked", { canManageAi: false }).sentence, "The AI provider's safety filter blocked this reply. Rephrase the message and try again.");
  });

  await check("a whitespace-only reply is empty too", async () => {
    play(sse([[null, gem([{ text: "  \n" }], { finishReason: "STOP", usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } })]]));
    assert.deepEqual((await chat("google", "gemini-3.8-flash")).at(-1), { type: "error", message: "empty_reply:empty" });
    assert.equal(outcome.classifyStreamError("empty_reply:empty"), "reply_empty");
  });

  await check("Claude and OpenAI: an empty reply fails the same way, with their own stop words", async () => {
    play(
      sse([
        ["message_start", { message: { usage: { input_tokens: 10, output_tokens: 1 } } }],
        ["message_delta", { delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 4096 } }],
        ["message_stop", {}],
      ]),
    );
    assert.deepEqual(await chat("anthropic", "claude-sonnet-5-5"), [{ type: "error", message: "empty_reply:thinking" }]);
    play(
      sse([
        ["message_start", { message: { usage: { input_tokens: 10, output_tokens: 1 } } }],
        ["message_delta", { delta: { stop_reason: "refusal" }, usage: { output_tokens: 3 } }],
        ["message_stop", {}],
      ]),
    );
    assert.deepEqual(await chat("anthropic", "claude-sonnet-5-5"), [{ type: "error", message: "empty_reply:blocked" }]);
    play(sse([[null, { choices: [{ delta: {}, finish_reason: "length" }] }], [null, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 8192 } }], [null, "[DONE]"]]));
    assert.deepEqual(await chat("openai", "gpt-5.6-terra"), [{ type: "error", message: "empty_reply:thinking" }]);
    // GPT-5.x reasons before it answers, counted in max_completion_tokens: the headroom is added.
    assert.equal((JSON.parse(sent[0].body) as { max_completion_tokens: number }).max_completion_tokens, 4096 + providers.THINKING_HEADROOM_TOKENS);
    play(sse([[null, { choices: [{ delta: {}, finish_reason: "content_filter" }] }], [null, "[DONE]"]]));
    assert.deepEqual(await chat("openrouter", "anthropic/claude-sonnet-5.5"), [{ type: "error", message: "empty_reply:blocked" }]);
    // A normal Claude reply is unchanged.
    play(
      sse([
        ["message_start", { message: { usage: { input_tokens: 10, output_tokens: 1 } } }],
        ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hi." } }],
        ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
        ["message_stop", {}],
      ]),
    );
    assert.deepEqual((await chat("anthropic", "claude-sonnet-5-5")).map((e) => e.type), ["delta", "done"]);
  });

  await check("the department turn (Slack draft path) reads an empty reply as its real reason, not 'stopped partway'", async () => {
    const { runAgentTurnToText } = await import("../lib/os/department-agent");
    const turn = { tenantId: CLIENT, agentSlug: "bravo" } as unknown as import("../lib/os/department-agent").PreparedTurn;
    const stream = async function* () {
      yield { type: "error" as const, message: "empty_reply:thinking" };
    };
    assert.deepEqual(await runAgentTurnToText(turn, [{ role: "user", content: "yo" }], 1024, stream as never), { ok: false, code: "reply_empty_thinking" });
  });

  await check("the web channel sends the department budget from ONE constant", () => {
    const route = readFileSync(join(ROOT, "app/api/agents/chat/route.ts"), "utf8");
    assert.match(route, /streamAgentTurn\(t, incoming, DEPARTMENT_REPLY_MAX_TOKENS\)/);
    const agent = readFileSync(join(ROOT, "lib/os/department-agent.ts"), "utf8");
    assert.match(agent, /maxTokens = DEPARTMENT_REPLY_MAX_TOKENS/);
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
