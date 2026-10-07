/**
 * Full-React half of tests/seo-screen.test.ts. The suite runs with --conditions=react-server,
 * where react-dom/server does not resolve and React has no useState, so the test spawns this
 * with plain `node --import tsx`, writes cases to stdin, and asserts on the markup printed.
 * React is set on globalThis first: tsconfig jsx:"preserve" compiles components with the
 * classic runtime. It asserts nothing.
 */
import { dirname } from "node:path";

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  stub("next/link", {
    __esModule: true,
    default: ({ href, children, prefetch: _p, ...rest }: { href: string; prefetch?: boolean; children?: unknown }) =>
      React.createElement("a", { href, ...rest }, children as React.ReactNode),
  });
  const { renderToStaticMarkup } = await import("react-dom/server");
  const VIEWS: Record<string, React.ComponentType<never>> = {
    sites: (await import("../components/seo/SitesView")).SitesView as React.ComponentType<never>,
    "sites-actions": (await import("../components/seo/SitesActions")).SitesActions as React.ComponentType<never>,
  };
  const cases = JSON.parse(await readStdin()) as Array<{ view: string; props: Record<string, unknown> }>;
  const out = cases.map(({ view, props }) => renderToStaticMarkup(React.createElement(VIEWS[view], props as never)));
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
