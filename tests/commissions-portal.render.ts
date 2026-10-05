/**
 * The client-render half of tests/commissions-portal.test.ts.
 *
 * WHY A SEPARATE PROCESS (same as tests/client-route-gating.render.ts). The
 * suite runs with `--conditions=react-server`, under which `react-dom/server`
 * does not resolve and `react` exports no hooks. CommissionPortal is a client
 * component, so the only way to see its first paint is to render it where
 * React is whole. The test spawns THIS file with plain `node --import tsx`,
 * writes the `initial` props it captured from the real server render to
 * stdin, and asserts against the markup printed here.
 *
 * Every fetch() is counted and refused: the first paint must not need one.
 * It asserts nothing: every assertion lives in the .test.ts.
 */

// A module, not a global script: its `main` must not collide with other
// scripts' under `tsc --noEmit -p .`.
export {};

type Input = { cases: Record<string, unknown> };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

let fetches = 0;
globalThis.fetch = (async () => {
  fetches += 1;
  throw new Error("network disabled in the commissions render helper");
}) as typeof fetch;

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  // The App Router is not mounted here; a plain anchor keeps the href visible.
  stub("next/link", {
    __esModule: true,
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      React.createElement("a", { href, ...rest }, children as React.ReactNode),
  });
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { CommissionPortal } = await import("../app/commissions/CommissionPortal");
  const CommissionsLoading = (await import("../app/commissions/loading")).default;

  const input = JSON.parse(await readStdin()) as Input;
  const html: Record<string, string> = {};
  for (const [id, initial] of Object.entries(input.cases)) {
    html[id] = renderToStaticMarkup(React.createElement(CommissionPortal, { initial } as never));
  }
  html.loading = renderToStaticMarkup(React.createElement(CommissionsLoading));

  process.stdout.write(JSON.stringify({ html, fetches }));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
