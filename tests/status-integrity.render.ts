/**
 * The client-render half of tests/status-integrity.test.ts.
 *
 * The suite runs with `--conditions=react-server`, under which react-dom/server
 * does not resolve. The status lines below are drawn by components that need
 * whole React (System health's integration card is a client component; the
 * AI Team row, the department Slack line and Today's calendar line are
 * rendered for real here so the test reads the words a person sees). The test
 * writes the props it computed through the real server code to stdin and
 * asserts on the markup printed here.
 *
 * Three client components fetch their own state after they mount: the
 * personal Telegram bot's setup card, the personal Google panel and an app's
 * key form. Each is DRIVEN here (driver() below): mounted, its effects run,
 * fetch answered with the JSON the test read from the real routes, then drawn
 * again, so the markup is what a person sees once the page has loaded. The
 * key form is also typed into and submitted, and asked to remove its keys,
 * with one request refused part way.
 *
 * It asserts nothing: every assertion lives in the .test.ts.
 */

// A module, not a global script, so its `main` cannot collide under tsc.
export {};

import type { ReactElement } from "react";

type Case =
  | { id: string; kind: "integration_dot"; health: Record<string, unknown>; hasCredentials?: boolean | null }
  | { id: string; kind: "homes"; props: Record<string, unknown> }
  | { id: string; kind: "slack_line"; props: Record<string, unknown> }
  | { id: string; kind: "schedule"; props: Record<string, unknown> }
  /** The personal Telegram bot's setup card, loaded: `responses` maps a path to its JSON. */
  | { id: string; kind: "telegram_card"; responses: Record<string, unknown> }
  /** The personal Google panel, loaded. */
  | { id: string; kind: "personal_google_panel"; responses: Record<string, unknown> }
  /**
   * An app's key form: loaded, then `steps` run in order. `replies` answers
   * each "METHOD /path" one request at a time; its last reply repeats.
   */
  | {
      id: string;
      kind: "keys_form";
      service: string;
      appName: string;
      replies: Record<string, Array<{ status: number; body: unknown }>>;
      steps: Array<{ type: string; field?: string; value?: string; button?: string }>;
    };

type El = ReactElement<Record<string, unknown>>;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The App Router is not mounted here; nothing is clicked, so these never run. */
function stubNavigation() {
  const p = require.resolve("next/navigation");
  const exports = {
    useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined, replace: () => undefined }),
    usePathname: () => "/",
    useSearchParams: () => new URLSearchParams(),
    notFound: () => {
      throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
    },
    redirect: (url: string) => {
      throw new Error(`NEXT_REDIRECT;${url}`);
    },
  };
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

/**
 * One component driven through frames with its OWN hooks kept between them
 * (tests/library-phone-preview.render.ts does the same): render() is a frame,
 * effects() is the commit after it, and what render() returns is drawn by real
 * React. It knows useState, useRef, useCallback and useEffect, and nothing
 * else, so a new hook in a driven component fails loudly here.
 */
function driver<P>(component: (props: P) => unknown) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the CJS object whose dispatcher slot react's hooks read
  const internals = (require("react") as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const slots: unknown[] = [];
  let queued: Array<() => unknown> = [];
  let cursor = 0;
  const same = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    !!a && !!b && a.length === b.length && a.every((d, i) => Object.is(d, b[i]));
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
    useCallback(fn: unknown, deps?: unknown[]) {
      const at = cursor++;
      const prev = slots[at] as { fn: unknown; deps?: unknown[] } | undefined;
      if (prev && same(prev.deps, deps)) return prev.fn;
      slots[at] = { fn, deps };
      return fn;
    },
    useEffect(effect: () => unknown, deps?: unknown[]) {
      const at = cursor++;
      const prev = slots[at] as { deps?: unknown[] } | undefined;
      const changed = !prev || !deps || !same(prev.deps, deps);
      slots[at] = { deps };
      if (changed) queued.push(effect);
    },
  };
  return {
    render(props: P): El {
      cursor = 0;
      const previous = internals.H;
      internals.H = dispatcher;
      try {
        return component(props) as El;
      } finally {
        internals.H = previous;
      }
    },
    effects() {
      const run = queued;
      queued = [];
      for (const effect of run) effect();
    },
  };
}

/** Let every pending fetch and state update settle. */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Depth-first through children only; throws when nothing matches. */
function find(node: unknown, what: string, match: (el: El) => boolean): El {
  const walk = (n: unknown): El | null => {
    if (Array.isArray(n)) {
      for (const child of n) {
        const hit = walk(child);
        if (hit) return hit;
      }
      return null;
    }
    if (!n || typeof n !== "object" || !("props" in n)) return null;
    const el = n as El;
    if (match(el)) return el;
    return walk(el.props.children);
  };
  const hit = walk(node);
  if (!hit) throw new Error(`render: ${what} not found`);
  return hit;
}

function ownText(el: El): string {
  const c = el.props.children;
  return (Array.isArray(c) ? c : [c]).filter((x) => typeof x === "string").join("").trim();
}

/** fetch answered from a map of path -> JSON (200); anything else is a 404. */
function answer(responses: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const path = String(input).split("?")[0];
    if (Object.prototype.hasOwnProperty.call(responses, path)) return Response.json(responses[path]);
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }) as typeof fetch;
}

async function main() {
  stubNavigation();
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { IntegrationDot } = await import("../components/IntegrationDot");
  const { Homes } = await import("../components/os/aiteam/TeammateRow");
  const { SlackLine } = await import("../components/os/department/OverviewPanel");
  const { ScheduleGlance } = await import("../components/os/today/ScheduleGlance");
  const { TelegramConnectCard } = await import("../components/settings/TelegramConnectCard");
  const { PersonalIntegrationsPanel } = await import("../components/settings/PersonalIntegrationsPanel");
  const { ServiceKeysForm } = await import("../components/os/connections/ServiceKeysForm");

  const input = JSON.parse(await readStdin()) as { cases: Case[] };
  const markup: Record<string, string> = {};
  const draw = (el: unknown) => renderToStaticMarkup(el as never);
  for (const c of input.cases) {
    if (c.kind === "integration_dot") {
      markup[c.id] = renderToStaticMarkup(
        React.createElement(IntegrationDot, { health: c.health as never, connection: { hasCredentials: c.hasCredentials } }),
      );
    } else if (c.kind === "homes") {
      markup[c.id] = renderToStaticMarkup(React.createElement(Homes, c.props as never));
    } else if (c.kind === "slack_line") {
      markup[c.id] = renderToStaticMarkup(React.createElement(SlackLine, c.props as never));
    } else if (c.kind === "schedule") {
      markup[c.id] = renderToStaticMarkup(React.createElement(ScheduleGlance, c.props as never));
    } else if (c.kind === "telegram_card" || c.kind === "personal_google_panel") {
      globalThis.fetch = answer(c.responses);
      const d = c.kind === "telegram_card" ? driver(TelegramConnectCard as (p: object) => unknown) : driver(PersonalIntegrationsPanel as (p: object) => unknown);
      d.render({});
      d.effects();
      await settle();
      markup[c.id] = draw(d.render({}));
    } else {
      // The key form: every request it makes is answered from `replies`, in order.
      const queues = Object.fromEntries(Object.entries(c.replies).map(([k, v]) => [k, [...v]]));
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const key = `${(init?.method ?? "GET").toUpperCase()} ${String(input).split("?")[0]}`;
        const queue = queues[key];
        if (!queue || queue.length === 0) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
        const reply = queue.length > 1 ? queue.shift()! : queue[0];
        return Response.json(reply.body, { status: reply.status });
      }) as typeof fetch;
      const props = { service: c.service, appName: c.appName, canManage: true, onChanged: () => undefined, status: null };
      const d = driver(ServiceKeysForm as (p: typeof props) => unknown);
      d.render(props);
      d.effects();
      await settle();
      let frame = d.render(props);
      for (const step of c.steps) {
        if (step.type === "type") {
          const id = `${c.service}-${step.field}`;
          (find(frame, `the ${id} input`, (el) => el.type === "input" && el.props.id === id).props.onChange as (e: unknown) => void)({
            target: { value: step.value },
          });
        } else if (step.type === "submit") {
          (find(frame, "the form", (el) => el.type === "form").props.onSubmit as (e: unknown) => void)({ preventDefault: () => undefined });
        } else if (step.type === "click") {
          (find(frame, `the ${step.button} button`, (el) => el.type === "button" && ownText(el) === step.button).props.onClick as () => void)();
        }
        await settle();
        frame = d.render(props);
      }
      markup[c.id] = draw(frame);
    }
  }
  process.stdout.write(JSON.stringify({ markup }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
