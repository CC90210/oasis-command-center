/**
 * POST /api/conversations/ai-reply — generate a TextTorrent AI reply
 * suggestion for an inbox thread.
 *
 * Phase 3b of the TT + Kixie full embedding plan (2026-06-02).
 *
 * DEPRECATED (2026-07, plan §6.3/§9 compiled-tumbling-gem.md Phase 2): this
 * TT black-box endpoint is superseded by /api/conversations/voice-suggest
 * (per-rep voice, fenced input, schema-validated, lender-name/em-dash
 * sanitize). Gated OFF by default behind USE_TT_AI_REPLY so the new route
 * is the path; kept for one release so the Composer's "AI reply" affordance
 * (only shown when thread.tt_chat_id is set) still resolves cleanly instead
 * of dangling. Delete this file + the Composer "AI reply" button/prop once
 * the flag has been off in prod for a release.
 *
 * Body: { chat_id: string, tone?: string }
 *
 * TT's generate-ai endpoint needs a TT chat_id. We surface that on a thread
 * only when an inbound TT SMS populated metadata.tt_chat_id (see the TT
 * inbound webhook). The client hides the AI-reply button when no chat_id is
 * available, so this route returns { ok:false, error:"no_tt_chat" } as a
 * defensive fallback rather than throwing.
 *
 * Read-only — produces a suggestion the operator edits before sending. It
 * never sends, so no dry-run gate applies here (the send happens via
 * /api/conversations/reply, which is gated).
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveTenantId } from "@/lib/api-auth";
import { getTextTorrentCredentials, generateAiReply, TextTorrentError } from "@/lib/integrations/texttorrent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function ttAiReplyEnabled(): boolean {
  return (process.env.USE_TT_AI_REPLY || "").toLowerCase() === "true";
}

export async function POST(req: NextRequest) {
  if (!ttAiReplyEnabled()) {
    return NextResponse.json(
      {
        ok: false,
        error: "deprecated",
        message: "AI reply (TextTorrent) has been retired — use the Suggest button for a voice-matched draft instead.",
      },
      { status: 410 },
    );
  }

  const tenantId = await resolveTenantId();
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { chat_id?: unknown; tone?: unknown };
  try {
    body = (await req.json().catch(() => ({}))) as typeof body;
  } catch {
    body = {};
  }
  const chatId = typeof body.chat_id === "string" ? body.chat_id.trim() : "";
  const tone = typeof body.tone === "string" && body.tone.trim() ? body.tone.trim() : undefined;
  if (!chatId) {
    return NextResponse.json({ ok: false, error: "no_tt_chat" }, { status: 400 });
  }

  try {
    const creds = await getTextTorrentCredentials(tenantId);
    const r = await generateAiReply(creds, { chat_id: chatId, tone });
    return NextResponse.json({ ok: true, suggestion: r.data.suggestion });
  } catch (err) {
    if (err instanceof TextTorrentError) {
      const status = err.status === 429 ? 429 : err.code === "missing_credentials" ? 400 : 502;
      return NextResponse.json({ ok: false, error: err.code, message: err.message }, { status });
    }
    return NextResponse.json(
      { ok: false, error: "ai_reply_failed", message: err instanceof Error ? err.message : "failed" },
      { status: 502 },
    );
  }
}
