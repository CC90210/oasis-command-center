/**
 * sse-parser.test.ts - the shared SSE reader frames every line ending the spec
 * allows, across chunk boundaries, and keeps a last frame with no blank line.
 *
 * WHY (CC, 2026-10-09). After #561 every Gemini department reply still came
 * back empty: Google's streamGenerateContent?alt=sse frames with CRLF, the
 * parser split only on "\n\n", so it found no frame at all (no text, no usage;
 * ledger empty_reply_empty, 8.6 s). The stubs in the other suites used LF, so
 * they passed while production failed. These checks use the real wire shapes.
 *
 * Run: node --conditions=react-server --import tsx tests/sse-parser.test.ts
 */
import assert from "node:assert/strict";
import { parseSSE, type SSEFrame } from "../lib/sse-parser";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}
async function frames(chunks: string[]): Promise<SSEFrame[]> {
  const out: SSEFrame[] = [];
  for await (const f of parseSSE(streamOf(chunks))) out.push(f);
  return out;
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").join("\n        ")}`);
  }
}

const g1 = { candidates: [{ content: { role: "model", parts: [{ text: "Hey" }] } }] };
const g2 = { candidates: [{ content: { role: "model", parts: [{ text: " there" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 } };

async function main() {
  console.log("sse parser:");
  await check("Google's CRLF frames are read (the 2026-10-09 empty-reply cause)", async () => {
    const got = await frames([`data: ${JSON.stringify(g1)}\r\n\r\ndata: ${JSON.stringify(g2)}\r\n\r\n`]);
    assert.deepEqual(got.map((f) => f.data), [g1, g2]);
  });
  await check("a CRLF split across chunks, even between \\r and \\n, still frames", async () => {
    const wire = `data: ${JSON.stringify(g1)}\r\n\r\ndata: ${JSON.stringify(g2)}\r\n\r\n`;
    const cut = wire.indexOf("\r\n\r\n") + 1; // after the first \r
    const got = await frames([wire.slice(0, cut), wire.slice(cut, cut + 3), wire.slice(cut + 3)]);
    assert.deepEqual(got.map((f) => f.data), [g1, g2]);
  });
  await check("Anthropic/OpenAI LF frames, event names and [DONE] are unchanged", async () => {
    const got = await frames([`event: message_start\ndata: {"a":1}\n\n`, `data: {"b":2}\n\ndata: [DONE]\n\n`]);
    assert.deepEqual(got, [
      { event: "message_start", data: { a: 1 } },
      { event: "message", data: { b: 2 } },
      { event: "message", data: "[DONE]" },
    ]);
  });
  await check("bare CR line endings (allowed by the spec) frame too", async () => {
    const got = await frames([`data: {"c":3}\r\r`]);
    assert.deepEqual(got.map((f) => f.data), [{ c: 3 }]);
  });
  await check("a last frame with no trailing blank line is kept, not dropped", async () => {
    const got = await frames([`data: ${JSON.stringify(g1)}\r\n\r\ndata: ${JSON.stringify(g2)}`]);
    assert.deepEqual(got.map((f) => f.data), [g1, g2]);
  });
  await check("non-JSON data stays raw; blank frames yield nothing", async () => {
    const got = await frames([`\r\n\r\ndata: not json\r\n\r\n`]);
    assert.deepEqual(got, [{ event: "message", data: "not json" }]);
  });
  if (failures) {
    console.log(`sse parser: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("sse parser: all passed");
}
main();
