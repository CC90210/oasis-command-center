/**
 * The server-render half of the AI audit screen check (tests/_ai-audit-screens.ts).
 *
 * WHY A SEPARATE PROCESS. The audit suites run with `--conditions=react-server`,
 * under which `react-dom/server` does not resolve and `react` exports no
 * `useState`. The audit's screens are client components, so the only way to
 * see what CC is shown is to render them where React is whole. The suite
 * spawns THIS file with plain `node --import tsx`, writes the scenarios to its
 * stdin, and asserts against the markup it prints (the same split as
 * tests/os-channels-honest.render.ts).
 *
 * WHAT IT RENDERS. The real screens, with the props their pages build from the
 * suite's own libSQL file: the engagement workspace (every tab is mounted, so
 * one render draws every panel), the live-call screen, the price catalogue,
 * the settings form, the setup checklist, the Needs-you cards (Gate 1, Gate 2,
 * follow-ups) and the client's own audit page. `useRouter` gets a router that does nothing: no
 * click is made here, only the first paint. The audit document's stylesheet
 * resolves to nothing (Next bundles it; plain node cannot load a .css file).
 *
 * It asserts nothing: every assertion lives in tests/_ai-audit-screens.ts.
 */
import { dirname, join } from "node:path";

const ROOT = join(__dirname, "..");

/** A module the bundler would handle (here: a stylesheet) resolves to nothing. */
function stubPath(p: string, exports: Record<string, unknown>) {
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

type Scenario =
  | { id: string; screen: "workspace"; props: Record<string, unknown> }
  | { id: string; screen: "call"; props: Record<string, unknown> }
  | { id: string; screen: "catalogue"; props: Record<string, unknown> }
  | { id: string; screen: "settings"; props: Record<string, unknown> }
  | { id: string; screen: "approval"; props: Record<string, unknown> }
  | { id: string; screen: "document"; props: Record<string, unknown> }
  | { id: string; screen: "setup"; props: Record<string, unknown> };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { EngagementWorkspace } = await import("../components/ai-audit/workspace/EngagementWorkspace");
  const { LiveCall } = await import("../components/ai-audit/call/LiveCall");
  const { CatalogueManager } = await import("../components/ai-audit/workspace/CatalogueManager");
  const { SettingsForm } = await import("../components/ai-audit/workspace/SettingsForm");
  const { ApprovalCard } = await import("../components/os/approvals/ApprovalCard");
  stubPath(join(ROOT, "components", "ai-audit", "doc", "audit-document.css"), {});
  const { AuditDocument } = await import("../components/ai-audit/doc/AuditDocument");
  const { SetupChecklist } = await import("../components/ai-audit/SetupChecklist");
  const noop = () => undefined;
  const router = { back: noop, forward: noop, refresh: noop, push: noop, replace: noop, prefetch: noop };
  const screens: Record<Scenario["screen"], (props: Record<string, unknown>) => unknown> = {
    workspace: (p) => React.createElement(EngagementWorkspace as never, p),
    call: (p) => React.createElement(LiveCall as never, p),
    catalogue: (p) => React.createElement(CatalogueManager as never, p),
    settings: (p) => React.createElement(SettingsForm as never, p),
    approval: (p) => React.createElement(ApprovalCard as never, p),
    document: (p) => React.createElement(AuditDocument as never, p),
    setup: (p) => React.createElement(SetupChecklist as never, p),
  };
  const scenarios = JSON.parse(await readStdin()) as Scenario[];
  const out: Record<string, { html?: string; error?: string }> = {};
  for (const s of scenarios) {
    try {
      out[s.id] = { html: renderToStaticMarkup(React.createElement(AppRouterContext.Provider, { value: router as never }, screens[s.screen](s.props) as never)) };
    } catch (err) {
      out[s.id] = { error: err instanceof Error ? (err.stack ?? err.message) : String(err) };
    }
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
