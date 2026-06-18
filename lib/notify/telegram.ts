/**
 * notify/telegram.ts — minimal server-side Telegram sender.
 *
 * Used by the OASIS funnel to ping CC the moment a lead submits (the behavior
 * ported from the retired cc-funnel app). Generic + tenant-agnostic: the caller
 * supplies the message; tokens come from env. Soft-fail — returns
 * {ok:false, reason} instead of throwing, so a notification never breaks the
 * request that triggered it.
 */
import "server-only";

// Pure formatting helper lives in a server-only-free module so message builders
// stay unit-testable. Re-exported here for callers that already import this.
export { escapeTelegramHtml } from "./telegram-format";

export async function sendTelegram(
  text: string,
  opts?: { token?: string; chatId?: string },
): Promise<{ ok: boolean; reason?: string }> {
  const token =
    opts?.token || process.env.OASIS_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chatId =
    opts?.chatId || process.env.OASIS_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, reason: "telegram_not_configured" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4096), // Telegram hard caps messages at 4096 chars
        parse_mode: "HTML",
      }),
    });
    if (!res.ok) return { ok: false, reason: `telegram_http_${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "telegram_error" };
  }
}
