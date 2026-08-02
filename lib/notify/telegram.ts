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
      // Callers run inside `after()` on a function with a hard maxDuration.
      // A hung connection is torn down with the function, so the catch below
      // never runs and NOTHING is recorded — the one failure mode a durable
      // error marker cannot cover, because the process does not survive to
      // write it. Bounded so the failure is always reportable.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      // Telegram puts the actual cause in the body. Returning only the HTTP
      // status made every failure indistinguishable: "chat not found",
      // "bot was blocked by the user" and "can't parse entities" all arrive
      // as 400, and a lead alert that fails without saying why costs a
      // second incident to diagnose. This is what makes the durable marker
      // actionable rather than just present.
      const detail = await res.text().catch(() => "");
      let desc = "";
      try {
        desc = String(JSON.parse(detail)?.description ?? "");
      } catch {
        desc = detail.slice(0, 200);
      }
      return { ok: false, reason: `telegram_http_${res.status}${desc ? `: ${desc}` : ""}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "telegram_error" };
  }
}
