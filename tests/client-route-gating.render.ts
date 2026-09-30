/**
 * The client-render half of tests/client-route-gating.test.ts.
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`,
 * under which `react-dom/server` does not resolve and `react` exports no
 * hooks. The cards this checks (Settings > AI brain's workspace agents and
 * provider overrides, the two error boundaries on operator and prospect-facing
 * paths, the /unsubscribe form) are client components, so the
 * only way to see what they draw is to render them where React is whole. The
 * test spawns THIS file with plain `node --import tsx`, writes the props it
 * captured from the real server render to stdin, and asserts against the
 * markup printed here.
 *
 * It asserts nothing: every assertion lives in the .test.ts.
 */

// A module, not a global script: its `main` must not collide with other
// scripts' under `tsc --noEmit -p .`.
export {};

type Input = {
  marketplace: Record<string, unknown> | null;
  agentConfig: Record<string, unknown> | null;
  profileEditor: Record<string, unknown> | null;
  /** The same card after one agent was removed: where does it come back? */
  marketplaceAfterRemove?: Record<string, unknown> | null;
};

/** What usePathname answers; the error boundaries read it. */
let currentPath = "/settings/ai";

/** Pages a client's prospect lands on, and one operator page, for the error boundaries. */
const BOUNDARY_PATHS: Record<string, string> = {
  form: "/f/client-co/intake",
  personalForm: "/f/client-co/intake/lead-token-1",
  sign: "/sign/token-1",
  unsubscribe: "/unsubscribe",
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The App Router is not mounted here; the cards only call push/refresh on click. */
function stubNavigation() {
  const p = require.resolve("next/navigation");
  const exports = {
    useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined, replace: () => undefined }),
    usePathname: () => currentPath,
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
  const { AgentMarketplaceCard } = await import("../components/settings/AgentMarketplaceCard");
  const { AgentConfigEditor } = await import("../components/settings/AgentConfigEditor");
  const { ProfileEditor } = await import("../components/settings/ProfileEditor");
  const ErrorBoundary = (await import("../app/error")).default;
  const GlobalError = (await import("../app/global-error")).default;
  const { FormsListClient } = await import("../components/forms/FormsListClient");
  const UnsubscribeForm = (await import("../app/unsubscribe/UnsubscribeForm")).default;

  const input = JSON.parse(await readStdin()) as Input;
  const out: Record<string, string> = {};
  const render = (id: string, el: unknown) => {
    out[id] = renderToStaticMarkup(el as Parameters<typeof renderToStaticMarkup>[0]);
  };

  if (input.marketplace) {
    render("marketplace", React.createElement(AgentMarketplaceCard, input.marketplace as never));
  }
  if (input.agentConfig) {
    render("agentConfig", React.createElement(AgentConfigEditor, input.agentConfig as never));
  }
  if (input.profileEditor) {
    render("profileEditor", React.createElement(ProfileEditor, input.profileEditor as never));
  }
  if (input.marketplaceAfterRemove) {
    render("marketplaceAfterRemove", React.createElement(AgentMarketplaceCard, input.marketplaceAfterRemove as never));
  }
  const crash = Object.assign(new Error("boom"), { digest: "digest-4471" });
  const noop = () => undefined;
  currentPath = "/settings/ai";
  render("error", React.createElement(ErrorBoundary, { error: crash, reset: noop }));
  render("errorNoDigest", React.createElement(ErrorBoundary, { error: new Error("boom"), reset: noop }));
  render("globalError", React.createElement(GlobalError, { error: crash, reset: noop }));
  // The same two boundaries on the pages a client's prospect opens.
  for (const [id, path] of Object.entries(BOUNDARY_PATHS)) {
    currentPath = path;
    render(`error:${id}`, React.createElement(ErrorBoundary, { error: crash, reset: noop }));
    render(`globalError:${id}`, React.createElement(GlobalError, { error: crash, reset: noop }));
  }
  render("error:prospectNoDigest", React.createElement(ErrorBoundary, { error: new Error("boom"), reset: noop }));
  currentPath = "/settings/ai";
  // /unsubscribe: from a link (address shown) and with no address in the link
  // (the recipient types it).
  render("unsubscribeLinked", React.createElement(UnsubscribeForm, { email: "reader@example.com", brand: "", token: "" }));
  render("unsubscribeTyped", React.createElement(UnsubscribeForm, { email: "", brand: "", token: "" }));
  // A client workspace's /forms list with one live form: the row's Copy-link
  // hint and the help block under the table.
  render(
    "formsList",
    React.createElement(FormsListClient, {
      initialRows: [
        {
          id: "f-1",
          slug: "intake",
          name: "Intake",
          description: null,
          enabled: true,
          created_at: "2026-09-01T00:00:00Z",
          updated_at: "2026-09-01T00:00:00Z",
        },
      ],
      tenantLogoUrl: null,
      tenantSlug: "client-co",
      tenantName: "Client Co",
      profileSlug: "client-co",
    }),
  );

  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
