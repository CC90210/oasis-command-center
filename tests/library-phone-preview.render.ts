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
 * It asserts nothing: every assertion lives in the .test.ts.
 */
import { dirname } from "node:path";

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
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
  };
  process.stdout.write(JSON.stringify(out));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
