/**
 * The render half of tests/ai-engine-never-hangs.test.ts: Settings > AI brain >
 * "What powers your agents" (components/settings/AgentEnginePanel.tsx) drawn by
 * real React hooks and driven the way a person drives it, against a stubbed
 * fetch. The suite runs with --conditions=react-server, where client
 * components cannot render, so the test spawns this file with plain
 * `node --import tsx` and asserts against the JSON it prints (one line per
 * scenario). It asserts nothing itself.
 *
 * Each scenario: choose "An app on your paired computer" and Gemini CLI, press
 * Test or "Use this for my agents", look at the page WHILE the request is
 * pending (what is disabled, is there a Cancel, the elapsed counter), then
 * let the request end (a 422 with JSON, a 500, a non-JSON 502, a dropped
 * connection, a connection that never answers, a Cancel) and look again.
 *
 * Browser time limits are shortened: the panel's 85 s deadline fires after
 * 40 ms here (setTimeout is rescaled for waits of 30 s or more); the 1 s
 * elapsed counter runs in real time.
 */
import { dirname } from "node:path";
import type { ReactElement } from "react";

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

type El = ReactElement<Record<string, unknown>>;
type Frames<P> = ((props: P) => El) & { unmount: () => void };

/** A component called as a plain function, frame after frame, hook slots kept between calls. useState, useRef, useEffect only. */
function framesOf<P>(component: (props: P) => unknown): Frames<P> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the CJS object whose dispatcher slot react's hooks read
  const internals = (require("react") as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const slots: unknown[] = [];
  const pending: Array<() => void> = [];
  const cleanups = new Map<number, () => void>();
  let cursor = 0;
  const dispatcher = {
    useState(initial: unknown) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      const set = (next: unknown) => {
        slots[at] = typeof next === "function" ? (next as (prev: unknown) => unknown)(slots[at]) : next;
      };
      return [slots[at], set];
    },
    useRef(initial: unknown) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = { current: initial };
      return slots[at];
    },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const at = cursor++;
      const before = slots[at] as { deps?: unknown[] } | undefined;
      const changed =
        !before || !deps || !before.deps || deps.length !== before.deps.length || deps.some((d, i) => !Object.is(d, before.deps![i]));
      slots[at] = { deps };
      if (!changed) return;
      pending.push(() => {
        cleanups.get(at)?.();
        const cleanup = effect();
        if (typeof cleanup === "function") cleanups.set(at, cleanup);
        else cleanups.delete(at);
      });
    },
  };
  const frames = (props: P) => {
    cursor = 0;
    pending.length = 0;
    const previous = internals.H;
    internals.H = dispatcher;
    let frame: El;
    try {
      frame = component(props) as El;
    } finally {
      internals.H = previous;
    }
    for (const run of pending.splice(0)) run();
    return frame;
  };
  return Object.assign(frames, {
    unmount: () => {
      for (const cleanup of cleanups.values()) cleanup();
      cleanups.clear();
    },
  });
}

/** Every element under a node. */
function all(node: unknown): El[] {
  const found: El[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object" || !("props" in n)) return;
    found.push(n as El);
    walk((n as El).props.children);
  };
  walk(node);
  return found;
}

/** All the text under an element. */
function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as El).props.children);
  return "";
}

const tick = (ms = 15) => new Promise<void>((r) => setTimeout(r, ms));

type Reply = { status: number; body?: unknown; raw?: string } | "network" | "hang" | "slow";
type Stub = { reply: Reply; seenSignal?: AbortSignal };

const STATE = {
  ok: true,
  engine: { kind: "api" },
  account: null,
  savedProviders: [],
  bridge: { reachable: true },
  workspace: "oasis",
  canManage: true,
  engineVersion: "v-1",
};
const machine = (gemini: Record<string, unknown>) => ({
  id: "m1",
  label: "CCPC",
  data: {
    claude: { installed: true, authenticated: true, version: "2.1.270", install_hint_url: "x", checked: true },
    codex: { installed: true, authenticated: true, version: "0.146", install_hint_url: "x", checked: true },
    gemini: { install_hint_url: "x", ...gemini },
  },
});

async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  stub("next/navigation", {
    useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined, replace: () => undefined }),
    usePathname: () => "/settings/ai",
    useSearchParams: () => new URLSearchParams(),
  });
  // The panel's 85 s browser deadline fires after 40 ms here.
  const realSetTimeout = globalThis.setTimeout;
  let scaleDeadline = true;
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) =>
    realSetTimeout(fn, scaleDeadline && ms !== undefined && ms >= 30_000 ? 40 : ms, ...rest)) as typeof setTimeout;

  const { AgentEnginePanel } = await import("../components/settings/AgentEnginePanel");

  const out: Record<string, unknown> = {};

  async function scenario(name: string, opts: { reply: Reply; press: "test" | "save"; gemini?: Record<string, unknown>; cancel?: boolean; waitMs?: number; realDeadline?: boolean; truth?: Array<Record<string, unknown>>; app?: "Gemini CLI" | "Claude Code" }) {
    scaleDeadline = !opts.realDeadline;
    const stubbed: Stub = { reply: opts.reply };
    const methodsSeen: string[] = [];
    const putBodies: unknown[] = [];
    let gets = 0;
    let afterPut = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      methodsSeen.push(`${method} ${u}`);
      if (u === "/api/ai/engine" && method === "GET") {
        gets++;
        // After a save was sent, the server's truth may differ from what the page last saw (a late commit).
        const engine = putBodies.length > 0 && opts.truth ? opts.truth[Math.min(afterPut++, opts.truth.length - 1)] : STATE.engine;
        return new Response(JSON.stringify({ ...STATE, engine }), { status: 200 });
      }
      if (u === "/api/bridge/cli-status") {
        return new Response(
          JSON.stringify({ ok: true, machines: [machine(opts.gemini ?? { installed: true, authenticated: true, version: "0.63", checked: true })], agents_run_on: null }),
          { status: 200 },
        );
      }
      if (u === "/api/ai/engine") {
        stubbed.seenSignal = init?.signal ?? undefined;
        if (method === "PUT") putBodies.push(JSON.parse(String(init?.body ?? "{}")));
        const r = stubbed.reply;
        if (r === "network") throw new TypeError("Failed to fetch");
        if (r === "slow") {
          await new Promise((res) => realSetTimeout(res, 2200));
          return new Response(JSON.stringify({ ok: true, latency_ms: 2200, reply: "Hi" }), { status: 200 });
        }
        if (r === "hang") return new Promise<Response>(() => undefined); // a connection that never answers, signal ignored
        return new Response(r.raw !== undefined ? r.raw : JSON.stringify(r.body ?? {}), { status: r.status });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const Account = React.createElement("div", { "data-marker": "account-card" }, React.createElement("button", { type: "button" }, "Replace key"));
    const frames = framesOf(AgentEnginePanel as (p: { children?: unknown }) => unknown);
    let tree = frames({ children: Account });
    await tick(40);
    tree = frames({ children: Account });

    const press = (what: (el: El) => boolean, label: string) => {
      const el = all(tree).find(what);
      if (!el) throw new Error(`${name}: ${label} not found`);
      const handler = (el.props.onClick ?? el.props.onChange) as (() => unknown) | undefined;
      if (!handler) throw new Error(`${name}: ${label} has no handler`);
      return handler();
    };
    press((e) => e.props.type === "radio" && e.props.value === "cli", "cli radio");
    tree = frames({ children: Account });
    press((e) => e.props.role === "radio" && textOf(e).startsWith(opts.app ?? "Gemini CLI"), "app button");
    tree = frames({ children: Account });

    const before = {
      buttons: all(tree)
        .filter((e) => e.type === "button")
        .map((e) => textOf(e).replace(/\s+/g, " ").trim()),
      unsupportedNote: all(tree).some((e) => e.props["data-testid"] === "engine-cli-unsupported"),
    };

    const started = opts.press === "test" ? "Test" : "Use this for my agents";
    const hasButton = all(tree).some((e) => e.type === "button" && textOf(e).trim() === started);
    if (!hasButton) {
      out[name] = { before, started: false };
      frames.unmount();
      return;
    }
    press((e) => e.type === "button" && textOf(e).trim() === started, started);
    tree = frames({ children: Account }); // the frame that follows the click starts the elapsed counter
    await tick(opts.waitMs ?? 20);
    tree = frames({ children: Account });

    const mid = all(tree);
    const disabled = mid
      .filter((e) => e.props.disabled === true)
      .map((e) => `${e.type === "input" ? `${e.props.type}:${e.props.value}` : String(e.type)}:${textOf(e).replace(/\s+/g, " ").trim()}`);
    const locks = mid.filter((e) => e.props.inert !== undefined || e.props["aria-busy"] === true || String(e.props.className ?? "").includes("pointer-events-none")).length;
    const midInfo = {
      disabled,
      locks,
      cancel: mid.some((e) => e.props["data-testid"] === "engine-cancel"),
      elapsed: textOf(mid.find((e) => e.props["data-testid"] === "engine-elapsed")),
      accountCardPresent: mid.some((e) => e.props["data-marker"] === "account-card"),
      accountButtonDisabled: mid.some((e) => e.type === "button" && textOf(e) === "Replace key" && e.props.disabled === true),
    };

    if (opts.cancel) press((e) => e.props["data-testid"] === "engine-cancel", "Cancel");
    // Give the request time to end (or the shortened browser deadline to pass); never wait forever.
    let ended = false;
    for (let i = 0; i < 60 && !ended; i++) {
      await tick(25);
      tree = frames({ children: Account });
      ended = !all(tree).some((e) => e.props["data-testid"] === "engine-cancel");
    }
    if (opts.truth) {
      await tick(150); // the second re-read, after the (shortened) server window
      tree = frames({ children: Account });
    }
    const after = all(tree);
    const note = after.find((e) => e.props.role === "alert" || e.props.role === "status");
    out[name] = {
      before,
      started: true,
      mid: midInfo,
      ended,
      stillBusy: after.some((e) => e.props["data-testid"] === "engine-cancel"),
      note: note ? textOf(note) : null,
      noteRole: note ? note.props.role : null,
      stillDisabled: after.filter((e) => e.props.disabled === true).map((e) => textOf(e).trim() || String(e.props.value)),
      signalAborted: stubbed.seenSignal ? stubbed.seenSignal.aborted : null,
      puts: putBodies,
      gets,
      inUse: after.filter((e) => e.type === "label" && textOf(e).includes("In use")).map((e) => textOf(e).replace(/\s+/g, " ").trim().slice(0, 40)),
    };
    frames.unmount();
  }

  await scenario("422 json", { press: "save", reply: { status: 422, body: { ok: false, error: "engine_test_failed", message: "It did not pass the test, so nothing was changed. Google no longer lets Gemini CLI run on a personal Google sign-in. Pick Claude Code or Codex, or use an AI account." } } });
  await scenario("test 422 json", { press: "test", reply: { status: 422, body: { ok: false, message: "The app on your paired computer didn't answer in time. Try again, or pick another app." } } });
  await scenario("500 plain text", { press: "save", reply: { status: 500, raw: "Internal Server Error" } });
  await scenario("502 html", { press: "test", reply: { status: 502, raw: "<html><body>Bad gateway</body></html>" } });
  await scenario("504", { press: "test", reply: { status: 504, raw: "" } });
  await scenario("network drop", { press: "save", reply: "network" });
  await scenario("client timeout", { press: "save", reply: "hang", waitMs: 20 });
  await scenario("client timeout on test", { press: "test", reply: "hang", waitMs: 20 });
  await scenario("cancel", { press: "test", reply: "hang", cancel: true, waitMs: 20 });
  await scenario("elapsed counter", { press: "test", reply: "slow", realDeadline: true, waitMs: 1500 });
  // Cancel a save; the server went on and committed Codex. The page reads the truth at once and once more after the server's window.
  await scenario("cancel save: truth is re-read twice", { press: "save", reply: "hang", cancel: true, waitMs: 20, truth: [{ kind: "api" }, { kind: "cli", cli: "gemini" }] });
  await scenario("ok", { press: "test", reply: { status: 200, body: { ok: true, latency_ms: 4200, reply: "Hello" } } });
  await scenario("unsupported gemini", { press: "test", gemini: { installed: true, authenticated: false, version: null, checked: true, unsupported: true }, reply: { status: 200, body: {} } });
  await scenario("unsupported gemini save", { press: "save", gemini: { installed: true, authenticated: false, version: null, checked: true, unsupported: true }, reply: { status: 200, body: {} } });
  await scenario("claude with gemini unsupported", { press: "test", app: "Claude Code", gemini: { installed: true, authenticated: false, version: null, checked: true, unsupported: true }, reply: { status: 200, body: { ok: true, latency_ms: 900, reply: "Hi" } } });

  console.log(JSON.stringify(out));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
