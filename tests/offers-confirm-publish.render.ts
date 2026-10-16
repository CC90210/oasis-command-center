/**
 * The full-React half of tests/offers-confirm-publish.test.ts.
 *
 * The suite runs with `--conditions=react-server`, where react-dom/server does
 * not resolve, so the screen's client component (ConfirmPublish) cannot be
 * drawn there. The test spawns this with plain `node --import tsx` (the
 * condition removed from NODE_OPTIONS for the child, as
 * tests/offer-pages-public.render.ts is run), feeds it { name: props } on
 * stdin and reads the markup back as JSON. A render that throws is reported
 * per scenario as "RENDER FAILED: ...".
 *
 * It asserts nothing: every assertion lives in the .test.ts.
 */
import { dirname } from "node:path";

function stubPath(p: string, exports: Record<string, unknown>) {
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  stubPath(require.resolve("next/navigation"), {
    useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined, replace: () => undefined }),
    usePathname: () => "/forms/publish",
    useSearchParams: () => new URLSearchParams(),
  });
  stubPath(require.resolve("next/link"), {
    __esModule: true,
    default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; prefetch?: boolean; children?: unknown }) =>
      React.createElement("a", { href, ...rest }, children as React.ReactNode),
  });
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ConfirmPublish } = await import("../components/offer-pages/confirm/ConfirmPublish");
  const input = await new Promise<string>((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
  });
  const scenarios = (input.trim() ? JSON.parse(input) : {}) as Record<string, Parameters<typeof ConfirmPublish>[0]>;
  const out: Record<string, string> = {};
  for (const [name, props] of Object.entries(scenarios)) {
    try {
      out[name] = renderToStaticMarkup(React.createElement(ConfirmPublish, props));
    } catch (err) {
      out[name] = `RENDER FAILED: ${err instanceof Error ? err.stack || err.message : String(err)}`;
    }
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
