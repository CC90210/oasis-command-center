/**
 * The server-render half of tests/ai-engine.test.ts: a department channel's
 * header (components/agents/AgentChat.tsx) with what powers it, as an owner
 * sees it, rendered where React is whole (the suite runs under
 * --conditions=react-server, where react-dom/server does not resolve; see
 * tests/os-channels-honest.render.ts). Prints one JSON line; asserts nothing.
 */
export {};
async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AgentChat } = await import("../components/agents/AgentChat");
  const base = { agentSlug: "bravo", agentName: "Sales", agentSubtitle: "Department channel", department: "sales", canManageAi: true };
  const out = {
    header: renderToStaticMarkup(
      React.createElement(AgentChat, { ...base, poweredBy: { line: "Claude Code on your paired computer", spend: "cli_subscription", note: null } }),
    ),
    fallback: renderToStaticMarkup(
      React.createElement(AgentChat, {
        ...base,
        poweredBy: {
          line: "Anthropic, Claude Sonnet 4.6",
          spend: "api_credits",
          note: "Codex on your paired computer is chosen, but the computer can't be reached right now, so your AI account answers.",
        },
      }),
    ),
  };
  console.log(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
