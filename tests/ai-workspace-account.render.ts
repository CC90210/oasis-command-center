/**
 * The render half of tests/ai-workspace-account.test.ts: the Settings > AI
 * brain provider card drawn by real React (the suite runs with
 * --conditions=react-server, where client components cannot render; the same
 * split as tests/queries-fail-loud.render.ts). The test spawns this file with
 * plain `node --import tsx` and asserts against the markup it prints.
 *
 * It asserts nothing: every assertion lives in the .test.ts.
 */
import { dirname } from "node:path";
import type { ReactElement } from "react";

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

type El = ReactElement<Record<string, unknown>>;

/**
 * The card called as a plain function, frame after frame, with its useState
 * slots kept between calls (what React does across a router.refresh()). It
 * knows useState only, so a new hook in the card fails loudly here.
 */
function framesOf<P>(component: (props: P) => unknown): (props: P) => El {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the CJS object whose dispatcher slot react's useState reads
  const internals = (require("react") as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const slots: unknown[] = [];
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
  };
  return (props: P) => {
    cursor = 0;
    const previous = internals.H;
    internals.H = dispatcher;
    try {
      return component(props) as El;
    } finally {
      internals.H = previous;
    }
  };
}

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

async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  stub("next/navigation", {
    useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined, replace: () => undefined }),
    usePathname: () => "/settings/ai",
    useSearchParams: () => new URLSearchParams(),
  });
  stub("next/link", {
    __esModule: true,
    default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; prefetch?: boolean; children?: unknown }) =>
      React.createElement("a", { href, ...rest }, children as React.ReactNode),
  });
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ProviderAccountsCard } = await import("../components/settings/ProviderAccountsCard");
  const base = { bridgeOnline: true, canManageTeam: true, canInstallBridge: false };
  const card = (frame: El, provider: string) => find(frame, `the ${provider} card`, (el) => el.key === provider);

  // A CLIENT owner (not the platform operator: no bridge install offered).
  const client = { bridgeOnline: false, canManageTeam: true, canInstallBridge: false };
  const out: Record<string, string> = {
    // A client owner with nothing connected (the no-provider notice shows too),
    // and one whose account is on Anthropic.
    clientEmpty: renderToStaticMarkup(
      React.createElement(ProviderAccountsCard, { ...client, connectedServices: new Set<string>(), personalServices: new Set<string>() }),
    ),
    clientAnthropic: renderToStaticMarkup(
      React.createElement(ProviderAccountsCard, { ...client, connectedServices: new Set(["anthropic"]), personalServices: new Set<string>() }),
    ),
    // The verified operator, account on Anthropic: the tool_use badge is his.
    operatorAnthropic: renderToStaticMarkup(
      React.createElement(ProviderAccountsCard, { ...client, canInstallBridge: true, connectedServices: new Set(["anthropic"]), personalServices: new Set<string>() }),
    ),
    // Only the owner's own key is on Anthropic: department chats don't use it.
    personalOnly: renderToStaticMarkup(
      React.createElement(ProviderAccountsCard, { ...base, connectedServices: new Set<string>(), personalServices: new Set(["anthropic"]) }),
    ),
    // The workspace's account is on OpenRouter, and the owner also has a personal OpenRouter key.
    connectedAndPersonal: renderToStaticMarkup(
      React.createElement(ProviderAccountsCard, { ...base, connectedServices: new Set(["openrouter"]), personalServices: new Set(["openrouter"]) }),
    ),
  };

  // A "Just me" connect on the mounted card: Google reads as the owner's own
  // key at once, never Connected, before and after the refresh lands.
  const accounts = framesOf(ProviderAccountsCard);
  let frame = accounts({ ...base, connectedServices: new Set<string>(), personalServices: new Set<string>() });
  const connectGoogle = find(card(frame, "google"), "Google's Connect button", (el) => el.type === "button" && typeof el.props.onClick === "function");
  (connectGoogle.props.onClick as () => void)();
  frame = accounts({ ...base, connectedServices: new Set<string>(), personalServices: new Set<string>() });
  const dialog = find(frame, "the connect dialog", (el) => typeof el.props.onConnected === "function");
  (dialog.props.onConnected as (p: string, scope: string) => void)("google", "user");
  out.afterPersonalConnect = renderToStaticMarkup(accounts({ ...base, connectedServices: new Set<string>(), personalServices: new Set<string>() }));
  out.afterPersonalConnectRefresh = renderToStaticMarkup(
    accounts({ ...base, connectedServices: new Set<string>(), personalServices: new Set(["google_ai"]) }),
  );

  // The connect dialog itself (Codex review, PR #535): "Save anyway" belongs to
  // the exact provider, key and model the provider timed out on, and any edit
  // takes it away. The dialog is driven frame by frame through its own state,
  // with the two routes it calls answered by a recording fetch. Its portal
  // needs a DOM container: a bare element-shaped one is enough here, and is set
  // only for this part (the card renders above ran without one).
  const { ConnectProviderDialog } = await import("../components/settings/ProviderAccountsCard");
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let testAnswer: Record<string, unknown> = {};
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, body });
    const json = url.endsWith("/test-connection") ? testAnswer : { ok: true, scope: body.scope, workspace_account: true, applied_to: [], failed: [], count: 0 };
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  };
  (globalThis as unknown as { document: unknown }).document = { body: { nodeType: 1 } };
  const timedOut = { ok: false, status: "error", provider: "anthropic", code: "timeout", message: "The AI provider did not answer within 15 seconds. Try again in a minute." };
  const refused = { ok: false, status: "error", provider: "anthropic", code: "provider_401", message: "Your AI account refused the request. Check its billing or key." };
  const connected: Array<{ provider: string; scope: string }> = [];
  const dialogFrames = framesOf(ConnectProviderDialog);
  const props = {
    provider: "anthropic" as const,
    canManageTeam: true,
    onClose: () => undefined,
    onConnected: (provider: string, scope: string) => connected.push({ provider, scope }),
  };
  /** Every element in the dialog, through its portal. */
  const all = (node: unknown): El[] => {
    const found: El[] = [];
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== "object") return;
      if ("props" in n) {
        found.push(n as El);
        return walk((n as El).props.children);
      }
      if ("children" in n) walk((n as { children: unknown }).children);
    };
    walk(node);
    return found;
  };
  const text = (el: El): string => {
    const c = el.props.children;
    return Array.isArray(c) ? c.filter((x) => typeof x === "string").join("") : typeof c === "string" ? c : "";
  };
  const frameNow = () => all(dialogFrames(props));
  const saveAnyway = () => frameNow().find((el) => el.type === "button" && text(el) === "Save anyway") ?? null;
  const typeKey = (value: string) => {
    const input = frameNow().find((el) => el.type === "input" && typeof el.props.onChange === "function");
    if (!input) throw new Error("render: the key input not found");
    (input.props.onChange as (e: unknown) => void)({ target: { value } });
  };
  const pickModel = (value: string) => {
    const select = frameNow().find((el) => el.type === "select");
    if (!select) throw new Error("render: the model select not found");
    (select.props.onChange as (e: unknown) => void)({ target: { value } });
  };
  const pickScope = (label: string) => {
    const button = frameNow().find((el) => el.type === "button" && text(el) === label);
    if (!button) throw new Error(`render: the ${label} button not found`);
    (button.props.onClick as () => void)();
  };
  const submit = async () => {
    const form = frameNow().find((el) => el.type === "form");
    if (!form) throw new Error("render: the form not found");
    await (form.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault: () => undefined });
  };
  const steps: Record<string, unknown> = {};
  typeKey("sk-ant-tested-key-A");
  testAnswer = timedOut;
  await submit();
  steps.afterTimeout = saveAnyway() !== null;
  typeKey("sk-ant-untested-key-B");
  steps.afterKeyEdit = saveAnyway() !== null;
  typeKey("sk-ant-tested-key-A");
  steps.afterKeyBack = saveAnyway() !== null;
  await submit();
  steps.afterSecondTimeout = saveAnyway() !== null;
  pickModel("claude-opus-4-7");
  steps.afterModelEdit = saveAnyway() !== null;
  await submit();
  steps.afterModelTimeout = saveAnyway() !== null;
  pickScope("Just me");
  steps.afterScopeEdit = saveAnyway() !== null;
  pickScope("Whole team");
  await submit();
  testAnswer = refused;
  typeKey("sk-ant-refused-key-C");
  await submit();
  steps.afterRefusal = saveAnyway() !== null;
  // A last timeout on key A with the model it was tested on, then Save anyway:
  // exactly that is saved, with no second test.
  typeKey("sk-ant-tested-key-A");
  testAnswer = timedOut;
  await submit();
  const button = saveAnyway();
  steps.beforeSave = button !== null;
  const callsBefore = calls.length;
  if (button) {
    // The button starts the save without returning it: wait for it to finish.
    (button.props.onClick as () => void)();
    for (let i = 0; i < 200 && connected.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  }
  steps.saveCalls = calls.slice(callsBefore);
  steps.connected = connected;
  delete (globalThis as unknown as { document?: unknown }).document;
  out.saveAnyway = JSON.stringify(steps);

  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
