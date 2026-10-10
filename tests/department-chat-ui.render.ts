/**
 * The server-render half of tests/department-chat-ui.test.ts: what the
 * department channel's pieces draw, rendered where React is whole (the suite
 * runs under --conditions=react-server, where react-dom/server does not
 * resolve; see tests/os-channels-honest.render.ts). Prints one JSON object of
 * markup by scenario; asserts nothing.
 */
export {};
async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ActivityTrail } = await import("../components/agents/ActivityTrail");
  const { ConversationRail } = await import("../components/agents/ConversationRail");
  const { Message, DepartmentChat } = await import("../components/agents/DepartmentChat");
  const { emptyRunView, reduceRunEvents } = await import("../lib/os/runs/reduce");

  const view = (events: Array<[number, string, Record<string, unknown>]>) =>
    reduceRunEvents(events.map(([seq, kind, data]) => ({ seq, kind: kind as never, data })));
  const lookup = view([
    [1, "agent", { display_name: "Sales", model: "gemini-x", runs_on: "Google Gemini (API)", spend: "api_credits" }],
    [2, "tool", { id: "t1", phase: "start", label: "Looking up Pipeline", ok: null }],
    [3, "tool", { id: "t1", phase: "done", ok: true, detail: "12 leads", size: 4096 }],
    [4, "tool", { id: "t2", phase: "start", label: "Looking up Calendar", ok: null }],
  ]);
  const reasoning = view([
    [1, "thinking", { text: "Checking the pipeline first." }],
    [2, "tool", { id: "t1", phase: "start", label: "Looking up Pipeline", ok: null }],
  ]);
  const finished = view([
    [1, "tool", { id: "t1", phase: "start", label: "Looking up Pipeline", ok: null }],
    [2, "tool", { id: "t1", phase: "done", ok: true, detail: "12 leads", size: 900 }],
    [3, "tool", { id: "t2", phase: "start", label: "Looking up Calendar", ok: null }],
    [4, "tool", { id: "t2", phase: "done", ok: false }],
    [5, "done", { status: "done" }],
  ]);
  const item = (over: Record<string, unknown>) => ({
    key: "k",
    runId: "r1",
    seq: 1,
    userText: "How is the pipeline?",
    status: "done",
    view: emptyRunView(),
    text: "",
    via: null,
    failure: null,
    stopping: false,
    live: true,
    ...over,
  });
  const msg = (over: Record<string, unknown>, canManageAi = true) =>
    renderToStaticMarkup(React.createElement(Message, { item: item(over) as never, canManageAi, onStop: () => undefined }));

  const out = {
    trailWorking: renderToStaticMarkup(React.createElement(ActivityTrail, { view: lookup, running: true })),
    trailReasoning: renderToStaticMarkup(React.createElement(ActivityTrail, { view: reasoning, running: true })),
    trailStarting: renderToStaticMarkup(React.createElement(ActivityTrail, { view: emptyRunView(), running: true })),
    trailFinished: renderToStaticMarkup(React.createElement(ActivityTrail, { view: finished, running: false })),
    trailNothing: renderToStaticMarkup(React.createElement(ActivityTrail, { view: emptyRunView(), running: false })),
    rail: renderToStaticMarkup(
      React.createElement(ConversationRail, {
        state: {
          conversationId: "c1",
          listState: "ready",
          conversations: [
            { id: "c1", title: "Pipeline check", lastMessageAt: new Date().toISOString(), activeRuns: 1 },
            { id: "c2", title: "Follow-ups", lastMessageAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), activeRuns: 0 },
          ],
        },
        onOpen: () => undefined,
        onNew: () => undefined,
        onRename: () => undefined,
        onDelete: () => undefined,
      }),
    ),
    railEmpty: renderToStaticMarkup(
      React.createElement(ConversationRail, {
        state: { conversationId: null, listState: "ready", conversations: [] },
        onOpen: () => undefined,
        onNew: () => undefined,
        onRename: () => undefined,
        onDelete: () => undefined,
      }),
    ),
    msgQueued: msg({ status: "queued", runId: "r2" }),
    msgSending: msg({ status: "sending", runId: null }),
    msgRunning: msg({ status: "running", view: { ...lookup, text: "Twelve leads so far" }, text: "" }),
    msgDone: msg({ status: "done", view: finished, text: "Twelve leads. Two need a call.", via: "Google Gemini (API) - uses API credits" }),
    msgFailed: msg({ status: "failed", failure: { code: "provider_401", model: null }, text: "Partial." }, false),
    msgInterrupted: msg({ status: "interrupted", failure: { code: "interrupted", model: null }, text: "Half an ans" }),
    msgCancelled: msg({ status: "cancelled", text: "Starting." }),
    channel: renderToStaticMarkup(
      React.createElement(DepartmentChat, {
        department: "sales",
        agentSlug: "sdr",
        agentName: "Sales",
        agentSubtitle: "Department channel",
        greeting: "Ask Sales anything.",
        canManageAi: true,
        poweredBy: { line: "Claude Code on your paired computer", spend: "cli_subscription", note: null },
      }),
    ),
  };
  console.log(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
