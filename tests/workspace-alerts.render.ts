/**
 * The server-render half of tests/workspace-alerts.test.ts.
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`,
 * under which `react-dom/server` does not resolve. The test spawns THIS file
 * with plain `node --import tsx`, writes the Feed rows and Needs-you rows to
 * its stdin, and asserts against the markup it prints (the same pattern as
 * tests/clients-hub.render.ts).
 *
 * `React` is set on globalThis before any component loads: tsconfig.json sets
 * jsx:"preserve", so tsx compiles the components with the classic runtime,
 * which reads a global React.
 *
 * It asserts nothing: every assertion lives in the .test.ts.
 */
import type { FeedEventRow } from "../components/os/landings/feed-model";
import type { NeedsYouItem } from "../components/os/today/model";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { FeedRows } = await import("../components/os/landings/FeedView");
  const { NeedsYouRows } = await import("../components/os/today/NeedsYouList");
  const input = JSON.parse(await readStdin()) as {
    feedRows: FeedEventRow[];
    oasisWorkspace: boolean;
    needsItems: NeedsYouItem[];
  };
  const feed = renderToStaticMarkup(
    React.createElement(FeedRows, {
      rows: input.feedRows,
      departmentLabels: { sales: "Sales" },
      emptyMessage: "No activity.",
      oasisWorkspace: input.oasisWorkspace,
    }),
  );
  const needs = renderToStaticMarkup(React.createElement(NeedsYouRows, { items: input.needsItems }));
  process.stdout.write(JSON.stringify({ feed, needs }));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
