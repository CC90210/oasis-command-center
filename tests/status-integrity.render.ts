/**
 * The client-render half of tests/status-integrity.test.ts.
 *
 * The suite runs with `--conditions=react-server`, under which react-dom/server
 * does not resolve. The status lines below are drawn by components that need
 * whole React (System health's integration card is a client component; the
 * AI Team row, the department Slack line and Today's calendar line are
 * rendered for real here so the test reads the words a person sees). The test
 * writes the props it computed through the real server code to stdin and
 * asserts on the markup printed here.
 *
 * It asserts nothing: every assertion lives in the .test.ts.
 */

// A module, not a global script, so its `main` cannot collide under tsc.
export {};

type Case =
  | { id: string; kind: "integration_dot"; health: Record<string, unknown>; hasCredentials?: boolean | null }
  | { id: string; kind: "homes"; props: Record<string, unknown> }
  | { id: string; kind: "slack_line"; props: Record<string, unknown> }
  | { id: string; kind: "schedule"; props: Record<string, unknown> };

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
    usePathname: () => "/",
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
  const { IntegrationDot } = await import("../components/IntegrationDot");
  const { Homes } = await import("../components/os/aiteam/TeammateRow");
  const { SlackLine } = await import("../components/os/department/OverviewPanel");
  const { ScheduleGlance } = await import("../components/os/today/ScheduleGlance");

  const input = JSON.parse(await readStdin()) as { cases: Case[] };
  const markup: Record<string, string> = {};
  for (const c of input.cases) {
    if (c.kind === "integration_dot") {
      markup[c.id] = renderToStaticMarkup(
        React.createElement(IntegrationDot, { health: c.health as never, connection: { hasCredentials: c.hasCredentials } }),
      );
    } else if (c.kind === "homes") {
      markup[c.id] = renderToStaticMarkup(React.createElement(Homes, c.props as never));
    } else if (c.kind === "slack_line") {
      markup[c.id] = renderToStaticMarkup(React.createElement(SlackLine, c.props as never));
    } else {
      markup[c.id] = renderToStaticMarkup(React.createElement(ScheduleGlance, c.props as never));
    }
  }
  process.stdout.write(JSON.stringify({ markup }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
