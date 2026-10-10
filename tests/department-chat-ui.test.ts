/**
 * department-chat-ui.test.ts - the department channel's page side: a reply keeps
 * arriving while nothing is on screen, a page that comes back reads it, messages
 * queue, and what is drawn is plain (components/agents/*).
 *
 * WHY (CC, 2026-10-10: send while it works, see how it is thinking, click off
 * and come back, reopen old chats). The server half is tests/department-runs.test.ts.
 * Here:
 *   - the run store (components/agents/run-store.ts) holds the connection and the
 *     conversation OUTSIDE any component: with nothing mounted, frames still
 *     fill the reply, and the next mount reads the finished conversation;
 *   - a conversation reopened with a run still working follows it from the
 *     server, from the last event it has;
 *   - a message sent while one works shows "queued" and its events arrive on the
 *     stream that is already open; Stop on a queued message removes it;
 *   - the pieces draw lookups under plain labels, the reasoning only when the
 *     events carry it, and never a persona name or raw JSON.
 * The store runs on a scripted fetch; the markup is rendered where React is whole.
 *
 * Run: node --conditions=react-server --import tsx tests/department-chat-ui.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => T | null | false | undefined, ms = 4000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

// -- A server you can hold open ---------------------------------------------------
const enc = new TextEncoder();
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

class Pipe {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly body = new ReadableStream<Uint8Array>({ start: (c) => void (this.controller = c) });
  closed = false;
  cancelled = false;
  write(text: string) {
    this.controller.enqueue(enc.encode(text));
  }
  close() {
    this.closed = true;
    this.controller.close();
  }
}

type Call = { url: string; method: string; body: Record<string, unknown> | null };
const calls: Call[] = [];
let handler: (call: Call) => Response | Promise<Response> = () => new Response("{}", { status: 404 });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const call: Call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null };
  calls.push(call);
  return handler(call);
}) as typeof fetch;
const sse = (pipe: Pipe) => new Response(pipe.body, { status: 200, headers: { "content-type": "text/event-stream" } });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const head = (id: string, seq: number, status: string, over: Record<string, unknown> = {}) => ({
  id,
  conversation_id: "c1",
  seq,
  status,
  user_text: `question ${seq}`,
  final_text: null,
  error_code: null,
  source: "worker",
  ...over,
});
const ev = (runId: string, seq: number, kind: string, data: Record<string, unknown>) => frame("ev", { run_id: runId, seq, kind, data });

const realError = console.error;
console.error = () => undefined;

async function main() {
  const store = await import("../components/agents/run-store");
  const { readSse } = await import("../components/agents/sse-client");
  const identity = await import("../lib/os/channel/identity");

  console.log("Reading the wire");
  await check("frames are read across chunk boundaries and CRLF; comments and unreadable frames are skipped", async () => {
    const pipe = new Pipe();
    const got: Array<[string, unknown]> = [];
    const reading = (async () => {
      for await (const f of readSse(pipe.body)) got.push([f.event, f.data]);
    })();
    pipe.write(": ping\n\nevent: ru");
    pipe.write('n\r\ndata: {"id":"r1"}\r\n\r\nevent: ev\ndata: {"seq":');
    pipe.write("2}\n\nevent: bad\ndata: {not json}\n\n");
    pipe.write('event: end\ndata: {"id":"r1"}');
    pipe.close();
    await reading;
    assert.deepEqual(got, [["run", { id: "r1" }], ["ev", { seq: 2 }], ["end", { id: "r1" }]]);
  });

  console.log("The store keeps the run when the page is gone");
  await check("with nothing mounted, frames still fill the reply; the next mount reads the finished conversation", async () => {
    calls.length = 0;
    const pipe = new Pipe();
    handler = (c) => (c.url === "/api/os/runs" ? sse(pipe) : c.url.startsWith("/api/os/conversations?") ? json(200, { conversations: [] }) : json(404, {}));
    const sent = store.sendMessage("sales", { agentSlug: "sdr", text: "How is the pipeline?", chatMode: "build" });
    // Sending shows at once.
    assert.equal(store.getState("sales").items[0].status, "sending");
    assert.equal(store.getState("sales").items[0].userText, "How is the pipeline?");
    pipe.write(frame("conversation", { id: "c1", title: "How is the pipeline?" }));
    pipe.write(frame("run", head("r1", 1, "running", { user_text: "How is the pipeline?" })));
    pipe.write(ev("r1", 1, "agent", { display_name: "Sales", runs_on: "Google Gemini (API)", spend: "api_credits" }));
    pipe.write(ev("r1", 2, "tool", { id: "t1", phase: "start", label: "Looking up Pipeline", ok: null }));
    await until("the lookup to show", () => store.getState("sales").items[0].view.steps.length === 1);
    assert.equal(store.getState("sales").conversationId, "c1", "the new conversation is learned from the stream");
    assert.equal(store.getState("sales").items[0].runId, "r1");
    // ...the person leaves the page: nothing is mounted, nothing aborts. The stream is still read.
    await sleep(30);
    assert.equal(pipe.cancelled, false);
    pipe.write(ev("r1", 3, "tool", { id: "t1", phase: "done", ok: true, detail: "12 leads", size: 900 }));
    pipe.write(ev("r1", 4, "delta", { text: "Twelve " }));
    pipe.write(ev("r1", 5, "delta", { text: "leads." }));
    await until("the text to grow while nothing is on screen", () => store.getState("sales").items[0].view.text === "Twelve leads.");
    pipe.write(ev("r1", 6, "done", { status: "done" }));
    pipe.write(frame("end", head("r1", 1, "done", { user_text: "How is the pipeline?", final_text: "Twelve leads." })));
    pipe.close();
    await sent;
    // ...they come back: the store has the whole conversation.
    const back = store.getState("sales").items[0];
    assert.deepEqual([back.status, back.text, back.via], ["done", "Twelve leads.", "Google Gemini (API) - API credits"]);
    assert.deepEqual(back.view.steps, [{ kind: "tool", id: "t1", label: "Looking up Pipeline", state: "ok", detail: "12 leads", size: 900 }]);
    assert.equal(calls.filter((c) => c.url === "/api/os/runs").length, 1, "one send");
  });
  await check("a chat reopened with a run still working follows it from the last event it has", async () => {
    calls.length = 0;
    store.newChat("sales");
    const live = new Pipe();
    handler = (c) => {
      if (c.url === "/api/os/conversations/c9") {
        return json(200, {
          ok: true,
          conversation: { id: "c9", department: "sales", title: "Old chat" },
          runs: [
            { id: "r1", seq: 1, status: "done", user_text: "first", final_text: "First answer", error_code: null, agent: { runs_on: "Google Gemini (API)", spend: "api_credits" }, events: [{ seq: 1, kind: "tool", data: { id: "t1", phase: "start", label: "Looking up Pipeline", ok: null } }, { seq: 2, kind: "tool", data: { id: "t1", phase: "done", ok: true } }, { seq: 3, kind: "done", data: { status: "done" } }] },
            { id: "r2", seq: 2, status: "running", user_text: "second", final_text: null, error_code: null, agent: null, events: [] },
          ],
        });
      }
      if (c.url.startsWith("/api/os/runs/r2/stream")) return sse(live);
      return c.url.startsWith("/api/os/conversations?") ? json(200, { conversations: [] }) : json(404, {});
    };
    await store.openConversation("sales", "c9");
    const s = store.getState("sales");
    assert.deepEqual(s.items.map((i) => [i.userText, i.status, i.text]), [["first", "done", "First answer"], ["second", "running", ""]]);
    assert.deepEqual(s.items[0].view.steps.map((x) => x.kind === "tool" && x.state), ["ok"], "the finished run reopens with its trail");
    await until("the follower to attach", () => calls.some((c) => c.url === "/api/os/runs/r2/stream?after=0"));
    live.write(frame("run", head("r2", 2, "running", { conversation_id: "c9" })));
    live.write(ev("r2", 1, "delta", { text: "Still " }));
    live.write(ev("r2", 2, "delta", { text: "working." }));
    await until("the reply to arrive", () => store.getState("sales").items[1].text === "Still working.");
    // A repeated event (a window re-ask, a second tab) changes nothing.
    live.write(ev("r2", 2, "delta", { text: "working." }));
    live.write(frame("end", head("r2", 2, "done", { conversation_id: "c9", final_text: "Still working." })));
    live.close();
    await until("the run to end", () => store.getState("sales").items[1].status === "done");
    assert.equal(store.getState("sales").items[1].text, "Still working.");
  });
  await check("a window that closes before the run ends is asked again from the last event seen", async () => {
    calls.length = 0;
    store.newChat("sales");
    const a = new Pipe();
    const b = new Pipe();
    const streams = [a, b];
    handler = (c) => {
      if (c.url === "/api/os/conversations/c8") {
        return json(200, { ok: true, conversation: { id: "c8", title: "t" }, runs: [{ id: "r5", seq: 1, status: "running", user_text: "q", final_text: null, error_code: null, agent: null, events: [] }] });
      }
      if (c.url.startsWith("/api/os/runs/r5/stream")) return sse(streams.shift()!);
      return json(200, { conversations: [] });
    };
    await store.openConversation("sales", "c8");
    await until("first attach", () => calls.some((c) => c.url === "/api/os/runs/r5/stream?after=0"));
    a.write(frame("run", head("r5", 1, "running", { conversation_id: "c8" })));
    a.write(ev("r5", 1, "delta", { text: "Part one. " }));
    a.write(ev("r5", 2, "delta", { text: "Two. " }));
    await until("text", () => store.getState("sales").items[0].text === "Part one. Two. ");
    a.write("event: window\ndata: {}\n\n");
    a.close();
    await until("re-ask from seq 2", () => calls.some((c) => c.url === "/api/os/runs/r5/stream?after=2"));
    b.write(ev("r5", 3, "delta", { text: "Three." }));
    b.write(frame("end", head("r5", 1, "done", { conversation_id: "c8", final_text: "Part one. Two. Three." })));
    b.close();
    await until("done", () => store.getState("sales").items[0].status === "done");
    assert.equal(store.getState("sales").items[0].text, "Part one. Two. Three.");
  });

  console.log("Send while it works");
  await check("a message sent while one works shows as queued and its events arrive on the stream already open; Stop on a queued one removes it", async () => {
    calls.length = 0;
    store.newChat("sales");
    const pipe = new Pipe();
    let nth = 0;
    handler = (c) => {
      if (c.url === "/api/os/runs") {
        nth += 1;
        return nth === 1 ? sse(pipe) : json(202, { ok: true, mode: "queued", conversation_id: "c1", run: head("r2", 2, "queued") });
      }
      if (c.url === "/api/os/runs/r2/stop") return json(200, { ok: true, result: "cancelled" });
      return c.url.startsWith("/api/os/conversations?") ? json(200, { conversations: [] }) : json(404, {});
    };
    const first = store.sendMessage("sales", { agentSlug: "sdr", text: "one", chatMode: "build" });
    pipe.write(frame("conversation", { id: "c1", title: "one" }));
    pipe.write(frame("run", head("r1", 1, "running", { user_text: "one" })));
    pipe.write(ev("r1", 1, "delta", { text: "Working on one." }));
    await until("the first reply", () => store.getState("sales").items[0]?.text === "Working on one.");
    // The composer is not disabled while it works: a second message is sent.
    await store.sendMessage("sales", { agentSlug: "sdr", text: "two", chatMode: "build" });
    const s = store.getState("sales");
    assert.deepEqual(s.items.map((i) => [i.userText, i.status]), [["one", "running"], ["two", "queued"]]);
    assert.equal(calls.filter((c) => c.url === "/api/os/runs").length, 2);
    assert.equal(calls.filter((c) => c.url.startsWith("/api/os/runs/r2/stream")).length, 0, "the open stream carries the queue: no second connection");
    assert.equal(calls.find((c) => c.url === "/api/os/runs" && c.body?.text === "two")?.body?.conversation_id, "c1", "it joins the same conversation");
    // The open stream moves on to the queued run when the first ends.
    pipe.write(ev("r1", 2, "done", { status: "done" }));
    pipe.write(frame("end", head("r1", 1, "done", { user_text: "one", final_text: "Working on one." })));
    pipe.write(frame("run", head("r2", 2, "running", { user_text: "two" })));
    pipe.write(ev("r2", 1, "delta", { text: "Now two." }));
    await until("the queued reply", () => store.getState("sales").items[1].text === "Now two.");
    assert.equal(store.getState("sales").items[1].status, "running");
    pipe.write(frame("end", head("r2", 2, "done", { user_text: "two", final_text: "Now two." })));
    pipe.close();
    await first;
    // Stop on a queued message: removed on the spot.
    calls.length = 0;
    handler = (c) => (c.url === "/api/os/runs" ? json(202, { ok: true, mode: "queued", conversation_id: "c1", run: head("r3", 3, "queued") }) : c.url === "/api/os/runs/r3/stop" ? json(200, { ok: true, result: "cancelled" }) : json(404, {}));
    await store.sendMessage("sales", { agentSlug: "sdr", text: "three", chatMode: "plan" });
    assert.equal(calls[0].body?.chat_mode, "plan");
    await store.stopRun("sales", "r3");
    assert.equal(store.getState("sales").items.find((i) => i.runId === "r3")?.status, "cancelled");
  });
  await check("a refused or failed send is shown on its message in one code, never as raw text, and a full queue is its own sentence", async () => {
    store.newChat("sales");
    handler = () => json(429, { ok: false, error: "queue_full" });
    await store.sendMessage("sales", { agentSlug: "sdr", text: "x", chatMode: "build" });
    assert.deepEqual(store.getState("sales").items[0].failure, { code: "queue_full", model: null });
    store.newChat("sales");
    handler = () => json(503, { ok: false, error: "chat_history_unavailable" });
    await store.sendMessage("sales", { agentSlug: "sdr", text: "x", chatMode: "build" });
    assert.equal(store.getState("sales").notice, "chat_history_unavailable");
    store.newChat("sales");
    handler = () => {
      throw new Error("offline");
    };
    await store.sendMessage("sales", { agentSlug: "sdr", text: "x", chatMode: "build" });
    assert.equal(store.getState("sales").items[0].failure?.code, "network");
  });
  await check("the department header is told how a run ended, as before: a reply clears a failure, a failure says why", async () => {
    const seen: unknown[] = [];
    (globalThis as unknown as { window: unknown }).window = {
      dispatchEvent: (e: { detail: unknown }) => void seen.push(e.detail),
      sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    };
    (globalThis as unknown as { CustomEvent: unknown }).CustomEvent = class {
      detail: unknown;
      constructor(public type: string, init: { detail: unknown }) {
        this.detail = init.detail;
      }
    };
    store.newChat("ops");
    for (const [status, code, text] of [["done", null, "All good."], ["failed", "provider_401", ""]] as const) {
      const pipe = new Pipe();
      handler = (c) => (c.url === "/api/os/runs" ? sse(pipe) : json(200, { conversations: [] }));
      store.newChat("ops");
      const sent = store.sendMessage("ops", { agentSlug: "ops", text: "hi", chatMode: "build" });
      pipe.write(frame("conversation", { id: "o1", title: "hi" }));
      pipe.write(frame("run", head("o9", 1, "running", { conversation_id: "o1" })));
      if (text) pipe.write(ev("o9", 1, "delta", { text }));
      pipe.write(frame("end", head("o9", 1, status, { conversation_id: "o1", final_text: text || null, error_code: code })));
      pipe.close();
      await sent;
    }
    delete (globalThis as unknown as { window?: unknown }).window;
    assert.deepEqual(seen, [{ department: "ops", ok: true }, { department: "ops", ok: false, code: "provider_401" }]);
  });

  console.log("What is drawn");
  const nodeOptions = (process.env.NODE_OPTIONS || "")
    .split(/\s+/)
    .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
    .join(" ");
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: nodeOptions };
  if (!nodeOptions) delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/department-chat-ui.render.ts"], { encoding: "utf8", env, timeout: 120_000 });
  const html = r.status === 0 ? (JSON.parse(r.stdout.trim().split("\n").pop() || "{}") as Record<string, string>) : ({} as Record<string, string>);
  const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  await check("the pieces render (the render process ran)", () => {
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.ok(Object.keys(html).length >= 14);
  });
  await check("the trail while it works: each lookup under its label with its result and size, the current step spinning, open", () => {
    assert.match(html.trailWorking, /<details[^>]* open/);
    assert.match(text(html.trailWorking), /Looked up Pipeline - 12 leads \(4\.1k characters\)/);
    assert.match(text(html.trailWorking), /Looking up Calendar/);
    assert.match(html.trailWorking, /animate-spin/);
    assert.match(text(html.trailWorking), /Looking up Calendar/, "the header names the current step");
    assert.match(text(html.trailStarting), /Thinking it through/, "before any step, it still says it is working");
    assert.equal(text(html.trailNothing), "", "a finished run with no steps draws no trail");
  });
  await check("the reasoning shows when the events carry it (gated server-side: only owners, admins and the operator get it)", () => {
    assert.match(text(html.trailReasoning), /Thinking Checking the pipeline first\./);
  });
  await check("once the reply is written the trail folds to one line, and a failed step says so", () => {
    assert.doesNotMatch(html.trailFinished, /<details[^>]* open/);
    assert.match(text(html.trailFinished), /Looked up Pipeline, Looked up Calendar/);
    assert.match(text(html.trailFinished), /Looked up Calendar \(did not work\)/);
  });
  await check("a message waiting its turn says Queued and can be removed; Sending is its own state; neither shows a reply", () => {
    assert.match(text(html.msgQueued), /How is the pipeline\? Queued - goes next/);
    assert.match(html.msgQueued, /aria-label="Remove this queued message"/);
    assert.doesNotMatch(html.msgQueued, /data-testid="activity-trail"/);
    assert.match(text(html.msgSending), /Sending/);
  });
  await check("a working reply shows its words so far above... and a finished one shows its answer with its 'via' line under the bubble", () => {
    assert.match(text(html.msgRunning), /Twelve leads so far/);
    assert.match(html.msgRunning, /animate-spin/);
    assert.match(text(html.msgDone), /Twelve leads\. Two need a call\./);
    assert.match(html.msgDone, /<div class="px-1 text-\[11px\] leading-snug text-fg-dim">via Google Gemini \(API\) - uses API credits<\/div>/);
  });
  await check("failures are one plain sentence: a refused key, an interrupted reply (partial kept), a stop (partial kept)", () => {
    assert.match(text(html.msgFailed), /Partial\./);
    assert.match(text(html.msgFailed), /refused|key|Settings/i);
    assert.doesNotMatch(html.msgFailed, /provider_401/, "a code reached the screen");
    assert.match(text(html.msgInterrupted), /Half an ans/);
    assert.match(text(html.msgInterrupted), /This reply was interrupted before it finished\. Send it again to retry\./);
    assert.match(text(html.msgCancelled), /Starting\./);
    assert.match(text(html.msgCancelled), /Stopped\. This is as far as it got\./);
  });
  await check("past chats: the current one marked, a working one says Working, rename and delete are there, an empty list explains itself", () => {
    assert.match(html.rail, /aria-current="true"/);
    assert.match(text(html.rail), /Pipeline check Working/);
    assert.match(text(html.rail), /Follow-ups \w{3} \d{1,2}/);
    assert.match(html.rail, /aria-label="Rename Pipeline check"/);
    assert.match(html.rail, /aria-label="Delete Follow-ups"/);
    assert.match(text(html.rail), /New chat/);
    assert.match(text(html.railEmpty), /Chats you start here are saved\. Come back to any of them later\./);
  });
  await check("the channel: the shared header (what powers it), a composer that is never disabled, Past chats on a phone and a rail on a laptop", () => {
    assert.match(html.channel, /<a (?=[^>]*data-testid="channel-engine")(?=[^>]*href="\/settings\/ai#engine")[^>]*>/);
    assert.match(text(html.channel), /Ask Sales anything\./);
    const area = /<textarea[^>]*>/.exec(html.channel)?.[0] ?? "";
    assert.ok(area && !/disabled/.test(area), "the composer is disabled");
    assert.match(html.channel, /aria-label="Past chats"/);
    assert.match(html.channel, /class="hidden w-60 shrink-0 flex-col border-r border-bg-border md:flex"/, "the rail is a laptop column");
    assert.match(text(html.channel), /Past chats/);
    assert.match(text(html.channel), /Enter to send, Shift\+Enter for a new line/);
  });
  await check("nothing a client reads names a house agent or carries a raw provider field", () => {
    const everything = Object.values(html).join("\n");
    assert.ok(!identity.namesPersona(text(everything)), `a persona name reached the page: ${text(everything).match(identity.PERSONA_NAME_PATTERN)?.[0]}`);
    assert.doesNotMatch(everything, /tool_use|raw_name|anthropic_\d|"phase"|summary"/);
    // The source's own copy too, as the channel's other scans do.
    const literals = ["DepartmentChat.tsx", "ActivityTrail.tsx", "ConversationRail.tsx", "run-store.ts", "chat-shared.ts"]
      .flatMap((f) => readFileSync(join(ROOT, "components/agents", f), "utf8").match(/"[^"\n]*"|`[^`\n]*`/g) ?? []);
    assert.deepEqual(literals.filter((s) => identity.namesPersona(s)), []);
  });
  await check("wiring: Enter sends and Shift+Enter is a newline; Stop and Queue are there; the department turn goes through the run store, not the old route", () => {
    const src = readFileSync(join(ROOT, "components/agents/DepartmentChat.tsx"), "utf8");
    assert.match(src, /e\.key === "Enter" && !e\.shiftKey && !e\.nativeEvent\.isComposing/);
    assert.doesNotMatch(src, /disabled=\{streaming\}|metaKey|ctrlKey/);
    assert.doesNotMatch(src, /\/api\/agents\/chat/);
    const chat = readFileSync(join(ROOT, "components/agents/AgentChat.tsx"), "utf8");
    assert.match(chat, /props\.department \? <DepartmentChat \{\.\.\.props\} department=\{props\.department\} \/> : <DirectAgentChat/);
    const store = readFileSync(join(ROOT, "components/agents/run-store.ts"), "utf8");
    assert.doesNotMatch(store, /AbortController|\.abort\(/, "the store never aborts a connection: leaving a page must not end a run");
    assert.match(store, /announceTurn\(\{ department, ok: false, code: code \?\? "provider_error" \}\)/);
  });

  console.error = realError;
  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

main().catch((error) => {
  console.error = realError;
  console.error(error);
  process.exit(1);
});
