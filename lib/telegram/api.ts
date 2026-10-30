/** The one outbound call for the OASIS Telegram webhook lane. */
import { TELEGRAM_REPLY_MAX, type OasisTelegramConfig, type OasisTelegramJob } from "./protocol";

export type TelegramSendResult =
  | { outcome: "sent"; messageId: number }
  | { outcome: "rejected"; reason: string }
  | { outcome: "ambiguous"; reason: string };

export function telegramReplyText(text: string): string {
  let result = text.trim().slice(0, TELEGRAM_REPLY_MAX);
  const last = result.charCodeAt(result.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) result = result.slice(0, -1);
  return result;
}

export async function sendOasisTelegramReply(input: {
  config: OasisTelegramConfig;
  job: OasisTelegramJob;
  text: string;
  fetchImpl?: typeof fetch;
}): Promise<TelegramSendResult> {
  if (input.job.chatId !== input.config.chatId) return { outcome: "rejected", reason: "chat_id_mismatch" };
  const text = telegramReplyText(input.text);
  if (!text) return { outcome: "rejected", reason: "reply_empty" };
  try {
    const response = await (input.fetchImpl ?? fetch)(
      `https://api.telegram.org/bot${input.config.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: input.config.chatId,
          text,
          reply_parameters: { message_id: input.job.messageId, allow_sending_without_reply: true },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { outcome: "ambiguous", reason: `telegram_http_${response.status}_invalid_json` };
    }
    const telegram = body && typeof body === "object" && !Array.isArray(body)
      ? (body as { ok?: unknown; description?: unknown; result?: unknown })
      : null;
    if (telegram?.ok !== true) {
      const description = typeof telegram?.description === "string" ? telegram.description : `http_${response.status}`;
      return { outcome: "rejected", reason: `telegram_rejected:${description}`.slice(0, 240) };
    }
    const result = telegram.result && typeof telegram.result === "object" && !Array.isArray(telegram.result)
      ? (telegram.result as { message_id?: unknown })
      : null;
    const messageId = Number(result?.message_id);
    if (!response.ok || !Number.isSafeInteger(messageId) || messageId < 1) {
      return { outcome: "ambiguous", reason: `telegram_http_${response.status}_missing_receipt` };
    }
    return { outcome: "sent", messageId };
  } catch (error) {
    // The request may have reached Telegram before the connection failed.
    return {
      outcome: "ambiguous",
      reason: `telegram_network_unknown:${error instanceof Error ? error.name : "unknown"}`,
    };
  }
}
