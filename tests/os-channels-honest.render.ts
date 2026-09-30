/**
 * The server-render half of tests/os-channels-honest.test.ts.
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`,
 * under which `react-dom/server` does not resolve and `react` exports no
 * `useState`, `useRef` or `createContext`. The department channel is a client
 * component (DepartmentChannel -> AgentChat, inside ComposerProvider), so the
 * only way to see what the page actually draws is to render it where React is
 * whole. The test spawns THIS file with plain `node --import tsx`, writes the
 * scenarios to its stdin, and asserts against the markup it prints.
 *
 * WHAT IT RENDERS. The real DepartmentTab — header pill, channel, Overview —
 * with the ChannelState and DepartmentStatus the test computed through the real
 * resolver against its libSQL file. The Overview gets empty reads (it is not
 * what this suite checks); nothing else is stood in for.
 *
 * `React` is set on globalThis before any component loads: tsconfig.json sets
 * jsx:"preserve", so tsx compiles the components with the classic runtime,
 * which reads a global React (the same reason the suite sets it).
 *
 * It asserts nothing: every assertion lives in the .test.ts.
 */
import type { DepartmentStatus } from "../components/os/department/StatusPill";
import type { ChannelState } from "../components/os/department/channel";

export type RenderScenario = { id: string; deptSlug: string; status: DepartmentStatus; channel: ChannelState };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { DepartmentTab } = await import("../components/os/department/DepartmentTab");
  const { departmentBySlug } = await import("../lib/os/departments");
  const { departmentProfile } = await import("../components/os/department/config");

  const scenarios = JSON.parse(await readStdin()) as RenderScenario[];
  const out: Record<string, string> = {};
  for (const s of scenarios) {
    const dept = departmentBySlug(s.deptSlug);
    if (!dept) throw new Error(`unknown department slug: ${s.deptSlug}`);
    out[s.id] = renderToStaticMarkup(
      React.createElement(DepartmentTab, {
        dept,
        purpose: departmentProfile(dept.key).purpose,
        status: s.status,
        channel: s.channel,
        prefill: null,
        overview: {
          attention: [],
          approvals: { ok: true, value: { items: [], total: 0 } },
          feedHref: null,
          tiles: [],
          routines: { ok: true, value: [] },
          connections: [],
          canManageConnections: false,
          asks: [],
        },
      }),
    );
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
