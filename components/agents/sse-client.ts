/**
 * components/agents/sse-client.ts - read a server-sent-events body in the
 * browser: frames of `event:` and `data:` lines, separated by a blank line.
 * Comment lines (": ping") keep a connection open and carry nothing.
 *
 * PURE apart from the reader it is given, so tests run it on a plain stream.
 */
export type SseFrame = { event: string; data: unknown };

export type AgentChatStreamFrame = {
  conversationId?: string;
  agent?: Record<string, unknown>;
  delta?: string;
  tool?: Record<string, unknown>;
  error?: { code: string; model?: unknown };
  finalText?: string;
  done?: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Normalize the original /api/agents/chat frames and the durable department
 * run frames onto the same small client contract. Device-backed department
 * turns use conversation/run/ev/end; API turns retain agent/delta/tool/error.
 */
export function normalizeAgentChatFrame(frame: SseFrame): AgentChatStreamFrame | null {
  const payload = record(frame.data);
  if (!payload) return null;

  if (frame.event === "conversation") {
    return typeof payload.id === "string" && payload.id ? { conversationId: payload.id } : null;
  }
  if (frame.event === "run") {
    return typeof payload.conversation_id === "string" && payload.conversation_id
      ? { conversationId: payload.conversation_id }
      : null;
  }
  if (frame.event === "ev") {
    const kind = typeof payload.kind === "string" ? payload.kind : "";
    return normalizeAgentChatFrame({ event: kind, data: payload.data });
  }
  if (frame.event === "agent") return { agent: payload };
  if (frame.event === "delta") {
    return typeof payload.text === "string" && payload.text ? { delta: payload.text } : null;
  }
  if (frame.event === "tool") return { tool: payload };
  if (frame.event === "error" || frame.event === "failed") {
    const code = typeof payload.code === "string"
      ? payload.code
      : typeof payload.error === "string"
        ? payload.error
        : "provider_error";
    return { error: { code, ...(payload.model !== undefined ? { model: payload.model } : {}) } };
  }
  if (frame.event === "end") {
    const conversationId = typeof payload.conversation_id === "string" && payload.conversation_id
      ? payload.conversation_id
      : undefined;
    const finalText = typeof payload.final_text === "string" && payload.final_text.trim()
      ? payload.final_text
      : undefined;
    const errorCode = typeof payload.error_code === "string" && payload.error_code
      ? payload.error_code
      : undefined;
    return {
      ...(conversationId ? { conversationId } : {}),
      ...(finalText ? { finalText } : {}),
      ...(errorCode ? { error: { code: errorCode } } : {}),
      done: true,
    };
  }
  if (frame.event === "done") return { done: true };
  if (frame.event === "gone") return { error: { code: "conversation_not_found" }, done: true };
  return null;
}

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
