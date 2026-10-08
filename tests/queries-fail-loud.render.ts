/**
 * The server-render half of tests/queries-fail-loud-callers.test.ts.
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`,
 * under which `react-dom/server` does not resolve and `react` has no
 * `useState`. IntegrationDot, ProviderAccountsCard, AgentConfigEditor (and its
 * BridgeToolAccess strip), OsRail and BridgeCliPanel are client components, so the only way
 * to see what they draw when a page hands
 * them null ("the read failed") is to render them where React is whole — the
 * same split tests/os-channels-honest.render.ts makes. The test spawns this
 * file with plain `node --import tsx` and asserts against the markup it prints.
 *
 * Each scenario comes in pairs: the unknown (null) and the KNOWN empty/false,
 * so the test can tell "Couldn't check" apart from a card that never says
 * "Not connected" at all. ProviderAccountsCard reads two signals (keys and
 * bridge) and warns only when both are known, so it is also drawn with one
 * read failed and the other answered, both ways round.
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
 * Calls one component as a plain function, frame after frame, with its own
 * useState slots kept between calls: what React does across a router.refresh()
 * that hands the same mounted card new props. renderToStaticMarkup draws a
 * single frame and there is no DOM in the test toolchain, so this stands in
 * for the reconciler for the card's OWN hooks only (it knows useState and
 * useRef, which ProviderAccountsCard uses to lay its own changes over only the
 * server answer they were made on, and nothing else, so a new hook fails
 * loudly here). What it returns is drawn by real React.
 */
function framesOf<P>(component: (props: P) => unknown): (props: P) => El {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the CJS object whose dispatcher slot react's useState reads
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
  };
  return (props: P) => {
    cursor = 0;
    const previous = internals.H;
    internals.H = dispatcher;
    try {
      return component(props) as El;
    } finally {
      internals.H = previous;
    }
  };
}

/**
 * One frame of a component with each useState slot preset and effects inert.
 * BridgeCliPanel reaches its heartbeat branches only after its poll of
 * /api/bridge/cli-status answers, and renderToStaticMarkup runs no effects, so
 * this hands it the post-poll state directly. Like framesOf, it knows useState
 * and useEffect only, so any other hook fails loudly here.
 */
function frameWithState<P>(component: (props: P) => unknown, props: P, states: unknown[]): El {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the CJS object whose dispatcher slot react's hooks read
  const internals = (require("react") as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  let cursor = 0;
  const dispatcher = {
    useState: () => [states[cursor++], () => undefined],
    useEffect: () => undefined,
  };
  const previous = internals.H;
  internals.H = dispatcher;
  try {
    return component(props) as El;
  } finally {
    internals.H = previous;
  }
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
  const { AgentConfigEditor, BridgeToolAccess } = await import("../components/settings/AgentConfigEditor");
  const { OsRail } = await import("../components/os/OsRail");
  const { BridgeCliPanel } = await import("../components/BridgeCliPanel");
  // The panel's state once its poll of the server's CLI inventory answered.
  const polled = (result: unknown) => ({ loading: false, result });
  const noReport = polled({ kind: "body", status: 200, body: { ok: false, reason: "missing" } });
  const cliPanel = (serverBridgeOnline: boolean | null, state: unknown = noReport) =>
    renderToStaticMarkup(frameWithState(BridgeCliPanel, { serverBridgeOnline }, [state]));
  const hint = "https://example.test/install";
  const report = polled({
    kind: "body",
    status: 200,
    body: {
      ok: true,
      data: {
        claude: { installed: true, authenticated: true, version: "2.1.0", install_hint_url: hint },
        codex: { installed: true, authenticated: false, version: null, install_hint_url: hint },
        gemini: { installed: false, authenticated: false, version: null, install_hint_url: hint },
      },
    },
  });
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
    updated_at: "2026-09-29T00:00:00Z",
  };
  const out: Record<string, string> = {
    dotUnknown: renderToStaticMarkup(React.createElement(IntegrationDot, { health, connection: { hasCredentials: null } })),
    dotKnownMissing: renderToStaticMarkup(React.createElement(IntegrationDot, { health, connection: { hasCredentials: false } })),
    accountsUnknown: renderToStaticMarkup(
      React.createElement(ProviderAccountsCard, { connectedServices: null, bridgeOnline: null, canManageTeam: true, canInstallBridge: true }),
    ),
    accountsKnownEmpty: renderToStaticMarkup(
      React.createElement(ProviderAccountsCard, { connectedServices: new Set<string>(), bridgeOnline: false, canManageTeam: true, canInstallBridge: true }),
    ),
    accountsKeysUnknownBridgeOffline: renderToStaticMarkup(
      React.createElement(ProviderAccountsCard, { connectedServices: null, bridgeOnline: false, canManageTeam: true, canInstallBridge: true }),
    ),
    accountsKeysEmptyBridgeUnknown: renderToStaticMarkup(
      React.createElement(ProviderAccountsCard, { connectedServices: new Set<string>(), bridgeOnline: null, canManageTeam: true, canInstallBridge: true }),
    ),
    editorUnknown: renderToStaticMarkup(
      React.createElement(AgentConfigEditor, { agentKeys: [], bridgeOnline: null, globallyConnectedServices: null }),
    ),
    editorKnownEmpty: renderToStaticMarkup(
      React.createElement(AgentConfigEditor, { agentKeys: [], bridgeOnline: false, globallyConnectedServices: [] }),
    ),
    toolAccessUnknown: renderToStaticMarkup(React.createElement(BridgeToolAccess, { bridgeOnline: null, canInstallBridge: true })),
    toolAccessOffline: renderToStaticMarkup(React.createElement(BridgeToolAccess, { bridgeOnline: false, canInstallBridge: true })),
    railUnknown: rail(null),
    railOffline: rail(false),
    cliUnknown: cliPanel(null),
    cliOffline: cliPanel(false),
    cliOnline: cliPanel(true),
    cliReport: cliPanel(true, report),
    cliNetworkError: cliPanel(true, polled({ kind: "network_error", message: "fetch failed" })),
    cliSignedOut: cliPanel(true, polled({ kind: "body", status: 401, body: { ok: false, reason: "unauthorized" } })),
  };

  // The same mounted card across a refresh. The key read fails, the operator
  // connects Anthropic (its card flips at once; the rest still read "Couldn't
  // check"), and router.refresh() hands back a read that works and shows
  // OpenRouter's key was on file all along. Then Anthropic is disconnected:
  // its card flips before the next refresh lands and stays off after it.
  const accounts = framesOf(ProviderAccountsCard);
  const base = { bridgeOnline: false, canManageTeam: true, canInstallBridge: true };
  const card = (frame: El, provider: string) => find(frame, `the ${provider} card`, (el) => el.key === provider);
  let frame = accounts({ ...base, connectedServices: null });
  const setKey = find(card(frame, "anthropic"), "Anthropic's Set key button", (el) => el.type === "button" && typeof el.props.onClick === "function");
  (setKey.props.onClick as () => void)();
  frame = accounts({ ...base, connectedServices: null });
  const dialog = find(frame, "the connect dialog", (el) => typeof el.props.onConnected === "function");
  (dialog.props.onConnected as (p: string) => void)("anthropic");
  out.accountsAfterConnect = renderToStaticMarkup(accounts({ ...base, connectedServices: null }));
  const refreshed = new Set(["anthropic", "openrouter"]);
  frame = accounts({ ...base, connectedServices: refreshed });
  out.accountsAfterRefresh = renderToStaticMarkup(frame);
  const disconnect = find(card(frame, "anthropic"), "Anthropic's Disconnect button", (el) => typeof el.props.onDisconnected === "function");
  (disconnect.props.onDisconnected as () => void)();
  out.accountsAfterDisconnect = renderToStaticMarkup(accounts({ ...base, connectedServices: refreshed }));
  out.accountsAfterDisconnectRefresh = renderToStaticMarkup(accounts({ ...base, connectedServices: new Set(["openrouter"]) }));

  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
