/**
 * The render half of tests/ai-workspace-account.test.ts: the Settings > AI
 * brain provider card drawn by real React (the suite runs with
 * --conditions=react-server, where client components cannot render; the same
 * split as tests/queries-fail-loud.render.ts). The test spawns this file with
 * plain `node --import tsx` and asserts against the markup it prints.
 *
 * Run with DRIVE_FAILURES set (the replies the test collected from the real
 * disconnect and test routes), it presses the card's Disconnect and Test
 * buttons against each reply instead, and prints what the card showed.
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
type Frames<P> = ((props: P) => El) & { unmount: () => void };

/**
 * A component called as a plain function, frame after frame, with its hook
 * slots kept between calls (what React does across a router.refresh()). It
 * knows useState, useRef and useLayoutEffect (run, with its dependencies
 * honoured, as soon as the frame is drawn, which is when React runs it: at
 * commit), so any other new hook fails loudly here. `unmount` runs the
 * effects' cleanups, as React does when the component goes away.
 */
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
    useLayoutEffect(effect: () => void | (() => void), deps?: unknown[]) {
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

/** Every element under a node, through portals. */
function all(node: unknown): El[] {
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
}

function text(el: El): string {
  const c = el.props.children;
  return Array.isArray(c) ? c.filter((x) => typeof x === "string").join("") : typeof c === "string" ? c : "";
}

const plainText = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

type Reply = { label: string; status: number; body: Record<string, unknown> | null };

async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  let refreshes = 0;
  stub("next/navigation", {
    useRouter: () => ({
      push: () => undefined,
      refresh: () => {
        refreshes += 1;
      },
      prefetch: () => undefined,
      replace: () => undefined,
    }),
    usePathname: () => "/settings/ai",
    useSearchParams: () => new URLSearchParams(),
  });
  stub("next/link", {
    __esModule: true,
    default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; prefetch?: boolean; children?: unknown }) =>
      React.createElement("a", { href, ...rest }, children as React.ReactNode),
  });
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ProviderAccountsCard, ConnectProviderDialog } = await import("../components/settings/ProviderAccountsCard");
  const base = { bridgeOnline: true, canManageTeam: true, canInstallBridge: false };
  const card = (frame: El, provider: string) => find(frame, `the ${provider} card`, (el) => el.key === provider);

  // ---- Second run: the card's Disconnect and Test buttons against real replies.
  if (process.env.DRIVE_FAILURES) {
    const input = JSON.parse(process.env.DRIVE_FAILURES) as { disconnects: Reply[]; tests: Reply[] };
    let reply: Reply = { label: "", status: 200, body: {} };
    (globalThis as unknown as { confirm: unknown }).confirm = () => true;
    (globalThis as unknown as { fetch: unknown }).fetch = async () => {
      // A null body is a request that never reached the server.
      if (reply.body === null) throw new TypeError("fetch failed: socket hang up (stand-in)");
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
    };
    const nothing = { ...base, connectedServices: new Set<string>(), personalServices: new Set<string>() };
    const disconnects: Array<Record<string, unknown>> = [];
    for (const r of input.disconnects) {
      // This page connected Anthropic itself (its own overlay reads Connected),
      // then the disconnect fails; the server's answer by then: nothing connected.
      const accounts = framesOf(ProviderAccountsCard);
      let frame = accounts(nothing);
      const connectButton = find(card(frame, "anthropic"), "Anthropic's Connect button", (el) => el.type === "button" && typeof el.props.onClick === "function");
      (connectButton.props.onClick as () => void)();
      frame = accounts(nothing);
      const dialog = find(frame, "the connect dialog", (el) => typeof el.props.onConnected === "function");
      (dialog.props.onConnected as (p: string, scope: string) => void)("anthropic", "tenant");
      frame = accounts(nothing);
      const connectedFirst = /\bConnected\b/.test(plainText(renderToStaticMarkup(card(frame, "anthropic"))));
      const disconnect = find(card(frame, "anthropic"), "Anthropic's Disconnect button", (el) => typeof el.props.onDisconnected === "function");
      const buttonFrames = framesOf(disconnect.type as (props: Record<string, unknown>) => unknown);
      const press = all(buttonFrames(disconnect.props)).find((el) => el.type === "button");
      if (!press) throw new Error("render: the Disconnect button not found");
      reply = r;
      const before = refreshes;
      await (press.props.onClick as () => Promise<void>)();
      const shown = all(buttonFrames(disconnect.props)).find((el) => el.props.role === "alert");
      disconnects.push({
        label: r.label,
        connectedFirst,
        shown: shown ? text(shown) : null,
        title: shown ? (shown.props.title ?? null) : null,
        refreshed: refreshes - before,
        connectedAfter: /\bConnected\b/.test(plainText(renderToStaticMarkup(card(accounts(nothing), "anthropic")))),
      });
    }
    const tests: Array<Record<string, unknown>> = [];
    for (const r of input.tests) {
      const accounts = framesOf(ProviderAccountsCard);
      const frame = accounts({ ...base, connectedServices: new Set(["anthropic"]), personalServices: new Set<string>() });
      const test = find(
        card(frame, "anthropic"),
        "Anthropic's Test button",
        (el) => typeof el.type === "function" && (el.type as { name?: string }).name === "TestConnectionButton",
      );
      const testFrames = framesOf(test.type as (props: Record<string, unknown>) => unknown);
      const press = all(testFrames(test.props)).find((el) => el.type === "button");
      if (!press) throw new Error("render: the Test button not found");
      reply = r;
      await (press.props.onClick as () => Promise<void>)();
      const failed = all(testFrames(test.props)).find((el) => el.type === "span" && typeof el.props.title === "string");
      tests.push({ label: r.label, title: failed ? failed.props.title : null, shown: failed ? text(failed) : null });
    }
    process.stdout.write(JSON.stringify({ disconnects, tests }));
    return;
  }

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
  // key at once, never Connected, before and after the refresh lands. Every
  // frame before the refresh is drawn from the SAME server answer (the same
  // props object, as React re-renders between refreshes); the refresh is a
  // new answer.
  const accounts = framesOf(ProviderAccountsCard);
  const beforeRefresh = { ...base, connectedServices: new Set<string>(), personalServices: new Set<string>() };
  let frame = accounts(beforeRefresh);
  const connectGoogle = find(card(frame, "google"), "Google's Connect button", (el) => el.type === "button" && typeof el.props.onClick === "function");
  (connectGoogle.props.onClick as () => void)();
  frame = accounts(beforeRefresh);
  const dialog = find(frame, "the connect dialog", (el) => typeof el.props.onConnected === "function");
  (dialog.props.onConnected as (p: string, scope: string) => void)("google", "user");
  out.afterPersonalConnect = renderToStaticMarkup(accounts(beforeRefresh));
  out.afterPersonalConnectRefresh = renderToStaticMarkup(
    accounts({ ...base, connectedServices: new Set<string>(), personalServices: new Set(["google_ai"]) }),
  );

  // R5-M2 (PR #535 review): this page's own changes last only until the
  // server's next answer. Connect Anthropic, then OpenRouter: once the server
  // says only OpenRouter is the account, Anthropic reads Not connected (it used
  // to read Connected for the page's life). And the dangerous way round: a
  // stale "disconnected" never draws Not connected over a newer answer that
  // says Connected.
  const connectedOn = (f: El, p: string) => /\bConnected\b/.test(plainText(renderToStaticMarkup(card(f, p))).replace(/Not connected/g, ""));
  const pressConnect = (frames: Frames<Record<string, unknown>>, props: Record<string, unknown>, p: string) => {
    const f = frames(props);
    const button = find(card(f, p), `${p}'s Connect button`, (el) => el.type === "button" && typeof el.props.onClick === "function");
    (button.props.onClick as () => void)();
    const open = find(frames(props), "the connect dialog", (el) => typeof el.props.onConnected === "function");
    (open.props.onConnected as (prov: string, scope: string) => void)(p, "tenant");
  };
  const overlay: Record<string, unknown> = {};
  const m2 = framesOf(ProviderAccountsCard) as unknown as Frames<Record<string, unknown>>;
  const s0 = { ...base, connectedServices: new Set<string>(), personalServices: new Set<string>() };
  pressConnect(m2, s0, "anthropic");
  overlay.anthropicBeforeAnswer = connectedOn(m2(s0), "anthropic");
  const s1 = { ...base, connectedServices: new Set(["anthropic"]), personalServices: new Set<string>() };
  overlay.anthropicAnswered = connectedOn(m2(s1), "anthropic");
  pressConnect(m2, s1, "openrouter");
  const both = m2(s1);
  overlay.bothBeforeAnswer = [connectedOn(both, "anthropic"), connectedOn(both, "openrouter")];
  const s2 = { ...base, connectedServices: new Set(["openrouter"]), personalServices: new Set<string>() };
  const settled = m2(s2);
  overlay.afterOpenRouterAnswer = [connectedOn(settled, "anthropic"), connectedOn(settled, "openrouter")];
  overlay.header = /Cloud: 1 provider connected/.test(plainText(renderToStaticMarkup(settled)));
  // The dangerous way round: Anthropic disconnected here, then a newer answer says Connected.
  const d2 = framesOf(ProviderAccountsCard) as unknown as Frames<Record<string, unknown>>;
  const a0 = { ...base, connectedServices: new Set(["anthropic"]), personalServices: new Set<string>() };
  const disconnectButton = find(card(d2(a0), "anthropic"), "Anthropic's Disconnect button", (el) => typeof el.props.onDisconnected === "function");
  (disconnectButton.props.onDisconnected as () => void)();
  overlay.disconnectedBeforeAnswer = connectedOn(d2(a0), "anthropic");
  const a1 = { ...base, connectedServices: new Set(["anthropic"]), personalServices: new Set<string>() };
  overlay.newerAnswerSaysConnected = connectedOn(d2(a1), "anthropic");
  out.overlay = JSON.stringify(overlay);
  // Closing the dialog draws the cards again from the server: a save whose
  // answer never came may have landed after all.
  const closeFrames = framesOf(ProviderAccountsCard);
  const none = { ...base, connectedServices: new Set<string>(), personalServices: new Set<string>() };
  let closeFrame = closeFrames(none);
  const openAnthropic = find(card(closeFrame, "anthropic"), "Anthropic's Connect button", (el) => el.type === "button" && typeof el.props.onClick === "function");
  (openAnthropic.props.onClick as () => void)();
  closeFrame = closeFrames(none);
  const openDialog = find(closeFrame, "the open connect dialog", (el) => typeof el.props.onConnected === "function");
  const refreshesBeforeClose = refreshes;
  (openDialog.props.onClose as () => void)();
  out.closeRefreshes = String(refreshes - refreshesBeforeClose);

  // The connect dialog itself (Codex review, PR #535): "Save anyway" belongs to
  // the exact provider, key, model and scope the provider timed out on, and
  // any edit takes it away. The dialog is driven frame by frame through its own
  // state, with the two routes it calls answered by a recording fetch; a test
  // answer, or a save, can be held back and let land later (a slow provider).
  // Every user action is followed by the frame React would draw and commit
  // after it. Its portal needs a DOM container: a bare element-shaped one is
  // enough here, and is set only for this part (the card renders above ran
  // without one).
  type DialogProps = Parameters<typeof ConnectProviderDialog>[0];
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let testAnswer: Record<string, unknown> = {};
  let saveAnswer: Record<string, unknown> | null = null;
  let holdNextTest = false;
  let holdNextSave = false;
  const held: Array<(answer: Record<string, unknown>) => void> = [];
  const heldSaves: Array<(answer: Record<string, unknown>) => void> = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, body });
    let json: Record<string, unknown>;
    if (url.endsWith("/test-connection")) {
      const hold = holdNextTest;
      holdNextTest = false;
      json = hold ? await new Promise<Record<string, unknown>>((resolve) => held.push(resolve)) : testAnswer;
    } else {
      const hold = holdNextSave;
      holdNextSave = false;
      json = hold
        ? await new Promise<Record<string, unknown>>((resolve) => heldSaves.push(resolve))
        : (saveAnswer ?? { ok: true, scope: body.scope, workspace_account: true, applied_to: [], failed: [], count: 0 });
    }
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  };
  (globalThis as unknown as { document: unknown }).document = { body: { nodeType: 1 } };
  const timedOut = { ok: false, status: "error", provider: "anthropic", code: "timeout", message: "The AI provider did not answer within 15 seconds. Try again in a minute." };
  const refused = { ok: false, status: "error", provider: "anthropic", code: "provider_401", message: "Your AI account refused the request. Check its billing or key." };
  const answered = { ok: true, status: "ok", provider: "anthropic", latency_ms: 420 };
  const connected: Array<{ provider: string; scope: string }> = [];
  let closes = 0;
  let dialogFrames = framesOf(ConnectProviderDialog);
  let props: DialogProps = {
    provider: "anthropic",
    canManageTeam: true,
    onClose: () => {
      closes += 1;
    },
    onConnected: (provider: string, scope: string) => connected.push({ provider, scope }),
  };
  /** A fresh dialog: what opening Connect again mounts. */
  const reopen = () => {
    dialogFrames = framesOf(ConnectProviderDialog);
    props = { ...props, provider: "anthropic" };
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
  const landOnly = async (answer: Record<string, unknown>, run: Promise<void>) => {
    const resolve = held.shift();
    if (!resolve) throw new Error("render: no test answer was held back");
    resolve(answer);
    await run;
  };
  /** The same, then the frame drawn after it (the dialog is still open). */
  const land = async (answer: Record<string, unknown>, run: Promise<void>) => {
    await landOnly(answer, run);
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
  out.lateAnswers = JSON.stringify(late);

  // Closing the dialog while a key is being tried (PR #535 review): the close
  // button and the backdrop are locked like Cancel; and a dialog that went
  // away anyway saves nothing and applies nothing.
  const closing: Record<string, unknown> = {};
  reopen();
  typeKey("sk-ant-closing-key-F");
  from = calls.length;
  const connectedBeforeClose = connected.length;
  const closesBefore = closes;
  run = submitHeld();
  const closeButton = frameNow().find((el) => el.type === "button" && el.props.title === "Close");
  const backdrop = frameNow().find((el) => typeof el.props.className === "string" && el.props.className.includes("fixed inset-0"));
  if (!closeButton || !backdrop) throw new Error("render: the close button or the backdrop not found");
  closing.closeLocked = closeButton.props.disabled === true;
  (backdrop.props.onClick as (e: unknown) => void)({});
  closing.backdropCloses = closes - closesBefore;
  // Closed anyway (the handler called directly: a browser cannot), so the
  // card takes the dialog away; then the held test passes, late.
  (closeButton.props.onClick as () => void)();
  dialogFrames.unmount();
  await landOnly(answered, run);
  closing.closedThenPassed = { closes: closes - closesBefore, saves: savesSince(from), connected: connected.length - connectedBeforeClose };
  // The test passes at once and the save is out when the dialog goes away
  // (with the page): the save happened, but nothing is applied after it.
  reopen();
  typeKey("sk-ant-closing-key-G");
  testAnswer = answered;
  holdNextSave = true;
  from = calls.length;
  const connectedBeforeGone = connected.length;
  run = submitWith(theForm());
  for (let i = 0; i < 200 && heldSaves.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
  closing.saveWasOut = heldSaves.length === 1;
  dialogFrames.unmount();
  heldSaves.shift()?.({ ok: true, scope: "tenant", workspace_account: true, applied_to: [], failed: [], count: 0 });
  await run;
  closing.goneDuringSave = { saves: savesSince(from), connected: connected.length - connectedBeforeGone };
  out.closing = JSON.stringify(closing);

  // A plain connect: the pasted key is tested once, on its model, then saved
  // (what the dialog sends, not what its source says). A save the route
  // refuses is its one sentence, naming no teammate.
  const plain: Record<string, unknown> = {};
  reopen();
  typeKey("sk-ant-plain-key-P");
  testAnswer = answered;
  from = calls.length;
  const connectedBeforePlain = connected.length;
  await submit();
  plain.calls = calls.slice(from);
  plain.connected = connected.length - connectedBeforePlain;
  reopen();
  typeKey("sk-ant-member-key-Q");
  saveAnswer = { ok: false, error: "admin_required", failed: [{ agent_key: "sdr", error: "admin_required" }] };
  await submit();
  plain.refusedSave = alertText();
  reopen();
  typeKey("sk-ant-partial-key-R");
  saveAnswer = {
    ok: true,
    scope: "tenant",
    workspace_account: true,
    applied_to: ["customer-support"],
    failed: [{ agent_key: "sdr", error: "SQLITE_BUSY" }],
    count: 1,
  };
  const connectedBeforePartial = connected.length;
  await submit();
  plain.partialSave = { connected: connected.length - connectedBeforePartial, alert: alertText() };
  saveAnswer = null;
  delete (globalThis as unknown as { document?: unknown }).document;
  out.plainConnect = JSON.stringify(plain);

  // Settings > AI brain's per-agent notes and the account line
  // (components/settings/AgentConfigEditor.tsx), from lib/ai/model-registry.ts.
  const { ModelNoteLine, AccountModelLine } = await import("../components/settings/AgentConfigEditor");
  const draw = (el: ReactElement) => plainText(renderToStaticMarkup(el)).trim();
  out.notes = JSON.stringify({
    gone: draw(React.createElement(ModelNoteLine, { provider: "google", model: "gemini-2.5-pro", audience: "agent" })),
    current: draw(React.createElement(ModelNoteLine, { provider: "google", model: "gemini-3.8-flash", audience: "agent" })),
    unknown: draw(React.createElement(ModelNoteLine, { provider: "openrouter", model: "anthropic/claude-sonnet-4", audience: "agent" })),
    account: draw(React.createElement(AccountModelLine, { account: { provider: "google", model: "gemini-2.5-pro", connected: true } })),
    accountCurrent: draw(React.createElement(AccountModelLine, { account: { provider: "google", model: "gemini-3.8-flash", connected: true } })),
    accountUnread: draw(React.createElement(AccountModelLine, { account: null })),
    accountOff: draw(React.createElement(AccountModelLine, { account: { provider: "google", model: "gemini-2.5-pro", connected: false } })),
  });

  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
