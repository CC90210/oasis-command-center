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
/** A Gemini chunk (candidates / usageMetadata / promptFeedback): Google frames its SSE with CRLF, so the stub does too. */
const isGeminiChunk = (d: unknown) => !!d && typeof d === "object" && ("candidates" in d || "usageMetadata" in d || "promptFeedback" in d);
const sse = (frames: Array<[string | null, unknown]>) =>
  new Response(
    frames
      .map(([e, d]) => {
        const nl = isGeminiChunk(d) ? "\r\n" : "\n";
        return `${e ? `event: ${e}${nl}` : ""}data: ${typeof d === "string" ? d : JSON.stringify(d)}${nl}${nl}`;
      })
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
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
    // Only reasoning models get the headroom: a non-reasoning model reserves no budget it never uses.
    assert.equal(providers.openaiReasons("gpt-5.6-terra"), true);
    assert.equal(providers.openaiReasons("gpt-6-luna"), true);
    assert.equal(providers.openaiReasons("o4-mini"), true);
    assert.equal(providers.openaiReasons("gpt-4-turbo"), false);
    assert.equal(providers.openaiReasons("gpt-3.5-turbo"), false);
    assert.equal(providers.openaiReasons("gpt-5.1"), false, "gpt-5.1 defaults to no reasoning");
    play(sse([[null, { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }], [null, "[DONE]"]]));
    await chat("openai", "gpt-4-turbo");
    assert.equal((JSON.parse(sent[0].body) as { max_completion_tokens: number }).max_completion_tokens, 4096);
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

  // -- 2. The header shows the truth about the latest real turn ---------------
  console.log("2. the header tells the truth");
  const t = (channelKey: string, ok: boolean, code: string | null, at: string) => ({ channelKey, ok, code, at });
  // OASIS's agent_turn_outcomes on 2026-10-09 (read-only query): the old
  // gemini-2.5-pro 404s, then Chief of Staff's turn on gemini-3.8-flash.
  const oasis = [
    t("dept:chief_of_staff", true, null, "2026-10-09T07:24:00.868Z"),
    t("dept:finance", false, "provider_404", "2026-10-06T18:17:52.561Z"),
    t("dept:client_success", false, "provider_404", "2026-10-06T05:11:09.820Z"),
    t("dept:marketing", false, "provider_404", "2026-10-03T01:20:21.162Z"),
    t("dept:sales", false, "provider_404", "2026-10-03T01:19:51.843Z"),
  ];
  await check("a success on the account's one model clears every channel's old 'model not found'", () => {
    for (const k of ["dept:chief_of_staff", "dept:finance", "dept:client_success", "dept:marketing", "dept:sales"]) {
      assert.equal(outcome.channelFailure(oasis, k), null, `${k} still shows a stale failure`);
    }
  });
  await check("a failure recorded before the AI account last changed is about the old account: never shown", () => {
    const only404s = oasis.slice(1);
    // The account (OASIS's row) changed 2026-10-08 19:13 UTC: the 404s are older.
    for (const k of ["dept:finance", "dept:sales", "dept:chief_of_staff"]) {
      assert.equal(outcome.channelFailure(only404s, k, "2026-10-08T19:13:53.729Z"), null, k);
    }
    // Without that fact, they still count (nothing is hidden on a guess).
    assert.deepEqual(outcome.channelFailure(only404s, "dept:finance"), { code: "provider_404" });
    // A failure AFTER the change is real.
    const after = [...only404s, t("dept:finance", false, "reply_empty_thinking", "2026-10-09T08:00:00Z")];
    assert.deepEqual(outcome.channelFailure(after, "dept:finance", "2026-10-08T19:13:53.729Z"), { code: "reply_empty_thinking" });
    // An account-wide refusal after the change speaks for every channel.
    const drained = [...only404s, t("dept:sales", false, "provider_402", "2026-10-09T08:00:00Z")];
    assert.deepEqual(outcome.channelFailure(drained, "dept:finance", "2026-10-08T19:13:53.729Z"), { code: "provider_402" });
  });
  await check("the header redraws from the turn the page just finished: a reply clears 'Not working', a failure says why", async () => {
    const pill = await import("../components/os/department/StatusPill");
    const ev = await import("../components/os/department/turn-event");
    assert.deepEqual(pill.headerAfterTurn({ kind: "working" }, true, { ok: true }), { kind: "working" });
    assert.deepEqual(pill.headerAfterTurn({ kind: "working" }, true, { ok: false, code: "reply_empty_thinking" }), {
      kind: "not_working",
      reason: "the AI model used its answer budget thinking",
    });
    assert.deepEqual(pill.headerAfterTurn({ kind: "needs_you", count: 2, capped: false }, true, { ok: true }), { kind: "needs_you", count: 2, capped: false });
    assert.deepEqual(pill.headerAfterTurn({ kind: "not_connected" }, false, { ok: false, code: "provider_401" }), { kind: "not_connected" });
    // The event carries exactly a department's turn.
    const mk = (detail: unknown) => Object.assign(new Event(ev.CHANNEL_TURN_EVENT), { detail });
    assert.deepEqual(ev.turnFromEvent(mk({ department: "chief_of_staff", ok: true })), { department: "chief_of_staff", ok: true });
    assert.deepEqual(ev.turnFromEvent(mk({ department: "sales", ok: false, code: "provider_402" })), { department: "sales", ok: false, code: "provider_402" });
    assert.equal(ev.turnFromEvent(mk({ department: "sales", ok: false })), null);
    assert.equal(ev.turnFromEvent(mk(null)), null);
  });
  await check("the department header is the live pill, and the channel announces every finished turn to it", () => {
    const tab = readFileSync(join(ROOT, "components/os/department/DepartmentTab.tsx"), "utf8");
    assert.match(tab, /actions=\{<LiveStatusPill department=\{dept\.key\} status=\{status\} channelReady=\{ready\} initial=\{header\} \/>\}/);
    const live = readFileSync(join(ROOT, "components/os/department/LiveStatusPill.tsx"), "utf8");
    assert.match(live, /window\.addEventListener\(CHANNEL_TURN_EVENT, onTurn\)/);
    assert.match(live, /turn\.department === department\) setHeader\(headerAfterTurn\(status, channelReady, turn\)\)/);
    const chat = readFileSync(join(ROOT, "components/agents/AgentChat.tsx"), "utf8");
    assert.match(chat, /if \(streamFailure\) announceTurn\(\{ department, ok: false, code: streamFailure \}\);\s*else if \(assistantText\.trim\(\)\) announceTurn\(\{ department, ok: true \}\);/);
    // The server's own read retires failures older than the account's last change.
    const channel = readFileSync(join(ROOT, "components/os/department/channel.ts"), "utf8");
    assert.match(channel, /lastTurn: lastTurnFrom\(turns, dept\.key, accountChangedAt\)/);
    const roster = readFileSync(join(ROOT, "components/os/aiteam/roster.ts"), "utf8");
    assert.match(roster, /lastTurnOn\(turns, k, readiness\.accountChangedAt\)/);
  });

  // -- 3. AI brain is the one place that decides what powers the departments ---
  console.log("3. one source for the department brain");
  const brainMod = await import("../lib/ai/department-brain");
  await check("the department brain is the account's provider and the model its requests send, in one set of words", () => {
    const b = brainMod.departmentBrain({ provider: "google", model: "gemini-3.8-flash" });
    assert.deepEqual(b, { provider: "google", providerLabel: "Google Gemini", model: "gemini-3.8-flash", modelLabel: "Gemini 3.8 Flash", savedModel: null });
    assert.equal(brainMod.brainLine(b!), "Google Gemini, Gemini 3.8 Flash");
    // A saved model the registry knows is gone: the words name what is really sent.
    const gone = brainMod.departmentBrain({ provider: "google", model: "gemini-2.5-pro" });
    assert.deepEqual([gone?.model, gone?.modelLabel, gone?.savedModel], ["gemini-3.8-flash", "Gemini 3.8 Flash", "gemini-2.5-pro"]);
    assert.equal(brainMod.departmentBrain(null), null);
    assert.equal(brainMod.departmentBrain({ provider: "nope", model: "x" }), null);
  });
  await check("every reader names and sends the SAME brain: the department turn, its header, and AI brain", () => {
    const agent = readFileSync(join(ROOT, "lib/os/department-agent.ts"), "utf8");
    // The account's model, and nothing else, chooses the department model.
    assert.match(agent, /provider = cfg\.provider;\s*model = cfg\.model;/);
    assert.doesNotMatch(agent, /binding\?\.model_override \|\|/, "a manifest model_override chooses a department model again");
    const channel = readFileSync(join(ROOT, "components/os/department/channel.ts"), "utf8");
    assert.match(channel, /return \{ readiness: "ready", brain: departmentBrain\(account\), accountChangedAt: changedAt \};/);
    assert.match(channel, /brain: owner \? brain : null,/);
    const deptChannel = readFileSync(join(ROOT, "components/os/department/DepartmentChannel.tsx"), "utf8");
    assert.match(deptChannel, /poweredBy=\{state\.canManageAi && state\.brain \? brainLine\(state\.brain\) : null\}/);
    const settings = readFileSync(join(ROOT, "components/settings/SettingsContent.tsx"), "utf8");
    assert.match(settings, /readWorkspaceAiAccount\(profile\.tenant_id\)\.then\(\(a\) => \(hasUsableKey\(a\) \? departmentBrain\(a\) : null\)\)/);
    assert.match(settings, /brain=\{aiBrain\}/);
    const card = readFileSync(join(ROOT, "components/settings/ProviderAccountsCard.tsx"), "utf8");
    assert.match(card, /Your departments use <span className="font-bold">\{brainLine\(brain\)\}<\/span>\./);
    // A change from anywhere restarts the picker on the model really saved.
    assert.match(card, /key=\{`\$\{brain\.provider\}:\$\{brain\.savedModel \?\? brain\.model\}`\}/);
    // The local CLI choice is not read by anything that powers a department.
    for (const rel of ["lib/os/department-agent.ts", "components/os/department/channel.ts", "lib/providers.ts", "app/api/agents/chat/route.ts", "lib/ai/department-brain.ts"]) {
      assert.doesNotMatch(readFileSync(join(ROOT, rel), "utf8"), /cli-runtime|readCliRuntime|cliRuntime/, `${rel} reads the local CLI choice`);
    }
  });

  const probe = await import("../lib/agents/provider-probe");
  const budget = await import("../lib/os/channel/reply-budget");
  const probeMeter = () => usage.modelCallMeter({ tenantId: CLIENT, surface: "probe", authKind: "api_key", billingMode: "byo_key", userId: USER });
  await check("Test asks for a real, department-sized answer on the department budget, not a one-token ping", async () => {
    play(sse([[null, gem([{ text: "I can keep your week on track. Start with the overdue follow-ups." }], { finishReason: "STOP", usageMetadata: { promptTokenCount: 420, candidatesTokenCount: 18, thoughtsTokenCount: 60 } })]]));
    const r = await probe.probeDepartmentAnswer("google", "AIza-k", { model: "gemini-3.8-flash", meter: probeMeter() });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.ok && r.model, "gemini-3.8-flash");
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /models\/gemini-3\.8-flash:streamGenerateContent/);
    const body = JSON.parse(sent[0].body) as { contents: Array<{ parts: Array<{ text: string }> }>; systemInstruction: { parts: Array<{ text: string }> }; generationConfig: Record<string, unknown> };
    assert.equal(body.systemInstruction.parts[0].text, budget.DEPARTMENT_TEST_SYSTEM);
    assert.ok(budget.DEPARTMENT_TEST_SYSTEM.length > 1000, "the Test prompt is not department-sized");
    assert.equal(body.contents[0].parts[0].text, budget.DEPARTMENT_TEST_ASK);
    assert.deepEqual(body.generationConfig, { maxOutputTokens: budget.DEPARTMENT_REPLY_MAX_TOKENS + providers.THINKING_HEADROOM_TOKENS, thinkingConfig: { thinkingLevel: "low" } });
    assert.equal(budget.DEPARTMENT_REPLY_MAX_TOKENS, 4096);
  });
  await check("Test FAILS where the departments fail: an answer spent thinking is red, in the channel's own words", async () => {
    play(sse([[null, gem([{ text: "" }], { finishReason: "MAX_TOKENS", usageMetadata: { promptTokenCount: 420, thoughtsTokenCount: 8192 } })]]));
    const r = await probe.probeDepartmentAnswer("google", "AIza-k", { model: "gemini-3.8-flash", meter: probeMeter() });
    assert.deepEqual(r, {
      ok: false,
      code: "reply_empty_thinking",
      message: "The AI model used its whole answer budget thinking and sent no answer. Try again, or pick a faster model in AI settings.",
    });
    // A model the provider does not know is named, as the channel names it.
    play(new Response('{"error":{"code":404,"message":"models/gemini-9 is not found"}}', { status: 404 }));
    const nf = await probe.probeDepartmentAnswer("google", "AIza-k", { model: "gemini-3.8-flash", meter: probeMeter() });
    assert.equal(nf.ok === false && nf.code, "provider_404");
    assert.match(nf.ok === false ? nf.message : "", /^The AI model Gemini 3\.8 Flash \(gemini-3\.8-flash\) was not found/);
    // A stream that never answers is a timeout, not a hang.
    const never = async function* () {
      await new Promise(() => undefined);
      yield { type: "done" as const, inputTokens: 0, outputTokens: 0 };
    };
    const slow = await probe.probeDepartmentAnswer("anthropic", "k", { model: "claude-sonnet-5-5", meter: probeMeter(), stream: never as never, timeoutMs: 30 });
    assert.equal(slow.ok === false && slow.code, "timeout");
  });
  await check("the saved account's Test button runs that department answer", () => {
    const route = readFileSync(join(ROOT, "app/api/agent-config/test-connection/route.ts"), "utf8");
    assert.match(route, /await probeDepartmentAnswer\(provider, plain, \{ model: row\?\.model, meter: probeMeter\(provider, ctx\.tenantId, ctx\.userId\) \}\)/);
  });

  // The model switch, against real libSQL.
  await db.executeMultiple(`
    CREATE TABLE agent_model_config (id TEXT, tenant_id TEXT NOT NULL, user_id TEXT, agent_key TEXT NOT NULL, provider TEXT, model TEXT,
      encrypted_api_key TEXT, enabled INTEGER NOT NULL DEFAULT 1, system_prompt_override TEXT, display_name_override TEXT, updated_at TEXT);
  `);
  const account = await import("../lib/ai/workspace-account");
  const seed = async (rows: Array<[string, string | null, string, string, string, string | null]>) => {
    await db.execute({ sql: "DELETE FROM agent_model_config WHERE tenant_id = ?", args: [CLIENT] });
    for (const [id, user, key, provider, model, cipher] of rows) {
      await db.execute({
        sql: "INSERT INTO agent_model_config (id, tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, '2026-10-01T00:00:00Z')",
        args: [id, CLIENT, user, key, provider, model, cipher],
      });
    }
  };
  const models = async () =>
    (await db.execute({ sql: "SELECT id, model FROM agent_model_config WHERE tenant_id = ? ORDER BY id", args: [CLIENT] })).rows.map((r) => `${r.id}:${r.model}`);
  await check("switching the model moves the account and the team rows on its key in one statement; a teammate's own key and a person's key keep theirs", async () => {
    await seed([
      ["a-account", null, account.WORKSPACE_AI_AGENT_KEY, "google", "gemini-3.5-flash-lite", "C1"],
      ["b-sdr", null, "sdr", "google", "gemini-3.5-flash-lite", "C1"],
      ["c-own", null, "outreach", "google", "gemini-3.5-flash-lite", "C2"],
      ["d-person", USER, "bravo", "google", "gemini-3.5-flash-lite", "C1"],
    ]);
    const read = await account.readWorkspaceAiAccount(CLIENT);
    assert.ok(account.hasUsableKey(read));
    const out = await account.changeWorkspaceModelInOneStep({ tenantId: CLIENT, account: read, model: "gemini-3.8-flash" });
    assert.equal(out.committed, true);
    assert.deepEqual(out.changed.sort(), [account.WORKSPACE_AI_AGENT_KEY, "sdr"]);
    assert.deepEqual(await models(), ["a-account:gemini-3.8-flash", "b-sdr:gemini-3.8-flash", "c-own:gemini-3.5-flash-lite", "d-person:gemini-3.5-flash-lite"]);
    // The account's change time moved: older channel failures now read as stale.
    assert.ok(((await account.readWorkspaceAccountChangedAt(CLIENT)) ?? "") > "2026-10-01T00:00:00Z");
  });
  await check("a switch read before another window reconnected changes nothing", async () => {
    await seed([["a-account", null, account.WORKSPACE_AI_AGENT_KEY, "google", "gemini-3.5-flash-lite", "C1"]]);
    const read = await account.readWorkspaceAiAccount(CLIENT);
    assert.ok(account.hasUsableKey(read));
    await db.execute({ sql: "UPDATE agent_model_config SET encrypted_api_key = 'C9' WHERE tenant_id = ?", args: [CLIENT] });
    const out = await account.changeWorkspaceModelInOneStep({ tenantId: CLIENT, account: read, model: "gemini-3.8-flash" });
    assert.deepEqual(out, { committed: false, changed: [] });
    assert.deepEqual(await models(), ["a-account:gemini-3.5-flash-lite"]);
  });
  await check("a switch read before the account was retired moves no teammate still on the old key", async () => {
    await seed([
      ["a-account", null, account.WORKSPACE_AI_AGENT_KEY, "google", "gemini-3.5-flash-lite", "C1"],
      ["b-sdr", null, "sdr", "google", "gemini-3.5-flash-lite", "C1"],
    ]);
    const read = await account.readWorkspaceAiAccount(CLIENT);
    assert.ok(account.hasUsableKey(read));
    // Another window retires the account (key wiped); the teammate row keeps the old key.
    await db.execute({ sql: "UPDATE agent_model_config SET encrypted_api_key = NULL, enabled = 0 WHERE id = 'a-account'", args: [] });
    const out = await account.changeWorkspaceModelInOneStep({ tenantId: CLIENT, account: read, model: "gemini-3.8-flash" });
    assert.deepEqual(out, { committed: false, changed: [] });
    assert.deepEqual(await models(), ["a-account:gemini-3.5-flash-lite", "b-sdr:gemini-3.5-flash-lite"]);
  });
  await check("OASIS's legacy row is its account: a switch moves it", async () => {
    await seed([["l-bravo", null, account.LEGACY_WORKSPACE_AI_AGENT_KEY, "google", "gemini-3.5-flash-lite", "C3"]]);
    const read = await account.readWorkspaceAiAccount(CLIENT);
    assert.ok(account.hasUsableKey(read) && read.source === "legacy");
    const out = await account.changeWorkspaceModelInOneStep({ tenantId: CLIENT, account: read, model: "gemini-3.8-flash" });
    assert.equal(out.committed, true);
    assert.deepEqual(await models(), ["l-bravo:gemini-3.8-flash"]);
  });
  await check("the switch route tests the new model with a department answer BEFORE it writes, and only owners or admins may switch", () => {
    const route = readFileSync(join(ROOT, "app/api/agent-config/workspace-model/route.ts"), "utf8");
    const tested = route.indexOf("await probeDepartmentAnswer(provider, key, {");
    const written = route.indexOf("await changeWorkspaceModelInOneStep({ tenantId, account, model })");
    assert.ok(tested > 0 && written > tested, "the model is written before (or without) its department-answer test");
    assert.match(route, /if \(!tested\.ok\) \{/);
    assert.match(route, /if \(!\(ctx\.isOwner \|\| canManageTeam\(ctx\.teamRole, ctx\.adminAccess\)\)\) \{/);
    assert.match(route, /const check = saveCheck\(provider, model\);\s*if \(!check\.ok\)/);
  });
  await check("the card's switch posts the model to that route and shows its plain answer", async () => {
    const card = await import("../components/settings/workspace-model-switch");
    const src = readFileSync(join(ROOT, "components/settings/ProviderAccountsCard.tsx"), "utf8");
    assert.match(src, /const r = await switchWorkspaceModel\(model\);/);
    const calls: Array<{ url: string; body: string }> = [];
    const ok = await card.switchWorkspaceModel("gemini-3.1-pro-preview", async (url, init) => {
      calls.push({ url, body: String(init.body) });
      return new Response(JSON.stringify({ ok: true, label: "Gemini 3.1 Pro (preview)" }), { status: 200 });
    });
    assert.deepEqual(ok, { ok: true, label: "Gemini 3.1 Pro (preview)" });
    assert.deepEqual(calls, [{ url: "/api/agent-config/workspace-model", body: JSON.stringify({ model: "gemini-3.1-pro-preview" }) }]);
    const refused = await card.switchWorkspaceModel("x", async () => new Response(JSON.stringify({ ok: false, message: "X did not pass the test, so nothing was changed." }), { status: 422 }));
    assert.deepEqual(refused, { ok: false, message: "X did not pass the test, so nothing was changed." });
    const down = await card.switchWorkspaceModel("x", async () => {
      throw new Error("offline");
    });
    assert.equal(down.ok, false);
  });

  // -- 4. The redundant per-agent override section is gone, and its rows spend nothing
  console.log("4. no per-agent override");
  await check("AI brain no longer mounts 'Override an agent's provider' or links to it", () => {
    const settings = readFileSync(join(ROOT, "components/settings/SettingsContent.tsx"), "utf8");
    assert.doesNotMatch(settings, /<AgentConfigEditor\b/);
    assert.doesNotMatch(settings, /title="Override an agent's provider"/);
    const card = readFileSync(join(ROOT, "components/settings/ProviderAccountsCard.tsx"), "utf8");
    assert.doesNotMatch(card, /href="#agents"|Per-agent/, "the card still points at the removed section");
    assert.doesNotMatch(card, /Override per-agent/);
  });
  await check("a per-agent row's own provider and key route nothing: the operator chat answers on the workspace account", () => {
    const auth = readFileSync(join(ROOT, "lib/chat-auth.ts"), "utf8");
    assert.match(auth, /account = await readWorkspaceAiAccount\(tenantId\);/);
    assert.match(auth, /if \(hasUsableKey\(account\)\) \{/);
    assert.match(auth, /apiKey = decryptField\(account\.encryptedApiKey\);/);
  });

  // -- 5. The local CLI card says exactly what it powers ------------------------
  console.log("5. local CLIs");
  await check("the local CLI card says it answers only the Coding harness on that computer, never the departments", async () => {
    const cli = await import("../components/settings/local-cli-scope");
    assert.match(cli.LOCAL_CLI_SCOPE, /They answer only the Coding harness \(Admin > Coding harness\) when it runs on that computer\. Your departments do not use them/);
    assert.match(cli.LOCAL_CLI_PICKER_SCOPE, /It never changes what your departments use\./);
    // The bridge may run on another computer than this browser (hosted mode): "the paired computer".
    assert.doesNotMatch(cli.LOCAL_CLI_SCOPE + cli.LOCAL_CLI_PICKER_SCOPE, /this computer/);
    const src = readFileSync(join(ROOT, "components/settings/LocalCliProvidersCard.tsx"), "utf8");
    assert.doesNotMatch(src, /Active CLI|title="Local AI CLIs"/, "the card's old wording, which read as choosing the department brain");
    assert.match(src, /subtitle=\{LOCAL_CLI_SCOPE\}/);
    // What the choice really drives: only the operator's Coding harness (ChatWidget) sends it.
    const widget = readFileSync(join(ROOT, "components/ChatWidget.tsx"), "utf8");
    assert.match(widget, /cli_provider: cliRuntime/);
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
