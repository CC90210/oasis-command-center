/**
 * The full-React half of tests/library-phone-preview.test.ts.
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`,
 * where react-dom/server does not resolve and React has no useState, so the
 * Library tiles (TileVideo and CarouselFrame are client components) cannot be
 * drawn there. The test spawns this with plain `node --import tsx`, and this
 * prints the markup of every scenario as JSON on stdout.
 *
 * `React` is set on globalThis before any component loads: tsconfig.json sets
 * jsx:"preserve", so tsx compiles the components with the classic runtime.
 * next/navigation and next/link are stood in (no app router is mounted here),
 * as in tests/system-health.render.ts.
 *
 * TileVideo is also DRIVEN, frame by frame (driver() below): mounted, its
 * effects run as hydration would run them, its cover clicked, its media events
 * fired - so the test can see that the <video> mounts on the click and on
 * nothing else, and that the phone player pauses from a real button.
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
 * One component driven through frames with its OWN hooks kept between them, as
 * framesOf() in tests/queries-fail-loud.render.ts does for useState. There is
 * no DOM in this toolchain and renderToStaticMarkup draws one frame and runs no
 * effects, so this stands in for the reconciler: render() is a frame, effects()
 * is the commit after it - what hydration runs once the server markup lands -
 * and what render() returns is drawn by real React. It knows useState, useRef
 * and useEffect (deps compared as React compares them), and useContext, which
 * answers the context's default - no provider: these scenarios are TileVideo
 * outside any big phone (tests/content-iphone.render.ts drives it inside one).
 * Anything else fails loudly here instead of being faked.
 */
function driver<P>(component: (props: P) => unknown) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the CJS object whose dispatcher slot react's hooks read
  const internals = (require("react") as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const slots: unknown[] = [];
  const effectDeps: Array<unknown[] | undefined> = [];
  let queued: Array<() => unknown> = [];
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
    useEffect(effect: () => unknown, deps?: unknown[]) {
      const at = cursor++;
      const prev = effectDeps[at];
      const changed = !(at in effectDeps) || !deps || !prev || deps.length !== prev.length || deps.some((d, i) => !Object.is(d, prev[i]));
      effectDeps[at] = deps;
      if (changed) queued.push(effect);
    },
    useContext(context: { _currentValue: unknown }) {
      return context._currentValue;
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

/** A stand-in for the browser's media element, recording what the player asks of it. */
function fakeMedia(calls: string[]) {
  return {
    paused: true,
    muted: false,
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
  const { PhoneFrame } = await import("../components/founders/PhoneFrame");
  const { AssetTile } = await import("../components/founders/marketing-shared");
  const { TileVideo } = await import("../components/founders/TileVideo");
  const { SlideReorder } = await import("../components/founders/SlideReorder");

  const probe = React.createElement("div", { "data-probe": "media" });
  const frame = (w: number | null, h: number | null, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      React.createElement(
        PhoneFrame,
        { mediaW: w, mediaH: h, handle: "OASIS AI", caption: "Caption from the hook", label: "Test asset", ...extra } as Parameters<typeof PhoneFrame>[0],
        probe,
      ),
    );

  const base = {
    id: "a1",
    title: "Asset title",
    brandName: "OASIS AI",
    channel: "organic-instagram",
    status: "in_review",
    publishedAt: null,
    hook: "The hook line",
    durationS: null,
    platforms: '["instagram"]',
    openReviews: 0,
  };
  const KINDS: Record<string, Record<string, unknown>> = {
    videoPoster: { format: "video", assetType: "video", aspect: "9:16", playbackUrl: "https://media.test/reel.mp4", posterUrl: "https://media.test/poster.jpg", mediaW: 1080, mediaH: 1920 },
    videoBare: { format: "video", assetType: "video", aspect: "9:16", playbackUrl: "https://media.test/reel.mp4", posterUrl: null, mediaW: 1080, mediaH: 1920 },
    carousel: {
      format: "image", assetType: "carousel", aspect: "4:5", mediaW: 1080, mediaH: 1350,
      posterUrl: "https://media.test/slide_1.png",
      slideUrls: ["https://media.test/slide_1.png", "https://media.test/slide_2.png", "https://media.test/slide_3.png", "https://media.test/slide_4.png"],
    },
    image: { format: "image", assetType: "single_image", aspect: "1:1", posterUrl: "https://media.test/card.png", mediaW: 1080, mediaH: 1080 },
    copy: { format: "copy", assetType: "single_image", aspect: null, hook: "A caption drafted in chat" },
    html: { format: "html", assetType: "single_image", aspect: null, hook: "A landing page drafted in chat" },
  };
  const tiles: Record<string, string> = {};
  for (const [kind, props] of Object.entries(KINDS)) {
    for (const presentation of ["grid", "phone"] as const) {
      tiles[`${kind}:${presentation}`] = renderToStaticMarkup(
        React.createElement(AssetTile, { ...base, ...props, presentation } as unknown as Parameters<typeof AssetTile>[0]),
      );
    }
  }

  // A tile's link carries the Library view it sits in, for the asset page's
  // way back.
  tiles["returnTo:phone"] = renderToStaticMarkup(
    React.createElement(AssetTile, {
      ...base,
      ...KINDS.videoPoster,
      presentation: "phone",
      returnTo: "/founders/marketing/library?group=clients&view=grid&page=2",
    } as unknown as Parameters<typeof AssetTile>[0]),
  );

  // ── TileVideo, driven. A phone tile with no poster on file (29 of 37 live
  // videos): mounted, hydrated, then its cover clicked.
  const draw = (el: El) => renderToStaticMarkup(el);
  const tileProps = {
    src: "https://media.test/reel.mp4",
    posterUrl: null,
    width: 1080,
    height: 1920,
    title: "Asset title",
    variant: "phone" as const,
  };
  const tile = driver(TileVideo);
  const player: Record<string, unknown> = {};
  let f = tile.render(tileProps);
  player.mount = draw(f);
  tile.effects(); // hydration's commit
  f = tile.render(tileProps);
  player.afterHydration = draw(f);
  // The viewer presses play on the cover.
  const cover = find(f, "the cover's play button", (el) => el.type === "button" && typeof el.props.onClick === "function");
  (cover.props.onClick as () => void)();
  f = tile.render(tileProps);
  player.afterClick = draw(f);
  // The <video> exists now; the browser's media element stands behind its ref.
  const video = find(f, "the opened <video>", (el) => el.type === "video");
  const calls: string[] = [];
  const media = fakeMedia(calls);
  (video.props.ref as { current: unknown }).current = media;
  tile.effects(); // the commit after the click: the effect starts playback
  player.callsAfterClick = [...calls];
  (video.props.onPlay as () => void)(); // the media element reports it is playing
  f = tile.render(tileProps);
  player.playing = draw(f);
  const toggle = () =>
    find(f, "the play/pause button", (el) => el.type === "button" && /^(Play|Pause) /.test(String(el.props["aria-label"] ?? "")));
  // Keyboard or screen reader: the named button pauses...
  (toggle().props.onClick as () => void)();
  player.callsAfterPause = [...calls];
  (video.props.onPause as () => void)();
  f = tile.render(tileProps);
  player.paused = draw(f);
  // ...and plays again.
  (toggle().props.onClick as () => void)();
  player.callsAfterPlay = [...calls];

  // The asset page's player: open from the start, nothing plays on its own.
  const pageProps = { ...tileProps, initialOpen: true };
  const opened = driver(TileVideo);
  let g = opened.render(pageProps);
  player.openMount = draw(g);
  const openCalls: string[] = [];
  (find(g, "the asset page's <video>", (el) => el.type === "video").props.ref as { current: unknown }).current = fakeMedia(openCalls);
  opened.effects();
  g = opened.render(pageProps);
  player.openAfterHydration = draw(g);
  player.openCalls = openCalls;

  // A plain-grid tile with a poster: still a cover until clicked, then the
  // browser's own player, loading nothing before play.
  const native = driver(TileVideo);
  const nativeProps = { ...tileProps, posterUrl: "https://media.test/poster.jpg", variant: "native" as const };
  let n = native.render(nativeProps);
  native.effects();
  n = native.render(nativeProps);
  player.nativeAfterHydration = draw(n);
  // Drawn rather than thrown when there is no cover to click, so the test's
  // assertion names what went wrong.
  const nativeCover = (() => {
    try {
      return find(n, "the cover", (el) => el.type === "button");
    } catch {
      return null;
    }
  })();
  if (nativeCover) (nativeCover.props.onClick as () => void)();
  player.nativeAfterClick = draw(native.render(nativeProps));

  const slideReorder = renderToStaticMarkup(
    React.createElement(SlideReorder, {
      assetId: "a1",
      slidePaths: ["t/a1/slide_1.png", "t/a1/slide_2.png", "t/a1/slide_3.png"],
      slideUrls: ["https://media.test/slide_1.png", "https://media.test/slide_2.png", "https://media.test/slide_3.png"],
    }),
  );

  const out = {
    frames: {
      reel: frame(1080, 1920),
      card45: frame(1080, 1350),
      square: frame(1080, 1080),
      wide: frame(1920, 1080),
      tall: frame(1080, 2340),
      labelOnly: frame(null, null, { aspect: "4:5" }),
      tiktok: frame(1080, 1920, { chrome: "tiktok" }),
      guides: frame(1080, 1920, { guides: true }),
    },
    tiles,
    player,
    slideReorder,
  };
  process.stdout.write(JSON.stringify(out));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
