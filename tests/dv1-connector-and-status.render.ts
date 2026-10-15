/**
 * The server-render half of tests/dv1-connector-and-status.test.ts, same
 * reason tests/department-chat-ui.render.ts exists: the parent runs under
 * --conditions=react-server, where react-dom/server does not resolve. Prints
 * one JSON object of markup by scenario; asserts nothing.
 */
export {};
async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ConnectYourComputerCard } = await import("../components/settings/YourComputersCard");
  const { Message } = await import("../components/agents/DepartmentChat");
  const { emptyRunView } = await import("../lib/os/runs/reduce");
  const { computerStatusLine } = await import("../components/agents/chat-shared");

  const item = (over: Record<string, unknown>) => ({
    key: "k",
    runId: "r1",
    seq: 1,
    userText: "How is the pipeline?",
    status: "queued",
    view: emptyRunView(),
    text: "",
    via: null,
    failure: null,
    stopping: false,
    live: true,
    executor: null,
    ...over,
  });
  const msg = (over: Record<string, unknown>, computerStatus: string | null = null) =>
    renderToStaticMarkup(
      React.createElement(Message, { item: item(over) as never, canManageAi: true, onStop: () => undefined, computerStatus }),
    );

  const label = "ANN-LAPTOP (Windows)";
  const out = {
    // DV1 item 1 -- the connector card, idle state (useEffect never runs
    // under a static render, so this is deterministically "no code yet").
    connectIdle: renderToStaticMarkup(React.createElement(ConnectYourComputerCard)),

    // DV1 item 2 -- the deferred O4 status line, each of its three live
    // states, plus the unchanged default (no executor) for regression safety.
    msgQueuedWorker: msg({ status: "queued", executor: null }, null),
    msgQueuedComputerWaiting: msg({ status: "queued", executor: "computer" }, computerStatusLine({ executor: "computer", status: "queued", label, busy: false })),
    msgQueuedComputerBusy: msg({ status: "queued", executor: "computer" }, computerStatusLine({ executor: "computer", status: "queued", label, busy: true })),
    msgRunningComputer: msg({ status: "running", executor: "computer", view: { ...emptyRunView(), text: "" } }, computerStatusLine({ executor: "computer", status: "running", label, busy: false, engine: "Codex" })),
    msgRunningWorker: msg({ status: "running", executor: "worker", view: { ...emptyRunView(), text: "" } }, null),
  };
  console.log(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
