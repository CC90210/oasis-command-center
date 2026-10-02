/**
 * The client-render half of tests/connections-everywhere.test.ts.
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`,
 * under which `react-dom/server` does not resolve and `react` exports no
 * hooks. The Connections drawer and hub are client components, so the only way
 * to see what they draw is to render them where React is whole. The test
 * spawns THIS file with plain `node --import tsx`, writes the statuses it
 * computed through the real server loader to stdin, and asserts against the
 * markup (and the hub's click decisions) printed here.
 *
 * It asserts nothing: every assertion lives in the .test.ts.
 */

// A module, not a global script: its `main` must not collide with other
// scripts' under `tsc --noEmit -p .`.
export {};

type DrawerCase = {
  id: string;
  kind: "drawer";
  slug: string;
  status: Record<string, unknown> | null;
  embedded?: boolean;
  requestFrom?: string;
};
type HubCase = {
  id: string;
  kind: "hub";
  statuses: Record<string, Record<string, unknown>>;
  embedded?: boolean;
  initialApp?: string | null;
};
type Input = { cases: Array<DrawerCase | HubCase>; clicks: Array<{ slug: string; embedded: boolean }> };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The App Router is not mounted here; nothing is clicked, so these never run. */
function stubNavigation() {
  const p = require.resolve("next/navigation");
  const exports = {
    useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined, replace: () => undefined }),
    usePathname: () => "/settings/connections",
    useSearchParams: () => new URLSearchParams(),
    notFound: () => {
      throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
    },
    redirect: (url: string) => {
      throw new Error(`NEXT_REDIRECT;${url}`);
    },
  };
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

async function main() {
  stubNavigation();
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ConnectorDrawer } = await import("../components/os/connections/ConnectorDrawer");
  const { ConnectionsHub, connectorClickAction } = await import("../components/os/connections/ConnectionsHub");
  const { connectorBySlug } = await import("../lib/os/connectors");

  const input = JSON.parse(await readStdin()) as Input;
  const markup: Record<string, string> = {};
  const noop = () => undefined;
  for (const c of input.cases) {
    if (c.kind === "drawer") {
      markup[c.id] = renderToStaticMarkup(
        React.createElement(ConnectorDrawer, {
          open: true,
          def: connectorBySlug(c.slug),
          status: c.status as never,
          onClose: noop,
          onConnect: noop,
          onChanged: noop,
          personalGoogle: false,
          embedded: c.embedded ?? false,
          requestFrom: c.requestFrom ?? "Settings > Connections",
        }),
      );
    } else {
      markup[c.id] = renderToStaticMarkup(
        React.createElement(ConnectionsHub, {
          statuses: c.statuses as never,
          supportHref: null,
          initialApp: c.initialApp ?? null,
          personalGoogle: false,
          embedded: c.embedded ?? false,
        }),
      );
    }
  }
  const clicks = input.clicks.map((k) => ({ ...k, action: connectorClickAction(connectorBySlug(k.slug)!, k.embedded) }));
  process.stdout.write(JSON.stringify({ markup, clicks }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
