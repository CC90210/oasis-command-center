/**
 * Server-render helper for tests/skills-tab-render.test.ts (Skills tab, JARVIS plan 3).
 * WHY A SEPARATE PROCESS: suites under `--conditions=react-server` cannot resolve react-dom/server
 * or useState (same reason as tests/playbook-prompts.render.ts). The test spawns this file with
 * plain `node --import tsx`, writes scenarios to stdin and asserts on the markup it prints.
 * Callback props (on*) are filled with no-ops. It asserts nothing itself.
 */
import type { ComponentType } from "react";

type Scenario = { id: string; component: string; props: Record<string, unknown> };
type Loader = () => Promise<unknown>;

const COMPONENTS: Record<string, Loader> = {
  LibraryView: async () => (await import("../components/playbook/skills/LibraryView")).LibraryView,
  SkillSheetBody: async () => (await import("../components/playbook/skills/SkillSheet")).SkillSheetBody,
  TrainingView: async () => (await import("../components/playbook/skills/TrainingView")).TrainingView,
  HeldChange: async () => (await import("../components/playbook/skills/HeldChange")).HeldChange,
  PaletteResults: async () => (await import("../components/playbook/skills/CommandPalette")).PaletteResults,
  // (later tasks add components here)
};
const CALLBACKS = ["onGroup", "onOpenSkill", "onAction", "onClose", "onPick", "onDone", "onRebuild", "onRefresh", "onHover"];

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const scenarios = JSON.parse(await readStdin()) as Scenario[];
  const out: Record<string, string> = {};
  for (const s of scenarios) {
    const load = COMPONENTS[s.component];
    if (!load) throw new Error(`unknown component ${s.component}`);
    const Component = (await load()) as ComponentType<Record<string, unknown>>;
    const props: Record<string, unknown> = { ...s.props };
    for (const k of CALLBACKS) if (!(k in props)) props[k] = () => undefined;
    out[s.id] = renderToStaticMarkup(React.createElement(Component, props));
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
