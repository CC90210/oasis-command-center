/**
 * lib/integrations/telegram-personal.ts — self-service Telegram bot linking so
 * each employee can create + connect THEIR OWN bot (via BotFather) with no
 * developer help. Distinct from TelegramLinkCard (which links a chat to the
 * shared SunBiz alert bot).
 *
 * Flow: user makes a bot in BotFather → pastes the token → we validate via
 * getMe + store it encrypted (user_integration_credentials, service
 * 'telegram_bot') → user messages their bot → we read getUpdates to capture
 * their chat_id → linked. Token is never returned to the client.
 */

import "server-only";
import {
  getUserIntegrationBundleForStatus,
  setUserIntegrationBundle,
  setUserIntegrationValue,
  clearUserIntegration,
} from "@/lib/user-integration-store";

const TG = "https://api.telegram.org";
const SERVICE = "telegram_bot";
// BotFather tokens look like 123456789:AA...(35 chars). Validate shape before
// hitting Telegram so a fat-finger doesn't leave a junk value around.
const TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

export async function validateAndStoreBot(
  tenantId: string,
  userId: string,
  botTokenRaw: string,
): Promise<{ ok: boolean; username?: string; error?: string }> {
  const token = String(botTokenRaw || "").trim();
  if (!TOKEN_RE.test(token)) return { ok: false, error: "invalid_token_format" };
  try {
    const r = await fetch(`${TG}/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: { username?: string } };
    if (!j.ok || !j.result?.username) return { ok: false, error: "telegram_rejected_token" };
    const stored = await setUserIntegrationBundle(tenantId, userId, SERVICE, {
      bot_token: token,
      bot_username: j.result.username,
    });
    if (!stored.ok || stored.written.length !== 2) {
      console.error("[personal-telegram] unable to store validated bot", {
        tenantId,
        userId,
        errors: stored.errors,
      });
      return { ok: false, error: "telegram_store_failed" };
    }
    return { ok: true, username: j.result.username };
  } catch {
    return { ok: false, error: "telegram_unreachable" };
  }
}

export async function captureChatId(
  tenantId: string,
  userId: string,
): Promise<{ ok: boolean; chat_id?: string; chat_name?: string; error?: string }> {
  let b: Record<string, string>;
  try {
    b = await getUserIntegrationBundleForStatus(tenantId, userId, SERVICE);
  } catch (error) {
    console.error("[personal-telegram] unable to read bot before linking", {
      tenantId,
      userId,
      error,
    });
    return { ok: false, error: "telegram_store_failed" };
  }
  if (!b.bot_token) return { ok: false, error: "not_connected" };
  try {
    const r = await fetch(`${TG}/bot${b.bot_token}/getUpdates?limit=20`, { signal: AbortSignal.timeout(10_000) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: unknown[] };
    if (!j.ok) return { ok: false, error: "getupdates_failed" };
    const updates = (j.result || []) as Array<{ message?: { chat?: Chat }; edited_message?: { chat?: Chat } }>;
    let chat: Chat | null = null;
    for (let i = updates.length - 1; i >= 0; i--) {
      const c = updates[i].message?.chat || updates[i].edited_message?.chat;
      if (c?.id != null) { chat = c; break; }
    }
    if (!chat) return { ok: false, error: "no_message_yet" };
    const stored = await setUserIntegrationValue(tenantId, userId, SERVICE, "chat_id", String(chat.id));
    if (!stored.ok) {
      console.error("[personal-telegram] unable to store linked chat", {
        tenantId,
        userId,
        error: stored.error,
      });
      return { ok: false, error: "telegram_store_failed" };
    }
    const name =
      [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
      chat.username || chat.title || String(chat.id);
    return { ok: true, chat_id: String(chat.id), chat_name: name };
  } catch {
    return { ok: false, error: "telegram_unreachable" };
  }
}

type Chat = { id: number; first_name?: string; last_name?: string; username?: string; title?: string };

export async function getTelegramStatus(tenantId: string, userId: string) {
  // Settings must distinguish an empty credential bundle (not connected) from
  // a storage/query/decryption failure (status unavailable). The strict read
  // deliberately throws so the API can return 503 instead of a false negative.
  const b = await getUserIntegrationBundleForStatus(tenantId, userId, SERVICE);
  return {
    connected: !!b.bot_token && !!b.bot_username,
    username: b.bot_username || null,
    linked: !!b.bot_token && !!b.bot_username && !!b.chat_id,
    chat_id: b.chat_id || null, // the user's own chat id — safe to surface to them
  };
}

export async function disconnectTelegram(tenantId: string, userId: string) {
  return clearUserIntegration(tenantId, userId, SERVICE);
}
