/**
 * The client-render half of tests/client-route-gating.test.ts.
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`,
 * under which `react-dom/server` does not resolve and `react` exports no
 * hooks. The cards this checks (Settings > AI brain's workspace agents and
 * provider overrides, the two error boundaries) are client components, so the
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
    usePathname: () => "/settings/ai",
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
  const crash = Object.assign(new Error("boom"), { digest: "digest-4471" });
  const noop = () => undefined;
  render("error", React.createElement(ErrorBoundary, { error: crash, reset: noop }));
  render("errorNoDigest", React.createElement(ErrorBoundary, { error: new Error("boom"), reset: noop }));
  render("globalError", React.createElement(GlobalError, { error: crash, reset: noop }));
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
