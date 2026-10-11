/**
 * POST /api/telegram/webhook — Telegram bot webhook (Batch 4, self-serve link).
 *
 * Handles `/start <CODE>`: finds the user_profiles row whose
 * custom_fields.telegram_link.code matches (and isn't expired), sets
 * custom_fields.telegram_chat_id = the sender's chat id, clears the code, and
 * confirms. After that, the user receives per-lead application alerts.
 *
 * Setup (CC, one-time): set SUNBIZ_TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET
 * (REQUIRED; + optional SUNBIZ_TELEGRAM_BOT_USERNAME) as Worker secrets, then
 * call Telegram setWebhook -> https://oasisai.work/api/telegram/webhook with
 * secret_token set to the same TELEGRAM_WEBHOOK_SECRET.
 *
 * Auth is the secret header, and it FAILS CLOSED (2026-10-11). It used to be
 * checked only "if set": with TELEGRAM_WEBHOOK_SECRET unset, anyone who posted
 * a fake update carrying someone's valid link code could tie their own
 * Telegram chat to that person's profile and receive their lead alerts. Now:
 *   - secret unset (or blank): nothing is read or written; a loud error is
 *     logged and the answer is 200 {ok:false} (200 so a webhook that is still
 *     registered does not retry-storm; the update itself is refused);
 *   - secret set: compared in constant time, before the body is read; a
 *     mismatch (or no header) is 401.
 * Every other answer is 200 so Telegram doesn't retry-storm.
 */
import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { sendTelegram } from "@/lib/notify/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN = process.env.SUNBIZ_TELEGRAM_BOT_TOKEN || undefined;

/**
 * Reply as the bot the user actually messaged.
 *
 * This route needs SUNBIZ_TELEGRAM_BOT_TOKEN specifically — a reply from any
 * other bot is not a reply, it is a message from a stranger. Before 2026-08-02
 * sendTelegram() fell through to a shared env default when this was unset, so
 * someone linking their account could be answered by an unrelated bot in a
 * different conversation entirely. Now the reply is skipped and logged.
 *
 * Still returns 200 to the caller regardless: Telegram retry-storms on anything
 * else, and no number of retries will conjure a missing credential.
 */
async function reply(text: string, chat: string): Promise<void> {
  if (!TOKEN) {
    console.error(
      "[telegram-webhook] SUNBIZ_TELEGRAM_BOT_TOKEN unset — cannot reply as the bot " +
        "the user messaged; dropping reply rather than sending it from another bot",
    );
    return;
  }
  await sendTelegram(text, { token: TOKEN, chatId: chat });
}

/** Constant-time compare; a missing header or a different length is a mismatch. */
function secretMatches(expected: string, presented: string | null): boolean {
  if (presented === null) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  // Telegram's secret header (configured at setWebhook time), checked FIRST,
  // before the body is read. No secret configured is a refusal, never a pass.
  const secret = (process.env.TELEGRAM_WEBHOOK_SECRET ?? "").trim();
  if (!secret) {
    console.error(
      "[telegram-webhook] TELEGRAM_WEBHOOK_SECRET is not set: refusing every update. " +
        "Set it on the Worker and pass the same value as secret_token to setWebhook.",
    );
    return NextResponse.json({ ok: false, error: "webhook_not_configured" });
  }
  if (!secretMatches(secret, req.headers.get("x-telegram-bot-api-secret-token"))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let update: { message?: { chat?: { id?: number }; text?: string } };
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }
  const chatId = update?.message?.chat?.id;
  const text = typeof update?.message?.text === "string" ? update.message.text.trim() : "";
  if (!chatId || !text) return NextResponse.json({ ok: true });
  const chat = String(chatId);

  const m = text.match(/^\/start\s+([A-Za-z0-9]{6,16})\b/);
  if (!m) {
    await reply(
      "To link SunBiz alerts, open Settings in your dashboard, tap “Link Telegram,” then send the code here as /start &lt;CODE&gt;.",
      chat,
    );
    return NextResponse.json({ ok: true });
  }
  const code = m[1].toUpperCase();

  const db = getServiceSupabase();
  const found = await db
    .from("user_profiles")
    .select("auth_user_id, custom_fields")
    .filter("custom_fields->telegram_link->>code", "eq", code)
    .limit(1);
  const row = (found.data || [])[0] as
    | { auth_user_id: string; custom_fields: Record<string, unknown> | null }
    | undefined;
  if (!row) {
    await reply("That code wasn't found or was already used. Generate a fresh one in the dashboard.", chat);
    return NextResponse.json({ ok: true });
  }
  const cf = row.custom_fields || {};
  const link = cf.telegram_link as { expires_at?: string } | undefined;
  if (!link?.expires_at || Date.parse(link.expires_at) < Date.now()) {
    await reply("That code has expired. Generate a fresh one in the dashboard.", chat);
    return NextResponse.json({ ok: true });
  }

  const nextCf: Record<string, unknown> = { ...cf, telegram_chat_id: chat };
  delete nextCf.telegram_link;
  const upd = await db
    .from("user_profiles")
    .update({ custom_fields: nextCf })
    .eq("auth_user_id", row.auth_user_id);
  if (upd.error) {
    await reply("Something went wrong linking your account — try again from the dashboard.", chat);
    return NextResponse.json({ ok: true });
  }
  await reply("✅ Linked! You'll now get SunBiz application alerts for your leads here.", chat);
  return NextResponse.json({ ok: true });
}
