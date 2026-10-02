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
 * The card called as a plain function, frame after frame, with its hook slots
 * kept between calls (what React does across a router.refresh()). It knows
 * useState, useRef and useLayoutEffect (run as soon as the frame is drawn,
 * which is when React runs it: at commit), so any other new hook in the card
 * fails loudly here.
 */
function framesOf<P>(component: (props: P) => unknown): (props: P) => El {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the CJS object whose dispatcher slot react's hooks read
  const internals = (require("react") as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const slots: unknown[] = [];
  const effects: Array<() => void> = [];
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
    useLayoutEffect(effect: () => void) {
      effects.push(effect);
    },
  };
  return (props: P) => {
    cursor = 0;
    effects.length = 0;
    const previous = internals.H;
    internals.H = dispatcher;
    let frame: El;
    try {
      frame = component(props) as El;
    } finally {
      internals.H = previous;
    }
    for (const effect of effects.splice(0)) effect();
    return frame;
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
  // the exact provider, key, model and scope the provider timed out on, and
  // any edit takes it away. The dialog is driven frame by frame through its own
  // state, with the two routes it calls answered by a recording fetch; a test
  // answer can be held back and let land later (a slow provider). Every user
  // action is followed by the frame React would draw and commit after it. Its
  // portal needs a DOM container: a bare element-shaped one is enough here, and
  // is set only for this part (the card renders above ran without one).
  const { ConnectProviderDialog } = await import("../components/settings/ProviderAccountsCard");
  type DialogProps = Parameters<typeof ConnectProviderDialog>[0];
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let testAnswer: Record<string, unknown> = {};
  let holdNextTest = false;
  const held: Array<(answer: Record<string, unknown>) => void> = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, body });
    let json: Record<string, unknown> = { ok: true, scope: body.scope, workspace_account: true, applied_to: [], failed: [], count: 0 };
    if (url.endsWith("/test-connection")) {
      const hold = holdNextTest;
      holdNextTest = false;
      json = hold ? await new Promise<Record<string, unknown>>((resolve) => held.push(resolve)) : testAnswer;
    }
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  };
  (globalThis as unknown as { document: unknown }).document = { body: { nodeType: 1 } };
  const timedOut = { ok: false, status: "error", provider: "anthropic", code: "timeout", message: "The AI provider did not answer within 15 seconds. Try again in a minute." };
  const refused = { ok: false, status: "error", provider: "anthropic", code: "provider_401", message: "Your AI account refused the request. Check its billing or key." };
  const answered = { ok: true, status: "ok", provider: "anthropic", latency_ms: 420 };
  const connected: Array<{ provider: string; scope: string }> = [];
  let dialogFrames = framesOf(ConnectProviderDialog);
  let props: DialogProps = {
    provider: "anthropic",
    canManageTeam: true,
    onClose: () => undefined,
    onConnected: (provider: string, scope: string) => connected.push({ provider, scope }),
  };
  /** A fresh dialog: what opening Connect again mounts. */
  const reopen = () => {
    dialogFrames = framesOf(ConnectProviderDialog);
    props = { ...props, provider: "anthropic" };
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
  /** The one-sentence error on screen, or null. */
  const alertText = () => {
    const box = frameNow().find((el) => el.props.role === "alert");
    return box ? all(box.props.children).map(text).join("") : null;
  };
  /** Which form controls are locked (disabled) right now. */
  const locked = () => {
    const f = frameNow();
    const is = (el: El | undefined) => el?.props.disabled === true;
    return {
      key: is(f.find((el) => el.type === "input")),
      model: is(f.find((el) => el.type === "select")),
      wholeTeam: is(f.find((el) => el.type === "button" && text(el) === "Whole team")),
      justMe: is(f.find((el) => el.type === "button" && text(el) === "Just me")),
    };
  };
  /** A user action, then the frame drawn after it. */
  const act = (what: string, match: (el: El) => boolean, fire: (el: El) => void) => {
    const el = frameNow().find(match);
    if (!el) throw new Error(`render: ${what} not found`);
    fire(el);
    frameNow();
  };
  // The steps call the controls' handlers directly, so an edit lands even
  // while the form is locked: that is how they prove the late-answer guard on
  // its own (a browser could not make that edit at all).
  const typeKey = (value: string) =>
    act(
      "the key input",
      (el) => el.type === "input" && typeof el.props.onChange === "function",
      (el) => (el.props.onChange as (e: unknown) => void)({ target: { value } }),
    );
  const pickModel = (value: string) =>
    act("the model select", (el) => el.type === "select", (el) => (el.props.onChange as (e: unknown) => void)({ target: { value } }));
  const pickScope = (label: string) =>
    act(`the ${label} button`, (el) => el.type === "button" && text(el) === label, (el) => (el.props.onClick as () => void)());
  const submitWith = (form: El) => (form.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault: () => undefined });
  const theForm = () => {
    const form = frameNow().find((el) => el.type === "form");
    if (!form) throw new Error("render: the form not found");
    return form;
  };
  const submit = async () => {
    await submitWith(theForm());
    frameNow();
  };
  /** Submit, holding the test's answer back: the run is still out on return. */
  const submitHeld = (form: El = theForm()) => {
    holdNextTest = true;
    const run = submitWith(form);
    frameNow();
    return run;
  };
  /** Let the oldest held test answer land, and wait for its run to finish. */
  const land = async (answer: Record<string, unknown>, run: Promise<void>) => {
    const resolve = held.shift();
    if (!resolve) throw new Error("render: no test answer was held back");
    resolve(answer);
    await run;
    frameNow();
  };
  const savesSince = (from: number) => calls.slice(from).filter((c) => c.url.endsWith("/bulk-provider")).length;
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
  steps.connected = connected.slice();
  out.saveAnyway = JSON.stringify(steps);

  // An answer that lands after the form moved on (Codex review of PR #535,
  // round 3): it brought "Save anyway" back for a key no longer on screen.
  const late: Record<string, unknown> = {};
  const connectedBefore = connected.length;
  reopen();
  // Key A is tested and its answer is held; meanwhile the key becomes B; then
  // A's timeout lands.
  typeKey("sk-ant-late-key-A");
  let from = calls.length;
  let run = submitHeld();
  late.lockedWhileTesting = locked();
  typeKey("sk-ant-late-key-B");
  await land(timedOut, run);
  late.timeoutAfterKeyEdit = { saveAnyway: saveAnyway() !== null, alert: alertText(), saves: savesSince(from), locked: locked() };
  // B is tested; meanwhile the key becomes C; then B passes, late.
  from = calls.length;
  run = submitHeld();
  typeKey("sk-ant-late-key-C");
  await land(answered, run);
  late.passAfterKeyEdit = {
    saveAnyway: saveAnyway() !== null,
    alert: alertText(),
    saves: savesSince(from),
    connected: connected.length - connectedBefore,
    locked: locked(),
  };
  // The scope, the model, then the provider itself change while C is tested.
  run = submitHeld();
  pickScope("Just me");
  await land(timedOut, run);
  late.timeoutAfterScopeEdit = { saveAnyway: saveAnyway() !== null, alert: alertText(), locked: locked() };
  pickScope("Whole team");
  run = submitHeld();
  pickModel("claude-haiku-4-5");
  await land(timedOut, run);
  late.timeoutAfterModelEdit = { saveAnyway: saveAnyway() !== null, alert: alertText(), locked: locked() };
  run = submitHeld();
  props = { ...props, provider: "openai" };
  frameNow();
  await land(timedOut, run);
  late.timeoutAfterProviderChange = { saveAnyway: saveAnyway() !== null, alert: alertText(), locked: locked() };
  props = { ...props, provider: "anthropic" };
  frameNow();
  // Nothing moved: the same timeout, landing on time, still offers Save anyway.
  run = submitHeld();
  late.lockedAgain = locked();
  await land(timedOut, run);
  late.timeoutOnTime = { saveAnyway: saveAnyway() !== null, alert: alertText(), locked: locked() };
  // Two runs at once, from a submit handler drawn before the lock (in a
  // browser the lock and the busy check stop a second run): the older run's
  // timeout lands after the newer run started, then the newer run's refusal.
  reopen();
  typeKey("sk-ant-overlap-key-E");
  const formBeforeTheLock = theForm();
  const older = submitHeld(formBeforeTheLock);
  const newer = submitHeld(formBeforeTheLock);
  await land(timedOut, older);
  late.olderRunLate = { saveAnyway: saveAnyway() !== null, alert: alertText(), locked: locked() };
  await land(refused, newer);
  late.newerRunAnswer = { saveAnyway: saveAnyway() !== null, alert: alertText(), locked: locked() };
  late.heldLeft = held.length;
  delete (globalThis as unknown as { document?: unknown }).document;
  out.lateAnswers = JSON.stringify(late);

  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
