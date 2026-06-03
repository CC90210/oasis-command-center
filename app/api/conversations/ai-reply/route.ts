/**
 * POST /api/conversations/ai-reply — generate a TextTorrent AI reply
 * suggestion for an inbox thread.
 *
 * Phase 3b of the TT + Kixie full embedding plan (2026-06-02).
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

export async function POST(req: NextRequest) {
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
