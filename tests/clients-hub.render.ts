/**
 * The server-render half of tests/clients-hub.test.ts.
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`,
 * under which `react-dom/server` does not resolve and `react` exports no
 * `useRef` or `useCallback`. The client record's thread (ClientThread ->
 * MessageList -> MessageBubble) is a client component, so the only way to see
 * what it draws is to render it where React is whole. The test spawns THIS
 * file with plain `node --import tsx`, writes the messages to its stdin, and
 * asserts against the markup it prints (the same pattern as
 * tests/os-channels-honest.render.ts).
 *
 * `React` is set on globalThis before any component loads: tsconfig.json sets
 * jsx:"preserve", so tsx compiles the components with the classic runtime,
 * which reads a global React.
 *
 * It asserts nothing: every assertion lives in the .test.ts.
 */
import type { ConversationMessage } from "../lib/conversation-threading";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ClientThread } = await import("../components/os/landings/client-conversations");
  const messages = JSON.parse(await readStdin()) as ConversationMessage[];
  process.stdout.write(JSON.stringify({ thread: renderToStaticMarkup(React.createElement(ClientThread, { messages })) }));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
