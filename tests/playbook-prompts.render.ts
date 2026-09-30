/**
 * The server-render half of the prompts-library check in
 * tests/playbook-docs.test.ts.
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`,
 * under which `react-dom/server` does not resolve and `react` exports no
 * `useState`. The prompts library's cards live in a client component
 * (components/playbook/PromptsLibraryFilter.tsx), so the only way to see which
 * "Ask <department>" links it actually draws is to render it where React is
 * whole (the same pattern as tests/os-channels-honest.render.ts). The test
 * spawns THIS file with plain `node --import tsx`, writes the props the real
 * /playbook/prompts page built for each viewer to its stdin, and asserts
 * against the markup it prints.
 *
 * `React` is set on globalThis before any component loads: tsconfig.json sets
 * jsx:"preserve", so tsx compiles the components with the classic runtime.
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
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PromptsLibraryFilter } = await import("../components/playbook/PromptsLibraryFilter");

  const scenarios = JSON.parse(await readStdin()) as Scenario[];
  const out: Record<string, string> = {};
  for (const s of scenarios) {
    out[s.id] = renderToStaticMarkup(
      React.createElement(PromptsLibraryFilter, s.props as unknown as Parameters<typeof PromptsLibraryFilter>[0]),
    );
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
