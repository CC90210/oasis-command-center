/**
 * components/agents/sse-client.ts - read a server-sent-events body in the
 * browser: frames of `event:` and `data:` lines, separated by a blank line.
 * Comment lines (": ping") keep a connection open and carry nothing.
 *
 * PURE apart from the reader it is given, so tests run it on a plain stream.
 */
export type SseFrame = { event: string; data: unknown };

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const raw of frames) {
        const frame = parseFrame(raw);
        if (frame) yield frame;
      }
    }
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event = "message";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}
