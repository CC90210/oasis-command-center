/**
 * POST /api/telegram/link-code — generate a one-time code to link the signed-in
 * user's Telegram (Batch 4, self-serve). Stores `{code, expires_at}` in the
 * user's user_profiles.custom_fields.telegram_link; the user sends `/start <code>`
 * to the bot, and /api/telegram/webhook redeems it → sets telegram_chat_id.
 * No schema migration (JSONB custom_fields).
 */
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CODE_TTL_MS = 10 * 60 * 1000;

function genCode(): string {
  // 8 chars, unambiguous base32 alphabet (no 0/O/1/I).
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export async function POST() {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const db = getServiceSupabase();
  const cur = await db
    .from("user_profiles")
    .select("custom_fields")
    .eq("auth_user_id", sess.userId)
    .maybeSingle();
  if (cur.error) {
    return NextResponse.json({ ok: false, error: "profile_read_failed" }, { status: 500 });
  }
  const customFields =
    (cur.data as { custom_fields?: Record<string, unknown> | null } | null)?.custom_fields || {};
  const code = genCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
  const upd = await db
    .from("user_profiles")
    .update({ custom_fields: { ...customFields, telegram_link: { code, expires_at: expiresAt } } })
    .eq("auth_user_id", sess.userId);
  if (upd.error) {
    return NextResponse.json({ ok: false, error: "code_save_failed" }, { status: 500 });
  }

  const botUsername = process.env.SUNBIZ_TELEGRAM_BOT_USERNAME || "";
  const deepLink = botUsername ? `https://t.me/${botUsername}?start=${code}` : null;
  return NextResponse.json({
    ok: true,
    code,
    expires_at: expiresAt,
    deep_link: deepLink,
    instructions: deepLink
      ? "Open the bot link and tap Start — you'll be linked automatically."
      : `Open the SunBiz Telegram bot and send:  /start ${code}`,
  });
}
