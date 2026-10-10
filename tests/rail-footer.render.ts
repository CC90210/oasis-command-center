/**
 * The client-render half of the RailFooter checks in tests/os-nav.test.ts.
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`,
 * where react-dom/server does not resolve and React exports no hooks, and
 * RailFooter is a client component (FooterLink calls useWarmOnIntent, a
 * hook). The test spawns THIS file with plain `node --import tsx` and
 * asserts against the markup printed here.
 *
 * next/navigation and next/link are stood in (no app router is mounted
 * here), as in tests/shell-hydration.render.ts.
 *
 * It asserts nothing: every assertion lives in the .test.ts.
 */

// A module, not a global script: its `main` must not collide with other
// scripts' under `tsc --noEmit -p .`.
export {};

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

type Case = {
  id: string;
  pathname: string;
  showConnections: boolean;
  connectionsStatus: "ok" | "attention" | null;
  isOperator: boolean;
};

/**
 * settingsActive / connectionsPathActive: the gear must be the active door
 * on both paths now that Connections has no door of its own.
 * attention / ok / notMeasured: the three connectionsStatus values, all with
 * showConnections true, covering the dot + accessible-name matrix.
 * hiddenAttention: attention status but showConnections false — the viewer
 * who could never open Connections must not see its signal either.
 * operator: isOperator true, to prove the shield is unaffected.
 */
const CASES: Case[] = [
  { id: "settingsActive", pathname: "/settings", showConnections: true, connectionsStatus: null, isOperator: false },
  { id: "connectionsPathActive", pathname: "/settings/connections", showConnections: true, connectionsStatus: null, isOperator: false },
  { id: "attention", pathname: "/pipeline", showConnections: true, connectionsStatus: "attention", isOperator: false },
  { id: "ok", pathname: "/pipeline", showConnections: true, connectionsStatus: "ok", isOperator: false },
  { id: "notMeasured", pathname: "/pipeline", showConnections: true, connectionsStatus: null, isOperator: false },
  { id: "hiddenAttention", pathname: "/pipeline", showConnections: false, connectionsStatus: "attention", isOperator: false },
  { id: "operator", pathname: "/pipeline", showConnections: true, connectionsStatus: null, isOperator: true },
];

async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  stub("next/navigation", {
    useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined, replace: () => undefined }),
    usePathname: () => "/",
    useSearchParams: () => new URLSearchParams(),
  });
  stub("next/link", {
    __esModule: true,
    default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; prefetch?: boolean; children?: unknown }) =>
      React.createElement("a", { href, ...rest }, children as React.ReactNode),
  });
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { RailFooter } = await import("../components/os/RailFooter");

  const markup: Record<string, string> = {};
  for (const c of CASES) {
    markup[c.id] = renderToStaticMarkup(
      React.createElement(RailFooter, {
        pathname: c.pathname,
        operatorName: "Alex",
        operatorEmail: "alex@acme-plumbing.test",
        showConnections: c.showConnections,
        connectionsStatus: c.connectionsStatus,
        notifications: null,
        isOperator: c.isOperator,
        adminActive: false,
        onToggleAdmin: () => undefined,
      }),
    );
  }
  process.stdout.write(JSON.stringify({ markup }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
