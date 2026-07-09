/**
 * POST /api/conversations/summarize
 *
 * AI thread summary + click-to-source key points for the Conversations
 * context panel (plan §5/§6, compiled-tumbling-gem.md Phase 2). Read-only —
 * produces a summary the panel renders; never persists or sends anything.
 *
 * Body: { lead_id?: string, thread_key?: string } — at least one required.
 * thread_key is the canonical `ConversationThread.key` (lead:<uuid> |
 * phone:<E164> | email:<addr> | id:<uuid>); lead_id is a convenience alias
 * that resolves to `lead:<uuid>`.
 *
 * Messages are re-queried server-side via loadThreadForAi — the client never
 * gets to hand us a transcript to summarize (that would let a compromised
 * tab inject fabricated "messages" straight into the prompt).
 *
 * Response 200: { ok: true, summary, key_points, summarized_at }
 * Response 4xx/5xx: { ok: false, error, message?, fallback: { summary, key_points } }
 *   — deterministic fallback so the card never renders a dead state.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { loadThreadForAi } from "@/lib/lead-interactions-queries";
import { summarizeConversation } from "@/lib/ai-conversation-summarize";
import { resolveBridgeForTenant } from "@/lib/bridge-for-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FALLBACK_SUMMARY = "Summary unavailable - try regenerating.";

export async function POST(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json(
      { ok: false, error: sess.reason },
      { status: sess.reason === "no_session" ? 401 : 400 },
    );
  }

  let body: { lead_id?: unknown; thread_key?: unknown };
  try {
    body = (await req.json().catch(() => ({}))) as typeof body;
  } catch {
    body = {};
  }

  let threadKey = typeof body.thread_key === "string" ? body.thread_key.trim() : "";
  if (!threadKey && typeof body.lead_id === "string" && UUID_RE.test(body.lead_id)) {
    threadKey = `lead:${body.lead_id}`;
  }
  if (!threadKey) {
    return NextResponse.json({ ok: false, error: "thread_key_required" }, { status: 400 });
  }

  const thread = await loadThreadForAi(sess.tenantId, threadKey, { limit: 30 });
  if (!thread || thread.messages.length === 0) {
    return NextResponse.json({ ok: false, error: "thread_not_found" }, { status: 404 });
  }

  try {
    // Subscription bridge (free) for eligible tenants; null → paid-API fallback.
    const bridgeTarget = await resolveBridgeForTenant(sess.tenantId);
    const result = await summarizeConversation(thread.messages, { bridgeTarget });
    return NextResponse.json({
      ok: true,
      summary: result.summary,
      key_points: result.key_points,
      summarized_at: result.summarized_at,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    let status = 500;
    let errorTag = "summarize_failed";
    if (message === "anthropic_key_missing") {
      status = 503;
      errorTag = "ai_unavailable";
    } else if (message.startsWith("summarize_parse_failed")) {
      status = 502;
      errorTag = "summarize_parse_failed";
    } else if (message === "no_messages") {
      status = 404;
      errorTag = "thread_not_found";
    }
    console.error("[conversations.summarize] failed", message);
    return NextResponse.json(
      {
        ok: false,
        error: errorTag,
        message,
        fallback: { summary: FALLBACK_SUMMARY, key_points: [] },
      },
      { status },
    );
  }
}
