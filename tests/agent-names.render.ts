/**
 * The client-render half of tests/agent-names.test.ts.
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`,
 * under which `react-dom/server` does not resolve and `react` exports no
 * hooks. The manifest editor (components/manifest/ManifestEditorChat.tsx) is a
 * client component, so the only way to see what it draws is to render it where
 * React is whole. The test spawns THIS file with plain `node --import tsx`,
 * writes the props the real /t/<slug>/editor page built for each viewer to its
 * stdin, and asserts against the markup printed here.
 *
 * It asserts nothing: every assertion lives in the .test.ts.
 */

// A module, not a global script: its main() must not collide with another file's.
export {};

type Scenario = { id: string; props: Record<string, unknown> };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const React = await import("react");
  // tsconfig sets jsx:"preserve", so tsx compiles the component with the
  // classic runtime, which expects a global React.
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ManifestEditorChat } = await import("../components/manifest/ManifestEditorChat");

  const scenarios = JSON.parse(await readStdin()) as Scenario[];
  const out: Record<string, string> = {};
  for (const s of scenarios) {
    out[s.id] = renderToStaticMarkup(
      React.createElement(ManifestEditorChat, s.props as unknown as Parameters<typeof ManifestEditorChat>[0]),
    );
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
