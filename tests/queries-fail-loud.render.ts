/**
 * The server-render half of tests/queries-fail-loud-callers.test.ts.
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`,
 * under which `react-dom/server` does not resolve and `react` has no
 * `useState`. IntegrationDot, ProviderAccountsCard and AgentConfigEditor are
 * client components, so the only way to see what they draw when a page hands
 * them null ("the read failed") is to render them where React is whole — the
 * same split tests/os-channels-honest.render.ts makes. The test spawns this
 * file with plain `node --import tsx` and asserts against the markup it prints.
 *
 * Each scenario comes in pairs: the unknown (null) and the KNOWN empty/false,
 * so the test can tell "Couldn't check" apart from a card that never says
 * "Not connected" at all.
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
  // The cards call useRouter for refresh-after-save; the app router is not
  // mounted here and nothing is clicked.
  // "/admin" puts the OS rail in its Admin view, the only place the operator
  // status line (agent + bridge dots) is drawn.
  stub("next/navigation", {
    useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined, replace: () => undefined }),
    usePathname: () => "/admin",
    useSearchParams: () => new URLSearchParams(),
  });
  stub("next/image", {
    __esModule: true,
    default: ({ src, alt }: { src: unknown; alt?: string }) => React.createElement("img", { src: String(src), alt }),
  });
  stub("next/link", {
    __esModule: true,
    default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; prefetch?: boolean; children?: unknown }) =>
      React.createElement("a", { href, ...rest }, children as React.ReactNode),
  });
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { IntegrationDot } = await import("../components/IntegrationDot");
  const { ProviderAccountsCard } = await import("../components/settings/ProviderAccountsCard");
  const { AgentConfigEditor } = await import("../components/settings/AgentConfigEditor");
  const { OsRail } = await import("../components/os/OsRail");
  const railSections = [
    {
      key: "team" as const,
      label: "Team",
      icon: "LayoutDashboard" as const,
      home: "/",
      groups: [{ id: "team:_", label: null, rows: [{ id: "today", href: "/", label: "Today", icon: "LayoutDashboard" as const }] }],
    },
    {
      key: "admin" as const,
      label: "Admin",
      icon: "LayoutDashboard" as const,
      home: "/admin",
      groups: [{ id: "admin:_", label: null, rows: [{ id: "admin", href: "/admin", label: "Admin home", icon: "LayoutDashboard" as const }] }],
    },
  ];
  const rail = (bridgeOnline: boolean | null) =>
    renderToStaticMarkup(
      React.createElement(OsRail, {
        sections: railSections,
        brand: "OASIS AI",
        logo: "oasis",
        isOperator: true,
        primaryAgent: "agent",
        primaryAgentLive: false,
        bridgeOnline,
        statusKnown: true,
        showConnections: false,
      }),
    );

  const health = {
    id: "placeholder-openrouter",
    profile_id: null,
    tenant_id: "tenant-a",
    service: "openrouter",
    status: "unconfigured" as const,
    last_ping_at: null,
    last_error: null,
    metadata: {},
  };
  const out: Record<string, string> = {
    dotUnknown: renderToStaticMarkup(React.createElement(IntegrationDot, { health, connection: { hasCredentials: null } })),
    dotKnownMissing: renderToStaticMarkup(React.createElement(IntegrationDot, { health, connection: { hasCredentials: false } })),
    accountsUnknown: renderToStaticMarkup(
      React.createElement(ProviderAccountsCard, { connectedServices: null, bridgeOnline: null, canManageTeam: true }),
    ),
    accountsKnownEmpty: renderToStaticMarkup(
      React.createElement(ProviderAccountsCard, { connectedServices: new Set<string>(), bridgeOnline: false, canManageTeam: true }),
    ),
    editorUnknown: renderToStaticMarkup(
      React.createElement(AgentConfigEditor, { agentKeys: [], bridgeOnline: null, globallyConnectedServices: null }),
    ),
    editorKnownEmpty: renderToStaticMarkup(
      React.createElement(AgentConfigEditor, { agentKeys: [], bridgeOnline: false, globallyConnectedServices: [] }),
    ),
    railUnknown: rail(null),
    railOffline: rail(false),
  };
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
