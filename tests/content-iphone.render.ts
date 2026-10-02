/**
 * The full-React half of tests/content-iphone.test.ts: the big iPhone, drawn
 * and driven. It asserts nothing; it prints what happened as JSON.
 *
 * Same split as tests/library-phone-preview.render.ts and for the same reason:
 * the suite runs under the react-server condition, where React has no hooks
 * and react-dom/server does not resolve, so the client components are drawn
 * here, in a plain `node --import tsx`.
 *
 * DRIVEN, FRAME BY FRAME. There is no DOM in this toolchain, so driver() stands
 * in for the reconciler (as in library-phone-preview.render.ts, plus the hooks
 * PhoneEnlarge uses): render() is a frame, effects() is the commit after it -
 * cleanups first, as React runs them - and what render() returns is drawn by
 * real React (renderToStaticMarkup), the big phone's portal included. A small
 * fake DOM (FakeElement, window listeners, document.body) records what the
 * components ask of it: focus(), pause(), play(), the keydown listener, the
 * body's overflow.
 */
import { dirname } from "node:path";
import type { ReactElement, ReactNode } from "react";

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

type El = ReactElement<Record<string, unknown>>;

/** One component through frames, with its own hooks kept between them. */
function driver<P>(component: (props: P) => unknown, contexts: Map<unknown, unknown> = new Map()) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the CJS object whose dispatcher slot react's hooks read
  const internals = (require("react") as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const slots: unknown[] = [];
  const deps: Array<unknown[] | undefined> = [];
  const cleanups: Array<(() => void) | undefined> = [];
  let queued: Array<{ at: number; effect: () => unknown }> = [];
  let cursor = 0;
  const changed = (at: number, next?: unknown[]) => {
    const prev = deps[at];
    return !(at in deps) || !next || !prev || next.length !== prev.length || next.some((d, i) => !Object.is(d, prev[i]));
  };
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
    useMemo(factory: () => unknown, next?: unknown[]) {
      const at = cursor++;
      if (!(at in slots) || changed(at, next)) {
        slots[at] = factory();
        deps[at] = next;
      }
      return slots[at];
    },
    useCallback(fn: unknown, next?: unknown[]) {
      return dispatcher.useMemo(() => fn, next);
    },
    useEffect(effect: () => unknown, next?: unknown[]) {
      const at = cursor++;
      if (changed(at, next)) queued.push({ at, effect });
      deps[at] = next;
    },
    useContext(context: { _currentValue: unknown }) {
      return contexts.has(context) ? contexts.get(context) : context._currentValue;
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
    /** The commit: each effect that re-runs has its last cleanup run first. */
    effects() {
      const run = queued;
      queued = [];
      for (const { at, effect } of run) {
        cleanups[at]?.();
        const c = effect();
        cleanups[at] = typeof c === "function" ? (c as () => void) : undefined;
      }
    },
  };
}

/** Depth-first through children (and a portal's children); null when nothing matches. */
function find(node: unknown, match: (el: El) => boolean): El | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, match);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if ((node as { $$typeof?: symbol }).$$typeof === Symbol.for("react.portal")) {
    return find((node as { children?: unknown }).children, match);
  }
  if (!("props" in node)) return null;
  const el = node as El;
  if (match(el)) return el;
  return find(el.props.children, match);
}

function must(node: unknown, what: string, match: (el: El) => boolean): El {
  const hit = find(node, match);
  if (!hit) throw new Error(`render: ${what} not found`);
  return hit;
}

/** The big phone's portal in a PhoneEnlarge frame, or null when it is closed. */
function portalOf(node: unknown): { children: unknown; containerInfo: unknown } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = portalOf(child);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if ((node as { $$typeof?: symbol }).$$typeof === Symbol.for("react.portal")) {
    return node as { children: unknown; containerInfo: unknown };
  }
  if (!("props" in node)) return null;
  return portalOf((node as El).props.children);
}

// -- a small DOM ------------------------------------------------------------
const listeners = new Map<string, Array<(e: unknown) => void>>();
const fakeDocument: { activeElement: unknown; body: unknown } = { activeElement: null, body: null };

class FakeElement {
  calls: string[] = [];
  nodeType = 1;
  isConnected = true;
  style: Record<string, string> = {};
  constructor(public name: string) {}
  focus() {
    this.calls.push("focus");
    fakeDocument.activeElement = this;
  }
}

/** The dialog: what Tab cycles through, and what is inside it. */
class FakePanel extends FakeElement {
  focusables: FakeElement[] = [];
  querySelectorAll() {
    return this.focusables;
  }
  contains(x: unknown) {
    return this.focusables.includes(x as FakeElement);
  }
}

/** The media element behind a TileVideo's ref, or the one playing in place. */
function fakeMedia(name: string, calls: string[], playing = false, at = 0) {
  return {
    name,
    paused: !playing,
    muted: false,
    currentTime: at,
    play() {
      calls.push("play");
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      calls.push("pause");
      this.paused = true;
    },
  };
}

function key(k: string, shiftKey = false) {
  const e = { key: k, shiftKey, prevented: false, preventDefault() { this.prevented = true; } };
  for (const fn of listeners.get("keydown") ?? []) fn(e);
  return e;
}

async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  stub("next/navigation", {
    useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined, replace: () => undefined }),
    usePathname: () => "/founders/marketing/library",
    useSearchParams: () => new URLSearchParams(),
  });
  stub("next/link", {
    __esModule: true,
    default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; prefetch?: boolean; children?: unknown }) =>
      React.createElement("a", { href, ...rest }, children as React.ReactNode),
  });
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AssetTile } = await import("../components/founders/marketing-shared");
  const { PhoneEnlarge, EnlargeButton, enlargeSlotContext, BIG_PHONE_WIDTH } = await import("../components/founders/PhoneEnlarge");
  const { TileVideo } = await import("../components/founders/TileVideo");
  const draw = (node: unknown) => renderToStaticMarkup(node as El);
  const Slot = enlargeSlotContext();

  // -- 1. the tiles, both presentations, every kind --------------------------
  const base = {
    id: "a1",
    title: "Asset title",
    brandName: "OASIS AI",
    channel: "organic-instagram",
    status: "in_review",
    publishedAt: null,
    hook: "The hook line",
    durationS: 32,
    platforms: '["instagram"]',
    openReviews: 0,
  };
  const KINDS: Record<string, Record<string, unknown>> = {
    videoPoster: { format: "video", assetType: "video", aspect: "9:16", playbackUrl: "https://media.test/reel.mp4", posterUrl: "https://media.test/poster.jpg", mediaW: 1080, mediaH: 1920 },
    videoBare: { format: "video", assetType: "video", aspect: "9:16", playbackUrl: "https://media.test/reel.mp4", posterUrl: null, mediaW: 1080, mediaH: 1920 },
    carousel: {
      format: "image", assetType: "carousel", aspect: "4:5", mediaW: 1080, mediaH: 1350,
      posterUrl: "https://media.test/slide_1.png",
      slideUrls: ["https://media.test/slide_1.png", "https://media.test/slide_2.png", "https://media.test/slide_3.png"],
    },
    image: { format: "image", assetType: "single_image", aspect: "1:1", posterUrl: "https://media.test/card.png", mediaW: 1080, mediaH: 1080 },
    copy: { format: "copy", assetType: "single_image", aspect: null, hook: "A caption drafted in chat" },
  };
  const tiles: Record<string, string> = {};
  for (const [kind, props] of Object.entries(KINDS)) {
    for (const presentation of ["phone", "grid"] as const) {
      tiles[`${kind}:${presentation}`] = draw(
        React.createElement(AssetTile, { ...base, ...props, presentation } as unknown as Parameters<typeof AssetTile>[0]),
      );
    }
  }

  // The fake DOM goes in only now: react-dom and the components are loaded,
  // so nothing above saw it.
  const body = new FakeElement("body");
  fakeDocument.body = body;
  Object.assign(globalThis, {
    HTMLElement: FakeElement,
    document: fakeDocument,
    window: {
      addEventListener(type: string, fn: (e: unknown) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
      removeEventListener(type: string, fn: (e: unknown) => void) {
        listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
      },
    },
  });

  // -- 2. Enlarge, by keyboard: open, trap, Esc, focus back ------------------
  const reel = React.createElement(TileVideo, {
    src: "https://media.test/reel.mp4", posterUrl: null, width: 1080, height: 1920, title: "Asset title", variant: "phone",
  });
  const shape = { mediaW: 1080, mediaH: 1920, aspect: "9:16", handle: "OASIS AI", caption: "The hook line", chrome: "instagram" as const };
  const enlargeProps = {
    title: "Asset title",
    frame: shape,
    media: reel,
    children: React.createElement(EnlargeButton, { title: "Asset title" }),
  };
  const pe = driver(PhoneEnlarge);
  let frame = pe.render(enlargeProps);
  pe.effects();
  const closedMarkup = draw(frame);
  const closedPortal = portalOf(frame) !== null;
  const tileSlot = must(frame, "the tile slot's provider", (el) => el.type === Slot).props.value as {
    place: string;
    enlarge: (s: { play: boolean; at: number }, opener?: unknown) => void;
  };

  // The viewer tabs to Enlarge and presses Enter, which a <button> turns into
  // a click: EnlargeButton's own handler, driven in that slot.
  const trigger = new FakeElement("enlarge-button");
  fakeDocument.activeElement = trigger;
  const button = driver(EnlargeButton, new Map([[Slot, tileSlot]]));
  const buttonEl = must(button.render({ title: "Asset title" }), "the Enlarge button", (el) => el.type === "button");
  (buttonEl.props.onClick as (e: unknown) => void)({ currentTarget: trigger });

  frame = pe.render(enlargeProps);
  const portal = portalOf(frame);
  if (!portal) throw new Error("render: Enlarge did not open the big phone");
  const openMarkup = draw(portal.children);
  const bigSlot = must(portal.children, "the big phone's provider", (el) => el.type === Slot).props.value;
  // What React would attach to the refs on commit.
  const dialogEl = must(portal.children, "the dialog", (el) => el.props.role === "dialog");
  const closeEl = must(portal.children, "Close", (el) => el.type === "button" && el.props["aria-label"] === "Close");
  const panel = new FakePanel("dialog");
  const close = new FakeElement("close");
  const play = new FakeElement("play");
  panel.focusables = [close, play];
  (dialogEl.props.ref as { current: unknown }).current = panel;
  (closeEl.props.ref as { current: unknown }).current = close;
  pe.effects();
  const afterOpen = {
    focused: (fakeDocument.activeElement as FakeElement | null)?.name ?? null,
    bodyOverflow: (body.style.overflow as string | undefined) ?? "",
    keydownListeners: (listeners.get("keydown") ?? []).length,
    container: portal.containerInfo === body,
  };
  // Tab on the last control wraps to the first; Shift+Tab on the first wraps to the last.
  fakeDocument.activeElement = play;
  const tab = key("Tab");
  const tabLanded = (fakeDocument.activeElement as FakeElement).name;
  const shiftTab = key("Tab", true);
  const shiftTabLanded = (fakeDocument.activeElement as FakeElement).name;
  // Focus somewhere outside the dialog is pulled back in.
  fakeDocument.activeElement = new FakeElement("page-behind");
  const strayTab = key("Tab");
  const strayLanded = (fakeDocument.activeElement as FakeElement).name;
  // Esc closes it.
  const esc = key("Escape");
  frame = pe.render(enlargeProps);
  const openAfterEsc = portalOf(frame) !== null;
  pe.effects();
  const afterClose = {
    triggerCalls: [...trigger.calls],
    focused: (fakeDocument.activeElement as FakeElement | null)?.name ?? null,
    bodyOverflow: (body.style.overflow as string | undefined) ?? "",
    keydownListeners: (listeners.get("keydown") ?? []).length,
  };

  // -- 3. a click outside the phone closes it; a click on it does not --------
  tileSlot.enlarge({ play: false, at: 0 }, trigger);
  frame = pe.render(enlargeProps);
  pe.effects();
  const dialog2 = must(portalOf(frame)!.children, "the dialog", (el) => el.props.role === "dialog");
  const onBackdrop = dialog2.props.onClick as (e: unknown) => void;
  const phoneNode = { name: "phone" };
  onBackdrop({ target: phoneNode, currentTarget: panel });
  frame = pe.render(enlargeProps);
  const openAfterPhoneClick = portalOf(frame) !== null;
  onBackdrop({ target: panel, currentTarget: panel });
  frame = pe.render(enlargeProps);
  const openAfterBackdropClick = portalOf(frame) !== null;
  pe.effects();
  // Close, the button.
  tileSlot.enlarge({ play: false, at: 0 }, trigger);
  frame = pe.render(enlargeProps);
  pe.effects();
  const closeButton = must(portalOf(frame)!.children, "Close", (el) => el.type === "button" && el.props["aria-label"] === "Close");
  (closeButton.props.onClick as () => void)();
  frame = pe.render(enlargeProps);
  const openAfterCloseButton = portalOf(frame) !== null;
  pe.effects();

  // -- 3b. a carousel and a single image open big too ------------------------
  // The tile's own media element, as AssetTile hands it over: Enlarge opens the
  // big phone with the deck at its real 4:5 shape (one slide loaded, the rest
  // on demand) and the 1:1 card letterboxed.
  const { CarouselFrame } = await import("../components/founders/CarouselFrame");
  const openBig = (media: ReactNode, shapeOver: Partial<typeof shape>) => {
    const d = driver(PhoneEnlarge);
    const props = { ...enlargeProps, frame: { ...shape, ...shapeOver }, media };
    const first = d.render(props);
    (must(first, "the tile slot's provider", (el) => el.type === Slot).props.value as typeof tileSlot).enlarge({ play: false, at: 0 }, trigger);
    const open = portalOf(d.render(props));
    if (!open) throw new Error("render: Enlarge did not open the big phone");
    return draw(open.children);
  };
  const carouselBig = openBig(
    React.createElement(CarouselFrame, {
      slides: ["https://media.test/slide_1.png", "https://media.test/slide_2.png", "https://media.test/slide_3.png"],
      title: "Asset title", width: 1080, height: 1350, className: "h-full w-full",
    }),
    { mediaW: 1080, mediaH: 1350, aspect: "4:5" },
  );
  const imageBig = openBig(
    React.createElement("img", { src: "https://media.test/card.png", alt: "", loading: "lazy", decoding: "async", width: 1080, height: 1080, className: "h-full w-full object-contain" }),
    { mediaW: 1080, mediaH: 1080, aspect: "1:1" },
  );

  // -- 4. a video playing in place carries on in the big phone ---------------
  const inlineCalls: string[] = [];
  const playingInPlace = fakeMedia("inline-video", inlineCalls, true, 12.5);
  const handover = driver(PhoneEnlarge);
  let h = handover.render(enlargeProps);
  const inlineDiv = must(h, "the in-place wrapper", (el) => el.type === "div");
  (inlineDiv.props.ref as { current: unknown }).current = { querySelector: (sel: string) => (sel === "video" ? playingInPlace : null) };
  const handoverSlot = must(h, "the tile slot's provider", (el) => el.type === Slot).props.value as typeof tileSlot;
  handoverSlot.enlarge({ play: false, at: 0 }, trigger);
  h = handover.render(enlargeProps);
  const handoverStart = (must(portalOf(h)!.children, "the big phone's provider", (el) => el.type === Slot).props.value as { start: unknown }).start;
  // ...and one paused part-way opens at that second, not playing.
  const pausedCalls: string[] = [];
  const pausedInPlace = fakeMedia("paused-video", pausedCalls, false, 9);
  const handover2 = driver(PhoneEnlarge);
  let h2 = handover2.render(enlargeProps);
  (must(h2, "the in-place wrapper", (el) => el.type === "div").props.ref as { current: unknown }).current = {
    querySelector: (sel: string) => (sel === "video" ? pausedInPlace : null),
  };
  (must(h2, "the tile slot's provider", (el) => el.type === Slot).props.value as typeof tileSlot).enlarge({ play: false, at: 0 }, trigger);
  h2 = handover2.render(enlargeProps);
  const pausedStart = (must(portalOf(h2)!.children, "the big phone's provider", (el) => el.type === Slot).props.value as { start: unknown }).start;

  // -- 5. TileVideo in each slot ---------------------------------------------
  const tileProps = { src: "https://media.test/reel.mp4", posterUrl: null, width: 1080, height: 1920, title: "Asset title", variant: "phone" as const };
  // In a tile: pressing the cover opens the big phone, playing; nothing mounts here.
  const asked: Array<{ start: unknown; opener: string | null }> = [];
  const fakeTile = {
    place: "tile",
    enlarge: (start: unknown, opener?: { name?: string } | null) => asked.push({ start, opener: opener?.name ?? null }),
  };
  const inTile = driver(TileVideo, new Map([[Slot, fakeTile]]));
  let f = inTile.render(tileProps);
  inTile.effects();
  const tileMount = draw(f);
  const cover = new FakeElement("cover");
  (must(f, "the cover", (el) => el.type === "button").props.onClick as (e: unknown) => void)({ currentTarget: cover });
  f = inTile.render(tileProps);
  inTile.effects();
  const tileAfterPress = draw(f);

  // In the big phone, opened by that play press: the player is there and plays.
  const bigPlayCalls: string[] = [];
  const bigPlay = driver(TileVideo, new Map([[Slot, { place: "big", start: { play: true, at: 0 } }]]));
  f = bigPlay.render(tileProps);
  const bigPlayMount = draw(f);
  (must(f, "the big phone's <video>", (el) => el.type === "video").props.ref as { current: unknown }).current = fakeMedia("big", bigPlayCalls);
  bigPlay.effects();

  // In the big phone, opened by Enlarge: a cover until play is pressed.
  const bigCoverCalls: string[] = [];
  const bigCover = driver(TileVideo, new Map([[Slot, { place: "big", start: { play: false, at: 0 } }]]));
  f = bigCover.render(tileProps);
  bigCover.effects();
  const bigCoverMount = draw(f);
  const bigCoverCallsBeforePress = [...bigCoverCalls];
  (must(f, "the big phone's cover", (el) => el.type === "button").props.onClick as (e: unknown) => void)({ currentTarget: cover });
  f = bigCover.render(tileProps);
  const bigCoverAfterPress = draw(f);
  (must(f, "the big phone's <video>", (el) => el.type === "video").props.ref as { current: unknown }).current = fakeMedia("big-cover", bigCoverCalls);
  bigCover.effects();

  // The asset page's player (initialOpen) in the big phone: carried on from 12.5s, playing...
  const pageCarry: string[] = [];
  const pageMedia = fakeMedia("page-big", pageCarry);
  const pagePlay = driver(TileVideo, new Map([[Slot, { place: "big", start: { play: true, at: 12.5 } }]]));
  f = pagePlay.render({ ...tileProps, initialOpen: true });
  (must(f, "the asset page's big <video>", (el) => el.type === "video").props.ref as { current: unknown }).current = pageMedia;
  pagePlay.effects();
  // ...or opened at 9s, waiting for play.
  const pageWait: string[] = [];
  const pageWaitMedia = fakeMedia("page-wait", pageWait);
  const pageStill = driver(TileVideo, new Map([[Slot, { place: "big", start: { play: false, at: 9 } }]]));
  f = pageStill.render({ ...tileProps, initialOpen: true });
  const pageStillMount = draw(f);
  (must(f, "the asset page's big <video>", (el) => el.type === "video").props.ref as { current: unknown }).current = pageWaitMedia;
  pageStill.effects();

  const out = {
    tiles,
    enlarge: {
      closedMarkup,
      closedPortal,
      openMarkup,
      bigSlot,
      afterOpen,
      tab: { prevented: tab.prevented, landed: tabLanded },
      shiftTab: { prevented: shiftTab.prevented, landed: shiftTabLanded },
      strayTab: { prevented: strayTab.prevented, landed: strayLanded },
      esc: { prevented: esc.prevented, openAfter: openAfterEsc },
      afterClose,
      openAfterPhoneClick,
      openAfterBackdropClick,
      openAfterCloseButton,
      bigPhoneWidth: BIG_PHONE_WIDTH,
      carouselBig,
      imageBig,
    },
    handover: {
      start: handoverStart,
      inlineCalls,
      pausedStart,
      pausedCalls,
    },
    player: {
      tileMount,
      tileAfterPress,
      asked,
      bigPlayMount,
      bigPlayCalls,
      bigCoverMount,
      bigCoverCallsBeforePress,
      bigCoverAfterPress,
      bigCoverCalls,
      pageCarry: { calls: pageCarry, at: pageMedia.currentTime },
      pageStillMount,
      pageWait: { calls: pageWait, at: pageWaitMedia.currentTime },
    },
  };
  process.stdout.write(JSON.stringify(out));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
