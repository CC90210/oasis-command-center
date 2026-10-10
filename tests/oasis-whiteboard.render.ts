/**
 * The server-render half of tests/oasis-whiteboard.test.ts.
 *
 * The suite runs with `--conditions=react-server`, under which react-dom/server
 * does not resolve, so the test spawns this file without that condition and
 * asserts on the markup it prints: the whole whiteboard as the page first
 * draws it, and the toolbar in the states the test asks for (erasing, a custom
 * colour, things to undo). It asserts nothing itself.
 */

import type { PresentMode } from "../components/founders/whiteboard-present";
import type { WhiteboardState } from "../components/founders/whiteboard-surface";

// A module, not a global script, so its `main` cannot collide under tsc.
export {};

type Case = { id: string; kind: "page" } | { id: string; kind: "toolbar"; ui: Partial<WhiteboardState>; presentMode?: PresentMode };

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
  const { OasisWhiteboard, WhiteboardToolbar } = await import("../components/founders/OasisWhiteboard");
  const { INITIAL_STATE } = await import("../components/founders/whiteboard-surface");

  const noop = () => undefined;
  const actions = { setColor: noop, setSize: noop, toggleEraser: noop, undo: noop, redo: noop, clear: noop, download: noop, present: noop };
  const input = JSON.parse(await readStdin()) as { cases: Case[] };
  const markup: Record<string, string> = {};
  for (const c of input.cases) {
    markup[c.id] =
      c.kind === "page"
        ? renderToStaticMarkup(React.createElement(OasisWhiteboard))
        : renderToStaticMarkup(React.createElement(WhiteboardToolbar, { ui: { ...INITIAL_STATE, ...c.ui }, actions, presentMode: c.presentMode ?? "idle" }));
  }
  process.stdout.write(JSON.stringify({ markup }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
