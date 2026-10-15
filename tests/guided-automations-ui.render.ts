/**
 * The server-render half of tests/guided-automations-ui.test.ts.
 *
 * The suite runs with `--conditions=react-server`, under which `react-dom/server` does not resolve and
 * `react` has no `useState`, so the test spawns this file without that condition and asserts on the
 * markup it prints: the guided builder, in any state the test can describe, and the Automations page
 * with the builder on and off. It asserts nothing itself.
 *
 * Effects do not run in a static render, so every component takes `initial*` props (the loaded
 * workspace, the saved list, the wizard's starting step and draft) and each case draws one state.
 *
 * The page case stands in for the data layer only (the signed-in profile, the manifest, the platform
 * checks): the real AutomationsContent and every real component under it are rendered.
 */
import { dirname } from "node:path";

// A module, not a global script, so its names cannot collide under tsc.
export {};

type SectionCase = { id: string; kind: "section"; props: Record<string, unknown> };
type PageCase = { id: string; kind: "page"; props: Record<string, unknown>; profile?: Record<string, unknown> | null };
type Case = SectionCase | PageCase;

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const React = await import("react");
  // tsconfig sets jsx:"preserve", so tsx compiles component JSX with the classic runtime.
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");

  let profile: Record<string, unknown> | null = { tenant_id: "t-1", auth_user_id: "u-1", agents_enabled: ["bravo"] };

  stub("next/link", {
    __esModule: true,
    default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; prefetch?: boolean; children?: unknown }) =>
      React.createElement("a", { href, ...rest }, children as never),
  });
  stub("next/navigation", {
    useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined, replace: () => undefined }),
    usePathname: () => "/automations",
    useSearchParams: () => new URLSearchParams(),
  });
  stub("../lib/queries", {
    getActiveProfile: async () => profile,
    getOnlineBridgeComputerLabels: async () => [],
    getTenant: async () => ({ id: "t-1", slug: "oasis-ai-cc" }),
  });
  stub("../lib/api-helpers", { safe: async (_label: string, read: Promise<unknown>, fallback: unknown) => read.catch(() => fallback) });
  stub("../lib/manifest/loader", { manifestExists: async () => false, getManifest: async () => null });
  stub("../lib/manifest/tenant-scope", { oasisOperatorAgents: () => null });
  stub("../lib/client-profiles", { resolveClientProfileSlug: (t: { slug: string }) => t.slug });
  stub("../lib/role-surfaces", { isOasisSurfaceTenant: () => false });
  stub("../lib/deployment-surface", { externalTenantSurfacesBlocked: () => false });

  const { GuidedAutomations } = await import("../components/automations/guided/GuidedAutomations");
  const { AutomationsContent } = await import("../components/automations/AutomationsContent");

  // The page never calls the API in a static render; a call here is a bug in the test.
  const api = new Proxy(
    {},
    {
      get: (_t, prop) => () => {
        throw new Error(`api.${String(prop)} was called during a static render`);
      },
    },
  ) as never;

  const input = JSON.parse(await readStdin()) as { cases: Case[] };
  const markup: Record<string, string> = {};
  for (const c of input.cases) {
    if (c.kind === "section") {
      markup[c.id] = renderToStaticMarkup(React.createElement(GuidedAutomations, { api, ...c.props }));
    } else {
      profile = c.profile === undefined ? { tenant_id: "t-1", auth_user_id: "u-1", agents_enabled: ["bravo"] } : c.profile;
      markup[c.id] = renderToStaticMarkup((await AutomationsContent(c.props)) as never);
    }
  }
  process.stdout.write(JSON.stringify({ markup }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
