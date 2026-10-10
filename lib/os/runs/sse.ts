/**
 * lib/os/runs/sse.ts - run frames (./follow.ts) on the wire as server-sent events.
 *
 *   event: run     data: { id, conversation_id, seq, status, user_text, ... }  the run being followed
 *   event: ev      data: { run_id, seq, kind, data }                           one saved event
 *   event: end     data: { id, status, final_text, error_code, ... }           the run is over
 *   event: window  data: {}                                                    ask again with the last seq
 *   event: gone    data: { run_id }                                            the run was deleted
 *   : ping                                                                     keeps an idle connection open
 *
 * A reply is read from `ev` frames while the run works and from `end`'s
 * final_text once it is over (the reply events are dropped when a run ends).
 */
import "server-only";
import type { Frame, RunHead } from "./follow";

const enc = new TextEncoder();

function head(h: RunHead): Record<string, unknown> {
  return {
    id: h.id,
    conversation_id: h.conversationId,
    seq: h.seq,
    status: h.status,
    user_text: h.userText,
    final_text: h.finalText,
    error_code: h.errorCode,
    source: h.source,
  };
}

export function encodeFrame(f: Frame): string {
  switch (f.type) {
    case "ping":
      return ": ping\n\n";
    case "run":
      return `event: run\ndata: ${JSON.stringify(head(f.run))}\n\n`;
    case "end":
      return `event: end\ndata: ${JSON.stringify(head(f.run))}\n\n`;
    case "event":
      return `event: ev\ndata: ${JSON.stringify({ run_id: f.runId, seq: f.event.seq, kind: f.event.kind, data: f.event.data })}\n\n`;
    case "window":
      return "event: window\ndata: {}\n\n";
    case "gone":
      return `event: gone\ndata: ${JSON.stringify({ run_id: f.runId })}\n\n`;
  }
}

/**
 * A streaming response over frames. The reader's disconnect ends the READ only
 * (`gone()` turns true and the generator is closed); it never touches a driver,
 * which is a separate promise the caller registered with the platform.
 */
export function sseResponse(frames: AsyncGenerator<Frame>, extra: { prelude?: string; onGone: () => void }): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (extra.prelude) controller.enqueue(enc.encode(extra.prelude));
    },
    async pull(controller) {
      try {
        const next = await frames.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(encodeFrame(next.value)));
      } catch (err) {
        console.error("[os.runs.sse]", err instanceof Error ? (err.stack ?? err.message) : String(err));
        controller.enqueue(enc.encode(`event: failed\ndata: ${JSON.stringify({ error: "stream_failed" })}\n\n`));
        controller.close();
      }
    },
    cancel() {
      extra.onGone();
      void frames.return(undefined).catch(() => undefined);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
  });
}
