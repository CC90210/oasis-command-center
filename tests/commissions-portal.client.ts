/**
 * The interaction half of tests/commissions-portal.test.ts.
 *
 * WHY. No DOM library is installed and react-dom/server never runs a click,
 * so this drives the real CommissionPortal with a minimal stand-in for
 * React's hooks: state lives in slots between "renders", a click calls the
 * element's own handler, and fetch answers only when this script says so.
 * That is enough to replay the race from the review of 2026-10-02: a Refresh
 * starts while a payout is being saved, the save's own re-read answers
 * first, and the Refresh answers LAST with the numbers from before the
 * payout. It prints what the screen showed after each step; every assertion
 * lives in the .test.ts.
 *
 * Run by tests/commissions-portal.test.ts with plain `node --import tsx`
 * (input on stdin: { initial, afterPayout, paidRowId }).
 */

// A module, not a global script: its `main` must not collide with other
// scripts' under `tsc --noEmit -p .`.
export {};

type Props = { [key: string]: unknown; children?: unknown };
type El = { type: unknown; props: Props };
type Respond = (status: number, body: unknown) => void;

// -- the stand-in for React ---------------------------------------------------
// The portal calls its hooks in the same order on every render, so a slot per
// call keeps its state; useCallback/useMemo simply run fresh each render.
const slots: unknown[] = [];
let cursor = 0;
const ReactStub = {
  createElement(type: unknown, props: Props | null, ...children: unknown[]): El {
    return {
      type,
      props: { ...(props ?? {}), children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children },
    };
  },
  Fragment: "Fragment",
  forwardRef(render: unknown) {
    return { forwardRef: render };
  },
  useState<T>(initial: T | (() => T)): [T, (next: T | ((current: T) => T)) => void] {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    const set = (next: T | ((current: T) => T)) => {
      slots[index] = typeof next === "function" ? (next as (current: T) => T)(slots[index] as T) : next;
    };
    return [slots[index] as T, set];
  },
  useRef<T>(initial: T): { current: T } {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index] as { current: T };
  },
  useCallback<T>(fn: T): T {
    return fn;
  },
  useMemo<T>(fn: () => T): T {
    return fn();
  },
};

function stub(request: string, exports: unknown): void {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

// -- a fetch that answers when told to ----------------------------------------
const calls: Array<{ method: string; respond: Respond }> = [];
globalThis.fetch = ((_url: unknown, init?: { method?: string }) =>
  new Promise((resolve) => {
    calls.push({
      method: init?.method ?? "GET",
      respond: (status, body) =>
        resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response),
    });
  })) as typeof fetch;

/** Let every pending promise chain run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Every host element of a tree; the portal's own small components (no hooks) are expanded. */
function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
    return out;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return out;
  const el = node as El;
  if (typeof el.type === "function") return elements((el.type as (props: Props) => unknown)(el.props), out);
  out.push(el);
  elements(el.props.children, out);
  return out;
}

function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "props" in node) {
    const el = node as El;
    if (typeof el.type === "function") return text((el.type as (props: Props) => unknown)(el.props));
    return text(el.props.children);
  }
  return "";
}

const PAYOUT_CONTROL = /^(Approve accrual|Mark as paid|Void accrual|Confirm paid|Confirm void)$/;

async function main() {
  const React = ReactStub;
  stub("react", React);
  (globalThis as unknown as { React: unknown }).React = React;
  stub("next/link", {
    __esModule: true,
    default: (props: Props) => React.createElement("a", props),
  });
  const { CommissionPortal } = await import("../app/commissions/CommissionPortal");
  const input = JSON.parse(await readStdin()) as { initial: unknown; afterPayout: unknown; paidRowId: string };

  const render = (): El => {
    cursor = 0;
    return (CommissionPortal as unknown as (props: Props) => El)({ initial: input.initial });
  };
  const article = (tree: El, id: string) => elements(tree).find((el) => el.type === "article" && el.props.key === id);
  const button = (root: El | undefined, wanted: RegExp) =>
    elements(root).find((el) => el.type === "button" && wanted.test(text(el).trim()));
  const click = (el: El | undefined, what: string) => {
    if (!el) throw new Error(`no ${what} on screen`);
    (el.props.onClick as () => void)();
  };
  const steps: Array<Record<string, unknown>> = [];
  const look = (label: string) => {
    const tree = render();
    const row = article(tree, input.paidRowId);
    const badge = elements(row).find((el) => el.type === "span" && String(el.props.className ?? "").includes("rounded-full border"));
    steps.push({
      label,
      paidRowStatus: badge ? text(badge).trim() : null,
      refreshDisabled: Boolean(button(tree, /^Refresh$/)?.props.disabled),
      payoutControls: elements(tree)
        .filter((el) => el.type === "button" && PAYOUT_CONTROL.test(text(el).trim()))
        .map((el) => ({ text: text(el).trim(), disabled: Boolean(el.props.disabled) })),
      screen: text(tree).replace(/\s+/g, " ").trim(),
    });
    return tree;
  };

  let tree = look("opened");
  // 1. Open the paid form on the approved entry and type the reference.
  click(button(article(tree, input.paidRowId), /^Mark as paid$/), "Mark as paid");
  tree = render();
  const field = elements(article(tree, input.paidRowId)).find((el) => el.type === "input");
  if (!field) throw new Error("no payout reference field");
  (field.props.onChange as (event: unknown) => void)({ target: { value: "eTransfer-2026-10-02-0001" } });
  tree = render();
  // 2. Confirm: the payout is being saved (its answer is held).
  click(button(article(tree, input.paidRowId), /^Confirm paid$/), "Confirm paid");
  await flush();
  tree = look("saving the payout");
  // 3. Refresh while the save is in flight: a read from before the payout.
  click(button(tree, /^Refresh$/), "Refresh");
  await flush();
  look("refresh in flight");
  // 4. The save succeeds; the portal starts its own re-read.
  calls[0].respond(200, { ok: true, data: { ok: true } });
  await flush();
  look("payout saved, its re-read in flight");
  // 5. The re-read after the payout answers first.
  calls[2].respond(200, input.afterPayout);
  await flush();
  look("re-read after the payout answered");
  // 6. The Refresh from before the payout answers LAST.
  calls[1].respond(200, input.initial);
  await flush();
  look("older refresh answered last");

  process.stdout.write(JSON.stringify({ methods: calls.map((call) => call.method), steps }));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
