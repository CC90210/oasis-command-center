/**
 * The client-render half of tests/one-agent-roster.test.ts.
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`,
 * under which `react-dom/server` does not resolve and `react` exports no hooks.
 * The builder (components/marketplace/CustomAgentBuilder.tsx) and the AI Team's
 * On/Off switch (components/os/aiteam/TeammateToggle.tsx) are client
 * components, so they are rendered here, where React is whole, and the markup
 * goes back to the test on stdout.
 *
 * It asserts nothing: every assertion lives in the .test.ts.
 */

// A module, not a global script: its `main` must not collide with other
// scripts' under `tsc --noEmit -p .`.
export {};

/** What useSearchParams answers: the builder reads ?template= from it. */
let search = "";

/** The App Router is not mounted here; the components only call push/refresh on click. */
function stubNavigation() {
  const p = require.resolve("next/navigation");
  const exports = {
    useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined, replace: () => undefined }),
    usePathname: () => "/agents",
    useSearchParams: () => new URLSearchParams(search),
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
  const { CustomAgentBuilder } = await import("../components/marketplace/CustomAgentBuilder");
  const { TeammateToggle } = await import("../components/os/aiteam/TeammateToggle");

  const out: Record<string, string> = {};
  const builder = (id: string, query: string, editing: Parameters<typeof CustomAgentBuilder>[0]["editing"] = null) => {
    search = query;
    out[id] = renderToStaticMarkup(React.createElement(CustomAgentBuilder, { tenantSlug: "client-co", editing }));
  };
  builder("setter", "template=setter");
  builder("unknown", "template=no-such-template");
  builder("none", "");
  builder("editing", "template=setter", {
    slug: "existing-agent",
    name: "Existing agent",
    category: "support",
    short_description: "Already built.",
    description: "",
    base_prompt: "You help {{tenant.brand.name}} with the questions it already answers.",
    required_tools: [],
    suggested_model: "",
    is_public: false,
  });
  out.toggleOn = renderToStaticMarkup(React.createElement(TeammateToggle, { slug: "sdr", name: "Sales lead", enabled: true, bound: true }));
  out.toggleOff = renderToStaticMarkup(
    React.createElement(TeammateToggle, { slug: "intake-helper", name: "Intake Helper", enabled: false, bound: false }),
  );

  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
