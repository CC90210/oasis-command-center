/**
 * The server-render half of tests/content-tools-collapsible.test.ts.
 *
 * The suite runs with `--conditions=react-server`, under which react-dom/server
 * does not resolve, so the test spawns this file without that condition and
 * asserts on the markup it prints: components/leads/CollapsibleSection.tsx
 * open and closed. It asserts nothing itself.
 */

// A module, not a global script, so its `main` cannot collide under tsc.
export {};

type Case = { id: string; defaultCollapsed: boolean };

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
  const { CollapsibleSection } = await import("../components/leads/CollapsibleSection");

  const input = JSON.parse(await readStdin()) as { cases: Case[] };
  const markup: Record<string, string> = {};
  for (const c of input.cases) {
    markup[c.id] = renderToStaticMarkup(
      React.createElement(CollapsibleSection, {
        title: "Demo",
        defaultCollapsed: c.defaultCollapsed,
        children: React.createElement("p", null, "the body is here"),
      }),
    );
  }
  process.stdout.write(JSON.stringify({ markup }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
