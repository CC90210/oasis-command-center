/**
 * The server-render half of the incident-register correction check in
 * tests/playbook-docs.test.ts.
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`,
 * under which `react-dom/server` does not resolve and `react` exports no
 * `useState`. The register's table and form live in a client component
 * (app/playbook/business/[slug]/IncidentRegister.tsx), so the only way to see
 * what a founder is offered on each entry is to render it where React is whole
 * (the pattern of tests/playbook-prompts.render.ts). The test spawns THIS file
 * with plain `node --import tsx`, writes the props to its stdin, and asserts
 * against the markup it prints.
 *
 * `React` is set on globalThis before the component loads: tsconfig.json sets
 * jsx:"preserve", so tsx compiles the component with the classic runtime.
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
  const { IncidentRegister } = await import("../app/playbook/business/[slug]/IncidentRegister");

  const scenarios = JSON.parse(await readStdin()) as Scenario[];
  const out: Record<string, string> = {};
  for (const s of scenarios) {
    out[s.id] = renderToStaticMarkup(
      React.createElement(IncidentRegister, s.props as unknown as Parameters<typeof IncidentRegister>[0]),
    );
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
