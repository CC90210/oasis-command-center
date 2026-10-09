/**
 * lib/os/desk/gemini-loop.ts - Google Gemini function calling for a department
 * turn, the Gemini twin of lib/cloud-tool-runner.ts's Anthropic and
 * OpenAI-compatible loops (same StreamYield events, same metering).
 *
 * Gemini answers with `functionCall` parts; the next request carries the
 * model's turn back VERBATIM (its parts in order, with any `thoughtSignature`:
 * Gemini 3 refuses a follow-up whose function-call turn lost its signature,
 * Gemini docs "Thought signatures") and one `functionResponse` part per call.
 *
 * Metered exactly like lib/providers.ts streamGoogle: each request reserves
 * against the workspace's month before it is sent (meter.begin) and records
 * one ai_usage_events row, thinking tokens included. The thinking level and
 * headroom are streamGoogle's (Gemini 3.x thinks against the output cap).
 *
 * A turn that ends with no answer text is a failed turn (empty_reply:<why>),
 * as everywhere else (lib/providers.ts EmptyReplyKind).
 */

import "server-only";
import { fetchWithRetry } from "@/lib/retry";
import { asSSEArray, asSSERecord, parseSSE, safeText } from "@/lib/sse-parser";
import { emptyReplyKind, finishKind, geminiTakesThinkingLevel, THINKING_HEADROOM_TOKENS, type FinishKind } from "@/lib/providers";
import type { CallEnd, ModelCall, ModelCallMeter, ModelUsage } from "@/lib/ai/usage";
import { meterRefusalCode } from "@/lib/ai/usage-codes";
import { resolveCall } from "@/lib/ai/model-registry";
import type { InjectedToolset, StreamYield } from "@/lib/cloud-tool-runner";

export const GEMINI_MAX_TOOL_ITERATIONS = 8;
const utf8 = new TextEncoder();

type Part = Record<string, unknown>;
type Content = { role: "user" | "model"; parts: Part[] };

export type GeminiToolLoopRequest = {
  apiKey: string;
  model: string;
  system: string;
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
  maxTokens: number;
  meter: ModelCallMeter;
  toolset: InjectedToolset;
};

const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);

function functionResponseOf(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { result: parsed };
  } catch {
    return { result: content };
  }
}

export function hasInputs(schema: unknown): boolean {
  const props = (schema as { properties?: unknown } | null)?.properties;
  return !!props && typeof props === "object" && Object.keys(props).length > 0;
}

export async function* streamGeminiWithTools(req: GeminiToolLoopRequest): AsyncGenerator<StreamYield> {
  const { model, meter } = resolveCall("google", req.model, req.meter);
  const thinks = geminiTakesThinkingLevel(model);
  const maxOut = req.maxTokens + (thinks ? THINKING_HEADROOM_TOKENS : 0);
  const contents: Content[] = req.messages
    .filter((m) => m.content && m.content.length > 0)
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  // Gemini answers 400 to an OBJECT schema with no properties, so a tool
  // that takes no input is declared without `parameters`.
  const declarations = req.toolset.tools.map((t) => ({ name: t.name, description: t.description, ...(hasInputs(t.input_schema) ? { parameters: t.input_schema } : {}) }));
  const allowed = new Set(req.toolset.tools.map((t) => t.name));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

  let totalIn = 0;
  let totalOut = 0;
  let unreportedCalls = 0;
  let answered = false;

  for (let iter = 0; iter < GEMINI_MAX_TOOL_ITERATIONS; iter++) {
    const body: Record<string, unknown> = {
      contents,
      systemInstruction: { role: "user", parts: [{ text: req.system }] },
      generationConfig: thinks ? { maxOutputTokens: maxOut, thinkingConfig: { thinkingLevel: "low" } } : { maxOutputTokens: maxOut },
    };
    if (declarations.length > 0) {
      body.tools = [{ functionDeclarations: declarations }];
      body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    }
    const json = JSON.stringify(body);
    let call: ModelCall;
    try {
      call = await meter.begin({ provider: "google", model, maxOutputTokens: maxOut, promptBytes: utf8.encode(json).length });
    } catch (err) {
      yield { type: "error", message: meterRefusalCode(err) };
      return;
    }

    const modelParts: Part[] = [];
    const calls: Array<{ name: string; args: Record<string, unknown>; id: string | null }> = [];
    let finish: FinishKind | null = null;
    const ledger: ModelUsage = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null };
    let complete = false;
    let stepIn = 0;
    let stepOut = 0;
    let end: CallEnd | null = null;
    let iterAnswered = false;
    try {
      const res = await fetchWithRetry(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": req.apiKey },
        body: json,
      });
      if (!res.ok || !res.body) {
        const detail = await safeText(res);
        end = res.ok ? { outcome: "error", errorCode: "empty_body" } : { outcome: "error", errorCode: `http_${res.status}`, notBilled: true };
        yield {
          type: "error",
          message: res.status >= 500 || res.status === 429 ? `provider_temporarily_unavailable:google_${res.status}` : `google_${res.status}:${detail}`,
        };
        return;
      }
      for await (const ev of parseSSE(res.body)) {
        const data = asSSERecord(ev.data);
        if (!data) continue;
        const candidate = asSSERecord(asSSEArray(data.candidates)[0]);
        for (const raw of asSSEArray(asSSERecord(candidate?.content)?.parts)) {
          const part = asSSERecord(raw);
          if (!part) continue;
          // Kept verbatim (signature and all) for the next request.
          modelParts.push(part);
          if (part.thought === true) continue;
          if (typeof part.text === "string" && part.text.length > 0) {
            if (part.text.trim()) iterAnswered = true;
            yield { type: "delta", text: part.text };
          }
          const fc = asSSERecord(part.functionCall);
          if (fc && typeof fc.name === "string" && fc.name) {
            calls.push({ name: fc.name, args: asSSERecord(fc.args) ?? {}, id: typeof fc.id === "string" ? fc.id : null });
          }
        }
        finish = finishKind("google", candidate?.finishReason) ?? finish;
        if (typeof asSSERecord(data.promptFeedback)?.blockReason === "string") finish = "blocked";
        const u = asSSERecord(data.usageMetadata);
        if (u) {
          const prompt = typeof u.promptTokenCount === "number" ? u.promptTokenCount : null;
          const thoughts = typeof u.thoughtsTokenCount === "number" ? u.thoughtsTokenCount : null;
          const cand = typeof u.candidatesTokenCount === "number" ? u.candidatesTokenCount : thoughts !== null ? 0 : null;
          const cached = num(u.cachedContentTokenCount, 0);
          stepIn = num(u.promptTokenCount, stepIn);
          stepOut = cand === null ? stepOut : cand + (thoughts ?? 0);
          ledger.inputTokens = prompt === null ? null : Math.max(prompt - cached, 0);
          ledger.outputTokens = cand === null ? null : cand + (thoughts ?? 0);
          ledger.cacheReadTokens = cached;
          ledger.cacheWriteTokens = 0;
          complete = prompt !== null && cand !== null;
        }
      }
      if (iterAnswered) answered = true;
      // The last step of a turn that never answered is a failed call.
      end =
        calls.length === 0 && !answered
          ? { outcome: "error", errorCode: `empty_reply_${emptyReplyKind(finish)}`, usage: complete ? ledger : null }
          : { outcome: "ok", usage: complete ? ledger : null };
    } catch (err) {
      end = { outcome: "error", errorCode: "stream_failed", usage: null };
      throw err;
    } finally {
      await call.finish(end ?? { outcome: "cancelled", usage: null });
    }
    totalIn += stepIn;
    totalOut += stepOut;
    if (!complete) unreportedCalls += 1;

    if (calls.length === 0) {
      if (!answered) {
        yield { type: "error", message: `empty_reply:${emptyReplyKind(finish)}` };
        return;
      }
      yield { type: "done", inputTokens: totalIn, outputTokens: totalOut, unreportedCalls };
      return;
    }

    contents.push({ role: "model", parts: modelParts });
    const responses: Part[] = [];
    for (const c of calls) {
      let content: string;
      if (!allowed.has(c.name)) {
        content = JSON.stringify({ error: "tool_not_in_this_department", tool: c.name });
        yield { type: "tool_result", name: c.name, ok: false, summary: `${c.name} blocked - not in this department's tools` };
      } else {
        yield { type: "tool_use", name: c.name, input: c.args };
        const r = await req.toolset.execute(c.name, c.args);
        yield { type: "tool_result", name: c.name, ok: !r.is_error, summary: r.summary };
        content = r.content;
      }
      responses.push({ functionResponse: { name: c.name, ...(c.id ? { id: c.id } : {}), response: functionResponseOf(content) } });
    }
    contents.push({ role: "user", parts: responses });
  }
  yield { type: "error", message: `tool_loop_exhausted_after_${GEMINI_MAX_TOOL_ITERATIONS}_iterations` };
}
