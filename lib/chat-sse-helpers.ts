/**
 * lib/chat-sse-helpers.ts — shared SSE `send` factory for the cloud
 * chat surfaces (/api/chat and /api/chat/resume).
 *
 * Both routes used to inline ~30 identical lines of redactor + pause-
 * tracking + terminal-events logic, which is exactly the drift trap
 * that previously bit us with CUSTOM_SERVICE / CUSTOM_CREDENTIAL_SERVICE
 * / CUSTOM_VAULT_SERVICE: a future change to the routing semantics
 * would have to land in two places, and quietly desynced. This factory
 * is the canonical home — both routes now call it.
 *
 * Behavior contract (matches what each route used to do):
 *   - delta events route through a StreamingRedactor. The redactor
 *     holds back the trailing maxSecretLen-1 characters so a secret
 *     spanning two chunks still matches.
 *   - Non-delta events emit as-is.
 *   - The redactor's held tail flushes ONLY on truly terminal events
 *     (done, error). Mid-stream events (tool_use, cloud_tool_call,
 *     cloud_tool_result, tool_use_pending, usage, session) do NOT
 *     flush — the assistant turn may continue with more deltas.
 *   - When `tool_use_pending` fires, the pause flag arms; subsequent
 *     `done` skips the flush. This is the pause/resume protection —
 *     a secret split across the boundary would otherwise have its
 *     prefix flushed before /api/chat/resume opens a fresh redactor
 *     with no buffer state.
 *
 * Why a factory (closure) vs class: keeps the call-site shape as a
 * plain `send(event, data)` callable identical to the original
 * routes; no .send() method noise.
 */

import { StreamingRedactor, type VaultSecret } from "./secret-redaction";

/** Generic SSE controller — just what we use from ReadableStreamDefaultController. */
type SseController = {
  enqueue(chunk: Uint8Array): void;
};

const TERMINAL_EVENTS = new Set(["done", "error"]);

export type RedactingSseSend = {
  /**
   * Emit an SSE event. Delta events are scrubbed via the streaming
   * redactor; non-delta events emit as-is. Terminal events flush the
   * redactor's held tail UNLESS the stream paused for a deferred-tool
   * resume (tool_use_pending arms a flag that suppresses the next
   * `done` flush so the buffer isn't released across the boundary).
   */
  send: (event: string, data: unknown) => void;
  /**
   * Manually flush the redactor's held tail. Almost never called
   * directly — the `send` function handles it on terminal events.
   * Exposed for callers that need to force-emit before close (e.g.,
   * a `controller.close()` reached without a preceding terminal
   * event — shouldn't happen but exposed as a safety valve).
   */
  flushDelta: () => void;
  /**
   * True after the stream observed a tool_use_pending event. Used by
   * callers that need to skip persistence behaviors that only apply
   * to truly-completed turns (e.g., session-totals update). Optional —
   * routes that don't care can ignore.
   */
  isPaused: () => boolean;
};

export function createRedactingSseSend(
  controller: SseController,
  vaultSecrets: VaultSecret[],
): RedactingSseSend {
  const encoder = new TextEncoder();
  const redactor = new StreamingRedactor(vaultSecrets);
  let pausedForResume = false;

  const emit = (event: string, data: unknown): void => {
    controller.enqueue(
      encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    );
  };

  const flushDelta = (): void => {
    const tail = redactor.flush();
    if (tail.length > 0) emit("delta", { text: tail });
  };

  const send = (event: string, data: unknown): void => {
    if (event === "delta" && data && typeof data === "object" && "text" in data) {
      const raw = String((data as { text: unknown }).text ?? "");
      const safe = redactor.push(raw);
      if (safe.length > 0) emit("delta", { text: safe });
      return;
    }
    if (event === "tool_use_pending") pausedForResume = true;
    if (TERMINAL_EVENTS.has(event) && !pausedForResume) flushDelta();
    emit(event, data);
  };

  return { send, flushDelta, isPaused: () => pausedForResume };
}
