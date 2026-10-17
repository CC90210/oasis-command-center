/**
 * The full-React half of tests/library-review.test.ts.
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`,
 * where react-dom/server does not resolve and React has no useState, so the
 * hook comparison and the verdict buttons (client components) cannot be drawn
 * there. The test spawns this with plain `node --import tsx` and this prints
 * what it saw as JSON on stdout. It asserts nothing: every assertion lives in
 * the .test.ts. (Same arrangement as tests/library-phone-preview.render.ts.)
 *
 * Two things are drawn:
 *   - HookCompare and AssetActions to static markup, for the cases that are
 *     only about what is on the screen;
 *   - AssetActions DRIVEN through its states (driver() below): the note box
 *     opening, Send back refusing an empty note, the request the button makes,
 *     a refusal keeping the note, a success sending the asset to draft, and the
 *     Delete button asking first. There is no DOM in this toolchain, so the
 *     driver stands in for the reconciler: render() is a frame, a handler is
 *     called with the props the tree gave it, and the next render() shows what
 *     it did.
 */
import { dirname } from "node:path";
import type { ReactElement } from "react";

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

type El = ReactElement<Record<string, unknown>>;

/**
 * One component driven through frames with its own hooks kept between them.
 * Knows useState, useRef, useId and useTransition (the work runs at once);
 * anything else fails loudly here instead of being faked.
 */
function driver<P>(component: (props: P) => unknown) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the CJS object whose dispatcher slot react's hooks read
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
    useRef(initial: unknown) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = { current: initial };
      return slots[at];
    },
    useId() {
      const at = cursor++;
      return `:id${at}:`;
    },
    useTransition() {
      cursor++;
      return [false, (work: () => unknown) => work()];
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
  };
}

/** Every element in a tree, depth first (children only). */
function all(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) all(child, out);
    return out;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return out;
  const el = node as El;
  out.push(el);
  return all(el.props.children, out);
}

/** The text an element draws, flattened. */
function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  return textOf((node as El).props.children);
}

function buttonsOf(tree: El) {
  return all(tree).filter((e) => e.type === "button");
}

async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  let refreshes = 0;
  stub("next/navigation", {
    useRouter: () => ({ push: () => undefined, refresh: () => { refreshes += 1; }, prefetch: () => undefined, replace: () => undefined }),
    usePathname: () => "/founders/marketing/library",
    useSearchParams: () => new URLSearchParams(),
  });
  stub("next/link", {
    __esModule: true,
    default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; prefetch?: boolean; children?: unknown }) =>
      React.createElement("a", { href, ...rest }, children as React.ReactNode),
  });
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { HookCompare } = await import("../components/founders/HookCompare");
  const { AssetActions } = await import("../components/founders/AssetActions");
  const { hookVariantCards } = await import("../lib/founders/library-meta");

  // -- the hook comparison, drawn ------------------------------------------------
  const tile = (id: string, status: string, variant: string | null, extra: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
    asset: {
      id,
      title: `Cut ${id}`,
      status,
      hook: `Column hook of ${id}`,
      published_at: null,
      duration_s: 25,
      meta: { icp_segment: "icp_sales_bottleneck", pack_id: "icp_sales_bottleneck_b2b-operator_leads-left-waiting", ...(variant ? { hook_variant: variant } : {}), ...meta },
    },
    playbackUrl: `https://media.test/${id}.mp4`,
    posterUrl: `https://media.test/${id}.jpg`,
    ...extra,
  });
  // Handed over NEWEST FIRST and out of order, as the Library reads them.
  const cards = hookVariantCards(
    [
      tile("v3", "in_review", "variant_3", {}, { hook: "Third opening", hook_style: "question" }),
      tile("v1", "in_review", "variant_1", {}, { hook: "First opening", hook_style: "pattern_interrupt", offer_slug: "fleet", burned_captions: true }),
      tile("v2", "approved", "variant_2", { playbackUrl: null }, { hook: "Second opening" }),
      tile("vx", "in_review", null, {}, {}),
    ],
    (id) => `/founders/marketing/asset/${id}?from=%2Ffounders%2Fmarketing%2Flibrary`,
  );
  const compare = () =>
    renderToStaticMarkup(React.createElement(HookCompare, { heading: "b2b operator - leads left waiting - 4 variants", cards }));

  // -- the verdict buttons, drawn ------------------------------------------------
  const actions = (status: string) =>
    renderToStaticMarkup(React.createElement(AssetActions, { id: "a1", status, title: "Cut a1" } as Parameters<typeof AssetActions>[0]));

  // -- the verdict buttons, driven -----------------------------------------------
  type Call = { url: string; method: string | null; body: unknown };
  const calls: Call[] = [];
  const replies: Array<() => { ok: boolean; status: number; json: () => Promise<unknown> }> = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method ?? null, body: init?.body ? JSON.parse(init.body) : null });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return next();
  };
  const reply = (ok: boolean, body: unknown) => replies.push(() => ({ ok, status: ok ? 200 : 400, json: async () => body }));
  const snapshot = (tree: El) => ({
    buttons: buttonsOf(tree).map((b) => ({ text: textOf(b).trim(), disabled: b.props.disabled === true })),
    text: textOf(tree).replace(/\s+/g, " ").trim(),
    textarea: all(tree).filter((e) => e.type === "textarea").map((e) => ({ value: e.props.value, maxLength: e.props.maxLength, disabled: e.props.disabled === true })),
  });
  const press = async (tree: El, label: string) => {
    const b = buttonsOf(tree).find((x) => textOf(x).trim() === label);
    if (!b) throw new Error(`no button "${label}" in: ${snapshot(tree).text}`);
    await (b.props.onClick as () => unknown)();
  };
  const type = (tree: El, value: string) => {
    const t = all(tree).find((e) => e.type === "textarea");
    if (!t) throw new Error("no textarea");
    (t.props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
  };

  const props = { id: "a1", status: "in_review", title: "Cut a1" } as Parameters<typeof AssetActions>[0];
  const flow: Record<string, unknown> = {};

  // Request changes: the note box, refusing words-less sends, the request, the result.
  {
    const d = driver(AssetActions);
    flow.start = snapshot(d.render(props));
    await press(d.render(props), "Request changes");
    flow.composer = snapshot(d.render(props));
    // Whitespace is not a note.
    type(d.render(props), "   \n  ");
    flow.blank = snapshot(d.render(props));
    const callsBeforeBlank = calls.length;
    await press(d.render(props), "Send back");
    flow.blankSendMadeARequest = calls.length !== callsBeforeBlank;
    flow.blankSendError = snapshot(d.render(props)).text;
    // A refused request keeps the words.
    type(d.render(props), "  The first three seconds are too slow.  ");
    reply(false, { ok: false, error: "not_in_review" });
    await press(d.render(props), "Send back");
    flow.refused = snapshot(d.render(props));
    // A request that goes through.
    reply(true, { ok: true });
    await press(d.render(props), "Send back");
    flow.sent = snapshot(d.render(props));
    flow.refreshes = refreshes;
  }
  flow.requestCalls = calls.map((c) => ({ ...c }));
  calls.length = 0;

  // Sent back, then approved from the same tile. The tile is a draft now and Approve is still an
  // ordinary verdict button: it sends the status and nothing else (the server closes the open
  // request for changes), the "Sent back" notice goes, and the tile reads Approved.
  {
    const d = driver(AssetActions);
    await press(d.render(props), "Request changes");
    type(d.render(props), "Too slow.");
    reply(true, { ok: true });
    await press(d.render(props), "Send back");
    flow.sentBackThenApproveBefore = snapshot(d.render(props));
    calls.length = 0;
    reply(true, { ok: true });
    await press(d.render(props), "Approve");
    flow.sentBackThenApprove = { calls: calls.map((c) => ({ ...c })), after: snapshot(d.render(props)) };
    calls.length = 0;
  }

  // A tile whose asset is not waiting on a verdict (a draft): no such button.
  {
    const d = driver(AssetActions);
    flow.draftTile = snapshot(d.render({ ...props, status: "draft" }));
  }

  // Delete asks first, inside the tile; Keep puts it back; only the second press sends it.
  {
    const d = driver(AssetActions);
    await press(d.render(props), "Delete");
    flow.deleteAsk = snapshot(d.render(props));
    flow.deleteAskMadeARequest = calls.length > 0;
    await press(d.render(props), "Keep");
    flow.deleteKept = snapshot(d.render(props));
    flow.deleteKeptMadeARequest = calls.length > 0;
    await press(d.render(props), "Delete");
    reply(true, { ok: true });
    await press(d.render(props), "Delete for good");
    flow.deleteDone = snapshot(d.render(props));
    flow.deleteCalls = calls.map((c) => ({ ...c }));
    calls.length = 0;
  }

  // Approve sends the status and nothing else.
  {
    const d = driver(AssetActions);
    reply(true, { ok: true });
    await press(d.render(props), "Approve");
    flow.approveCalls = calls.map((c) => ({ ...c }));
    flow.approveAfter = snapshot(d.render(props));
    calls.length = 0;
  }

  // -- the hook comparison, DRIVEN -----------------------------------------------
  // Fake <video> elements the component's ref callbacks are handed, the way React
  // attaches them: each render detaches the old callback (null) and attaches the
  // new one, and a card that left the page gets its callback called with null.
  function fakeClip(log: string[], id: string, rejectPlay: boolean) {
    return {
      paused: true,
      muted: false,
      currentTime: 0,
      play() {
        log.push(`play ${id}${this.muted ? " muted" : ""}`);
        if (rejectPlay) return Promise.reject(new Error("autoplay refused"));
        this.paused = false;
        return Promise.resolve();
      },
      pause() {
        if (!this.paused) log.push(`pause ${id}`);
        this.paused = true;
      },
      scrollIntoView() {},
    };
  }
  type CardList = ReturnType<typeof hookVariantCards>;
  const cardsOf = (ids: string[], noVideo: string[] = []): CardList =>
    hookVariantCards(
      ids.map((id) => tile(id, "in_review", `variant_${id.slice(1)}`, noVideo.includes(id) ? { playbackUrl: null } : {}, { hook: `Opening of ${id}` })),
      (id) => `/founders/marketing/asset/${id}`,
    );
  function rig(initial: CardList, rejectPlay: string[] = []) {
    const log: string[] = [];
    const clips = new Map<string, ReturnType<typeof fakeClip>>();
    const mounted = new Map<string, (el: unknown) => void>();
    const d = driver(HookCompare);
    let current = initial;
    let tree: El = d.render({ heading: "pack", cards: current } as Parameters<typeof HookCompare>[0]);
    const videoEls = () => all(tree).filter((e) => e.type === "video");
    const idOf = (e: El) => String(e.props.src).replace(/^.*\/([^/]+)\.mp4$/, "$1");
    /** One frame, then what React does with the refs after it. */
    function show(next?: CardList): El {
      if (next) current = next;
      tree = d.render({ heading: "pack", cards: current } as Parameters<typeof HookCompare>[0]);
      const present = new Set<string>();
      for (const v of videoEls()) {
        const id = idOf(v);
        present.add(id);
        const ref = v.props.ref as (el: unknown) => void;
        if (!clips.has(id)) clips.set(id, fakeClip(log, id, rejectPlay.includes(id)));
        mounted.get(id)?.(null);
        ref(clips.get(id));
        mounted.set(id, ref);
      }
      for (const [id, ref] of [...mounted]) {
        if (!present.has(id)) {
          ref(null);
          mounted.delete(id);
        }
      }
      return tree;
    }
    show();
    const press = (label: string) => {
      const b = buttonsOf(tree).find((x) => textOf(x).trim() === label);
      if (!b) throw new Error(`no button "${label}"`);
      (b.props.onClick as () => unknown)();
      return show();
    };
    const ended = (id: string) => {
      const v = videoEls().find((e) => idOf(e) === id);
      if (!v) throw new Error(`no video ${id}`);
      // A media element that has ended is paused, as in a browser.
      const clip = clips.get(id);
      if (clip) clip.paused = true;
      (v.props.onEnded as () => unknown)();
      return show();
    };
    const snap = () => {
      const buttons = buttonsOf(tree);
      const pressed = (label: string) => buttons.find((x) => textOf(x).trim() === label)?.props["aria-pressed"] === true;
      const status = all(tree).find((e) => e.type === "span" && e.props.role === "status");
      return {
        status: status ? textOf(status).trim() : null,
        stop: buttons.some((x) => textOf(x).trim() === "Stop"),
        together: pressed("Play all together"),
        order: pressed("Play one after another"),
        videos: videoEls().map(idOf),
        log: log.splice(0),
      };
    };
    return { show, press, ended, snap };
  }
  const hook: Record<string, unknown> = {};

  // A sequence, and a card that is NOT the playing one leaves (Delete, Archive): the position follows the card.
  {
    const r = rig(cardsOf(["v1", "v2", "v3", "v4"]));
    r.press("Play one after another");
    hook.seqStart = r.snap();
    r.show(cardsOf(["v1", "v2", "v4"]));
    hook.seqAfterLaterCardLeft = r.snap();
    r.ended("v1");
    hook.seqSecond = r.snap();
    r.show(cardsOf(["v2", "v4"]));
    hook.seqAfterEarlierCardLeft = r.snap();
    r.ended("v2");
    hook.seqLast = r.snap();
    r.ended("v4");
    hook.seqDone = r.snap();
  }
  // The PLAYING card leaves: the sequence is over, nothing throws, nothing points past the end.
  {
    const r = rig(cardsOf(["v1", "v2", "v3", "v4"]));
    r.press("Play one after another");
    r.ended("v1");
    hook.gonePlaying = r.snap();
    let threw: string | null = null;
    try {
      r.show(cardsOf(["v1", "v3", "v4"]));
    } catch (e) {
      threw = (e as Error).message;
    }
    hook.goneAfter = { threw, ...r.snap() };
    // ...and it can start again from the top.
    r.press("Play one after another");
    hook.goneRestart = r.snap();
  }
  // The LAST card plays and leaves (its position is now past the end of the list).
  {
    const r = rig(cardsOf(["v1", "v2"]));
    r.press("Play one after another");
    r.ended("v1");
    r.snap();
    let threw: string | null = null;
    try {
      r.show(cardsOf(["v1"]));
    } catch (e) {
      threw = (e as Error).message;
    }
    hook.lastGone = { threw, ...r.snap() };
  }
  // A sequence skips a card with no video, and ends after the last one.
  {
    const r = rig(cardsOf(["v1", "v2", "v3"], ["v2"]));
    r.press("Play one after another");
    r.snap();
    r.ended("v1");
    hook.skipsNoVideo = r.snap();
    r.ended("v3");
    hook.skipEnd = r.snap();
  }

  // "Play all together": over when every clip has ended.
  {
    const r = rig(cardsOf(["v1", "v2", "v3", "v4"], ["v4"]));
    r.press("Play all together");
    hook.togetherStart = r.snap();
    r.ended("v1");
    r.ended("v2");
    hook.togetherTwoEnded = r.snap();
    r.ended("v3");
    hook.togetherAllEnded = r.snap();
    // Pressed again, it plays again.
    r.press("Play all together");
    hook.togetherAgain = r.snap();
    r.press("Stop");
    hook.togetherStopped = r.snap();
  }
  // One clip refuses to play (autoplay policy, a dead URL): it counts as done, so the others can finish it.
  {
    const r = rig(cardsOf(["v1", "v2", "v3"]), ["v2"]);
    r.press("Play all together");
    await Promise.resolve();
    await Promise.resolve();
    r.show();
    hook.refusedStart = r.snap();
    r.ended("v1");
    r.ended("v3");
    hook.refusedEnd = r.snap();
  }
  // A clip's card leaves while the rest play: the rest are what it waits for.
  {
    const r = rig(cardsOf(["v1", "v2", "v3"]));
    r.press("Play all together");
    r.snap();
    r.show(cardsOf(["v1", "v2"]));
    hook.togetherCardLeft = r.snap();
    r.ended("v1");
    r.ended("v2");
    hook.togetherCardLeftEnd = r.snap();
  }
  // Every clip's card leaves while "all together" plays.
  {
    const r = rig(cardsOf(["v1", "v2"]));
    r.press("Play all together");
    r.snap();
    let threw: string | null = null;
    try {
      r.show(cardsOf([]));
    } catch (e) {
      threw = (e as Error).message;
    }
    hook.togetherEmpty = { threw, ...r.snap() };
  }

  const out = {
    compare: compare(),
    compareNote: renderToStaticMarkup(
      React.createElement(HookCompare, { heading: "pack - first 4 of 9 variants", cards, note: "Showing the first 4 of 9 variants in this pack, newest first." }),
    ),
    cards,
    hook,
    actions: {
      inReview: actions("in_review"),
      approved: actions("approved"),
      draft: actions("draft"),
      archived: actions("archived"),
    },
    flow,
  };
  console.log(JSON.stringify(out));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
