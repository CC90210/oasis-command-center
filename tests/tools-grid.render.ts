/**
 * The server-render half of tests/tools-grid.test.ts.
 *
 * The suite runs with `--conditions=react-server`, under which react-dom/server
 * does not resolve, so the test spawns this file without that condition and
 * asserts on the markup it prints: the Tools section as the page first draws it,
 * for each catalog the test sends, and the card's panels (a run in review, runs
 * in flight, the history drawer) drawn with real runs, which the first render
 * never contains. It asserts nothing itself.
 *
 * No Next app router is mounted here, and none is needed: the grid reaches the
 * page's router only through window events (components/tools/RefreshOnToolRun.tsx).
 */

import type { ToolKey } from "../lib/tools/registry";
import type { JobView, ToolCatalog } from "../lib/tools/types";

// A module, not a global script, so its `main` cannot collide under tsc.
export {};

type Case = { id: string; catalog: ToolCatalog; showCodes?: boolean };
type Panel = { id: string; kind: "review" | "running" | "history"; jobs: JobView[]; toolKey: ToolKey; runsOn: "worker" | "runner"; showCodes?: boolean; canRetry?: boolean };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const React = await import("react");
  // tsconfig sets jsx:"preserve", so tsx compiles component JSX with the
  // classic runtime, which expects a global React.
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ToolGrid, ReviewBlock, RunningList, RunHistory } = await import("../components/tools/ToolGrid");

  const input = JSON.parse(await readStdin()) as { cases: Case[]; panels?: Panel[] };
  const prefixes = { assetHrefPrefix: "/founders/marketing/extracted?video=", assetDownloadPrefix: "/api/founders/marketing/assets/" };
  const markup: Record<string, string> = {};
  for (const c of input.cases) {
    markup[c.id] = renderToStaticMarkup(
      React.createElement(ToolGrid, { catalog: c.catalog, ...prefixes, extractedVideosHref: "/founders/marketing/extracted", storageScope: "t1", showCodes: c.showCodes }),
    );
  }
  for (const p of input.panels ?? []) {
    const tool = { key: p.toolKey, runsOn: p.runsOn };
    const noop = () => undefined;
    const el =
      p.kind === "running"
        ? React.createElement(RunningList, { runs: p.jobs, tool })
        : p.kind === "history"
          ? React.createElement(RunHistory, { jobs: p.jobs, tool, ...prefixes, extractedVideosHref: "/founders/marketing/extracted", showTimes: false })
          : React.createElement(ReviewBlock, { job: p.jobs[0], tool, ...prefixes, showCodes: p.showCodes ?? false, onDone: noop, onRetry: p.canRetry === false ? undefined : noop });
    markup[p.id] = renderToStaticMarkup(el);
  }
  process.stdout.write(JSON.stringify({ markup }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
