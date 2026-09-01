/**
 * Self-service personal Telegram bot linking. The signed-in employee creates
 * their own bot in BotFather and links it here — no developer involvement.
 *   GET    → status { connected, username, linked, chat_id }
 *   POST { action: "validate", bot_token } → getMe-verify + store (encrypted)
 *   POST { action: "link" } → read getUpdates, capture the user's chat_id
 *   DELETE → disconnect
 * The bot token is never returned to the client.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import {
  validateAndStoreBot,
  captureChatId,
  getTelegramStatus,
  disconnectTelegram,
} from "@/lib/integrations/telegram-personal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const s = await resolveSessionContext();
  if (!s.ok) return NextResponse.json({ ok: false, error: s.reason }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, ...(await getTelegramStatus(s.tenantId, s.userId)) });
  } catch (error) {
    console.error("[personal-telegram-status] unable to read status", {
      tenantId: s.tenantId,
      userId: s.userId,
      error,
    });
    return NextResponse.json(
      { ok: false, error: "personal_telegram_status_unavailable" },
      { status: 503 },
    );
  }
}

export async function POST(req: NextRequest) {
  const s = await resolveSessionContext();
  if (!s.ok) return NextResponse.json({ ok: false, error: s.reason }, { status: 401 });

  let body: { action?: string; bot_token?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  if (body.action === "validate") {
    const r = await validateAndStoreBot(s.tenantId, s.userId, body.bot_token || "");
    return NextResponse.json(r, {
      status: r.ok ? 200 : r.error === "telegram_store_failed" ? 503 : 400,
    });
  }
  if (body.action === "link") {
    const r = await captureChatId(s.tenantId, s.userId);
    // no_message_yet is the "you haven't messaged the bot yet" case → 409 so the
    // UI can prompt "message your bot first" without treating it as a hard error.
    const status = r.ok
      ? 200
      : r.error === "no_message_yet"
        ? 409
        : r.error === "telegram_store_failed"
          ? 503
          : 400;
    return NextResponse.json(r, { status });
  }
  return NextResponse.json({ ok: false, error: "unknown_action" }, { status: 400 });
}

export async function DELETE() {
  const s = await resolveSessionContext();
  if (!s.ok) return NextResponse.json({ ok: false, error: s.reason }, { status: 401 });
  const result = await disconnectTelegram(s.tenantId, s.userId);
  if (!result.ok) {
    console.error("[personal-telegram] unable to disconnect", {
      tenantId: s.tenantId,
      userId: s.userId,
      error: result.error,
    });
    return NextResponse.json(
      { ok: false, error: "personal_telegram_disconnect_failed" },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true });
}
