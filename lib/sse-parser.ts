/**
 * Shared SSE parser — `event:` + `data:` framed streams.
 *
 * Used by every server-side bit that consumes an SSE response body. Lives
 * here as a single source instead of being duplicated:
 *   - lib/providers.ts (Anthropic/OpenAI/Google/OpenRouter/Ollama adapters)
 *   - lib/cloud-tool-runner.ts (native Anthropic tool_use loop)
 *
 * The parser is generic over Anthropic's vs OpenAI's framing because both
 * use the same wire shape:
 *   event: NAME     ← optional; defaults to "message" (OpenAI omits it)
 *   data: JSON     ← may be `[DONE]` to signal end (OpenAI convention)
 *   <blank line>   ← frame separator
 *
 * Yields `{ event, data }` where data is either a parsed object, the raw
 * string (if JSON parse fails — keeps callers in control of strictness),
 * or the literal `"[DONE]"` sentinel.
 */

// `data` is either a parsed JSON value, the raw string when JSON parse
// fails, or the literal "[DONE]" sentinel. Callers narrow data locally so
// every provider integration that consumes this generator can read
// shape-specific fields (choices, delta, usageMetadata) without each
// site re-narrowing — the SSE wire is genuinely untyped at the source.
export type SSEFrame = { event: string; data: unknown };

export function asSSERecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asSSEArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Line endings: the SSE spec allows CRLF, LF or CR. Google's
 * streamGenerateContent?alt=sse frames with CRLF ("data: {...}\r\n\r\n"),
 * Anthropic and OpenAI with LF. A parser that only splits on "\n\n" never finds
 * a frame boundary in a CRLF stream and yields nothing, which is how every
 * Gemini department reply came back empty on 2026-10-09 (no text, no usage).
 * So every chunk is normalised to LF before framing; a CR at the very end of a
 * chunk is held back in case its LF arrives in the next chunk.
 *
 * End of stream: a final frame with no trailing blank line is still a frame
 * (the stream closing ends it), so it is yielded instead of dropped.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<SSEFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let pendingCR = false;
  const normalise = (text: string, final: boolean): string => {
    let t = (pendingCR ? "\r" : "") + text;
    pendingCR = !final && t.endsWith("\r");
    if (pendingCR) t = t.slice(0, -1);
    return t.replace(/\r\n?/g, "\n");
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buf += normalise(decoder.decode(), true);
      break;
    }
    buf += normalise(decoder.decode(value, { stream: true }), false);
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = toFrame(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
      if (frame) yield frame;
    }
  }
  const last = toFrame(buf);
  if (last) yield last;
}

function toFrame(block: string): SSEFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  const raw = dataLines.join("\n");
  if (raw === "[DONE]") return { event, data: "[DONE]" };
  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    return { event, data: raw };
  }
}

/**
 * Read up to 500 chars from a Response body for use in an error message.
 * Swallows errors — this is best-effort surface area, not load-bearing.
 */
export async function safeText(r: Response): Promise<string> {
  try {
    return (await r.text()).slice(0, 500);
  } catch {
    return "";
  }
}
