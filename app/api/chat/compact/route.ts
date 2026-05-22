/**
 * POST /api/chat/compact
 *
 * Summarize a conversation history into a single paragraph so the operator
 * can keep going without burning context budget on prior turns. Powers the
 * `/compact` slash command in ChatWidget.
 *
 * Unlike POST /api/chat this endpoint is NOT streaming — the operator
 * wants the summary atomically so the client can replace the live
 * history with one assistant message in a single render.
 *
 * Auth: same Supabase session → tenant resolution as /api/chat. Uses the
 * same per-agent provider/model/api_key as the chat surface, so the
 * compaction cost lands on the operator's own quota — no platform key
 * fallback for the summarization itself.
 *
 * Request:
 *   { agent_key: string,
 *     messages: [{role: "user"|"assistant", content: string}, ...],
 *     focus?: string | null }   // optional hint about what to preserve
 *
 * Response:
 *   { ok: true, summary: string }
 *   { ok: false, error: string, code?: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/supabase-server";
import { streamChat, type ChatMessage } from "@/lib/providers";
import { resolveChatContext } from "@/lib/chat-auth";
import { isTenantChatAgent } from "@/lib/manifest/tenant-scope";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type IncomingMessage = { role?: string; content?: unknown };
type IncomingPayload = {
  agent_key?: string;
  messages?: IncomingMessage[];
  focus?: string | null;
};

function jsonError(status: number, message: string, code?: string) {
  const body: { ok: false; error: string; code?: string } = { ok: false, error: message };
  if (code) body.code = code;
  return NextResponse.json(body, { status });
}

const COMPACT_SYSTEM = `You are a conversation-compaction assistant. Your only job is to summarize the conversation provided in the user turn into a single paragraph that preserves:
- Every decision the operator made
- Every file path, table name, agent slug, or external identifier mentioned
- Every pending task or open question
- Any specific numbers (dollar amounts, dates, counts)
- The most recent direction or active intent

Compress sub-discussions; keep concrete facts. Output ONLY the summary paragraph — no preamble, no "Here's the summary", no bullets unless they preserve information that a paragraph would lose. Aim for 100–300 words.`;

function buildCompactionPrompt(messages: IncomingMessage[], focus: string | null | undefined): string {
  const transcript = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => `${(m.role as string).toUpperCase()}: ${String(m.content).trim()}`)
    .join("\n\n");
  const focusHint = focus && focus.trim()
    ? `\n\nFocus the summary on: ${focus.trim()}`
    : "";
  return `Compact the conversation below into one paragraph following the system rules.${focusHint}\n\n--- BEGIN CONVERSATION ---\n${transcript}\n--- END CONVERSATION ---`;
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return jsonError(401, "unauthorized");

  // Rate limit — compaction can be expensive (whole history → model input).
  // 6/min/user via the same token-bucket helper /api/chat uses.
  const rl = rateLimit({ key: `chat-compact:${user.id}`, capacity: 6, refillPerSec: 0.1 });
  if (!rl.allowed) return jsonError(429, "rate_limited");

  let payload: IncomingPayload;
  try {
    payload = (await req.json()) as IncomingPayload;
  } catch {
    return jsonError(400, "invalid_json");
  }

  const agentKey = String(payload.agent_key || "").toLowerCase();
  if (!agentKey) return jsonError(400, "missing_agent_key");

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  // Need at least one user + one assistant turn to summarize. Anything
  // less than that and the client should refuse before posting; we
  // double-check here so a stray empty payload doesn't hit the provider.
  const hasUser = messages.some((m) => m.role === "user");
  const hasAssistant = messages.some((m) => m.role === "assistant");
  if (!hasUser || !hasAssistant) {
    return jsonError(400, "nothing_to_compact");
  }

  const ctxResult = await resolveChatContext({ id: user.id, email: user.email }, agentKey);
  if (!ctxResult.ok) {
    return jsonError(ctxResult.status, ctxResult.detail || ctxResult.code, ctxResult.code);
  }
  const { tenantId, provider, model, apiKey } = ctxResult;

  if (!(await isTenantChatAgent(tenantId, agentKey))) {
    return jsonError(400, `invalid_agent:${agentKey}`);
  }

  // Build the compaction prompt: one user turn carrying the transcript,
  // one system turn carrying the rules. The model never sees the raw
  // history as conversation — only as text to summarize. That avoids
  // any chance of the model continuing the conversation instead of
  // summarizing it (a real failure mode on some smaller models).
  const compactionMessages: ChatMessage[] = [
    { role: "user", content: buildCompactionPrompt(messages, payload.focus) },
  ];

  let summary = "";
  let errorMessage: string | null = null;
  try {
    for await (const ev of streamChat({
      provider,
      model,
      apiKey,
      system: COMPACT_SYSTEM,
      messages: compactionMessages,
      maxTokens: 1024,
    })) {
      if (ev.type === "delta") summary += ev.text;
      else if (ev.type === "error") {
        errorMessage = ev.message;
        break;
      }
      // ev.type === "done" — fall through to return below.
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : "compact_failed";
  }

  if (errorMessage) {
    return jsonError(502, `compact_provider_error: ${errorMessage}`, "provider_error");
  }
  const trimmed = summary.trim();
  if (!trimmed) {
    return jsonError(502, "compact_empty_summary", "empty_summary");
  }
  return NextResponse.json({ ok: true, summary: trimmed });
}
