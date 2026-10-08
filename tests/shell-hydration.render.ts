/**
 * The client-render half of the shell hydration checks in
 * tests/shell-boundary.test.ts.
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`,
 * where react-dom/server does not resolve and React exports no hooks, and the
 * shell (components/SidebarShell.tsx, components/MainShell.tsx) is client
 * components. The test spawns THIS file with plain `node --import tsx` and
 * asserts against what it prints.
 *
 * WHAT IT DRAWS.
 *   1. SidebarShell three times with the same props: as the server draws it
 *      (no window at all), and as a browser's FIRST render draws it with the
 *      sidebar stored as collapsed, then as expanded (a window whose
 *      localStorage holds that choice). React hydrates by comparing the
 *      browser's first render with the server's HTML, so all three must be the
 *      same markup: a difference is React error #418, the whole page thrown
 *      away and redrawn in the browser.
 *   2. The sidebar hook's effects after hydration, frame by frame.
 *   3. MainShell's element tree (not its markup, which is the same either way)
 *      on a normal page and on the chat shell, to say what the page element's
 *      direct parent is.
 *
 * next/navigation, next/link and next/image are stood in (no app router is
 * mounted here), as in tests/connections-everywhere.render.ts. It asserts
 * nothing: every assertion lives in the .test.ts.
 */

// A module, not a global script: its `main` must not collide with other
// scripts' under `tsc --noEmit -p .`.
export {};

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

/**
 * A hook run frame by frame with its own state kept between frames, as
 * driver() in tests/library-phone-preview.render.ts does: each frame renders,
 * then runs the effects whose deps changed (the commit), and a state change in
 * an effect makes the next frame. It knows useState, useEffect and useCallback
 * and nothing else, so a new hook in useSidebarCollapsed fails loudly here.
 */
function frames<T>(hook: () => T, max = 6): T[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the CJS object whose dispatcher slot react's hooks read
  const internals = (require("react") as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const slots: unknown[] = [];
  const effectDeps: Array<unknown[] | undefined> = [];
  let queued: Array<() => unknown> = [];
  let cursor = 0;
  let dirty = false;
  const dispatcher = {
    useState(initial: unknown) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      const set = (next: unknown) => {
        const value = typeof next === "function" ? (next as (prev: unknown) => unknown)(slots[at]) : next;
        if (!Object.is(value, slots[at])) {
          slots[at] = value;
          dirty = true;
        }
      };
      return [slots[at], set];
    },
    useEffect(effect: () => unknown, deps?: unknown[]) {
      const at = cursor++;
      const prev = effectDeps[at];
      const changed = !(at in effectDeps) || !deps || !prev || deps.length !== prev.length || deps.some((d, i) => !Object.is(d, prev[i]));
      effectDeps[at] = deps;
      if (changed) queued.push(effect);
    },
    useCallback(fn: unknown) {
      cursor++;
      return fn;
    },
  };
  const out: T[] = [];
  for (let frame = 0; frame < max; frame += 1) {
    cursor = 0;
    dirty = false;
    const previous = internals.H;
    internals.H = dispatcher;
    try {
      out.push(hook());
    } finally {
      internals.H = previous;
    }
    const run = queued;
    queued = [];
    for (const effect of run) effect();
    if (!dirty) break;
  }
  return out;
}

async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  let pathname = "/settings";
  stub("next/navigation", {
    useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined, replace: () => undefined }),
    usePathname: () => pathname,
    useSearchParams: () => new URLSearchParams(),
  });
  stub("next/link", {
    __esModule: true,
    default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; prefetch?: boolean; children?: unknown }) =>
      React.createElement("a", { href, ...rest }, children as React.ReactNode),
  });
  stub("next/image", {
    __esModule: true,
    default: ({ src, alt, width, height, className }: { src: string; alt: string; width: number; height: number; className?: string }) =>
      React.createElement("img", { src, alt, width, height, className }),
  });
  const { renderToString } = await import("react-dom/server");
  const { SidebarShell } = await import("../components/SidebarShell");
  const { SIDEBAR_COLLAPSED_KEY } = await import("../lib/sidebar-boot");

  const props = {
    brand: "Acme Plumbing",
    logo: "oasis" as const,
    sections: [
      {
        key: "team" as const,
        label: "Team",
        icon: "Users" as const,
        home: "/team/chief-of-staff",
        groups: [
          {
            id: "team:_",
            label: null,
            rows: [{ id: "today", href: "/", label: "Today", icon: "Home" as const }],
          },
          {
            id: "team:Departments",
            label: "Departments",
            rows: [{ id: "cos", href: "/team/chief-of-staff", label: "Chief of Staff", icon: "Users" as const }],
          },
        ],
      },
      {
        key: "growth" as const,
        label: "Growth",
        icon: "TrendingUp" as const,
        home: "/pipeline",
        groups: [{ id: "growth:_", label: null, rows: [{ id: "pipeline", href: "/pipeline", label: "Pipeline", icon: "GitBranch" as const }] }],
      },
    ],
    isOperator: false,
    showConnections: true,
    connectionsStatus: null,
    operatorName: "Alex",
    operatorEmail: "alex@acme-plumbing.test",
    primaryAgent: "chief_of_staff",
    primaryAgentLive: false,
    bridgeOnline: false,
    deferStatus: false,
  };
  const draw = () => renderToString(React.createElement(SidebarShell, props));

  const g = globalThis as unknown as Record<string, unknown>;
  const asBrowser = (stored: string | null) => {
    const storage = {
      getItem: (k: string) => (k === SIDEBAR_COLLAPSED_KEY ? stored : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    g.window = { localStorage: storage, sessionStorage: storage, addEventListener: () => undefined, removeEventListener: () => undefined };
    g.localStorage = storage;
  };
  const asServer = () => {
    delete g.window;
    delete g.localStorage;
  };

  asServer();
  const server = draw();
  asBrowser("true");
  const collapsedFirstRender = draw();
  asBrowser("false");
  const expandedFirstRender = draw();
  asServer();

  // After hydration, for a viewer whose choice is stored as collapsed: the boot
  // script already set html[data-sidebar]="collapsed" before paint. Record every
  // write the hook makes to storage and to that attribute.
  const { useSidebarCollapsed } = await import("../lib/useSidebarCollapsed");
  const writes: string[] = [];
  const attribute: string[] = [];
  let current = "collapsed";
  g.window = {
    localStorage: {
      getItem: (k: string) => (k === SIDEBAR_COLLAPSED_KEY ? "true" : null),
      setItem: (k: string, v: string) => writes.push(`${k}=${v}`),
      removeItem: () => undefined,
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  g.document = {
    documentElement: {
      dataset: {
        get sidebar() {
          return current;
        },
        set sidebar(v: string) {
          attribute.push(v);
          current = v;
        },
      },
    },
  };
  const states = frames(() => useSidebarCollapsed()).map((s) => s.collapsed);
  delete g.window;
  delete g.document;

  // MainShell's element tree: the direct parent of the page element, on a
  // normal page and on the chat shell. Called as a function (one render, its
  // only hook is useRef), so the tree is what MainShell returns, unrendered.
  const { MainShell, PageSlot } = await import("../components/MainShell");
  const page = React.createElement("i", { "data-page": "1" });
  type Node = { type?: unknown; props?: { children?: unknown } };
  const parentOf = (tree: unknown, target: unknown): string => {
    const walk = (node: unknown, parent: Node | null): string | null => {
      if (node === target) {
        if (!parent) return "(root)";
        const t = parent.type;
        if (typeof t === "string") return t;
        if (t === PageSlot) return "PageSlot";
        return typeof t === "function" ? t.name || "(anonymous component)" : String(t);
      }
      if (Array.isArray(node)) {
        for (const child of node) {
          const hit = walk(child, parent);
          if (hit) return hit;
        }
        return null;
      }
      if (!node || typeof node !== "object" || !("props" in node)) return null;
      const el = node as Node;
      return walk(el.props?.children, el);
    };
    return walk(tree, null) ?? "(not found)";
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the CJS object whose dispatcher slot react's hooks read
  const internals = (require("react") as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const pageParent: Record<string, string> = {};
  for (const path of ["/settings", "/agent"]) {
    pathname = path;
    const previous = internals.H;
    internals.H = { useRef: (initial: unknown) => ({ current: initial }) };
    try {
      const tree = MainShell({ children: page, footerLabel: "Footer", footerTagline: "Tagline", chat: null, header: null });
      pageParent[path] = parentOf(tree, page);
    } finally {
      internals.H = previous;
    }
  }

  process.stdout.write(
    JSON.stringify({
      server,
      collapsedFirstRender,
      expandedFirstRender,
      storedCollapsed: { states, writes, attribute, final: current },
      pageParent,
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
