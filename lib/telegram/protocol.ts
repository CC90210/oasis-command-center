/**
 * The narrow wire contract for CC's OASIS Telegram bot.
 *
 * This is deliberately not the SunBiz link-code webhook. One configured bot,
 * one configured private CC chat and text messages only are accepted here.
 */
export const OASIS_TELEGRAM_QUEUE_NAME = "oasis-telegram-agent-jobs";
export const OASIS_TELEGRAM_QUEUE_BINDING = "TELEGRAM_AGENT_JOBS";
export const TELEGRAM_WEBHOOK_SECRET_HEADER = "x-telegram-bot-api-secret-token";
export const TELEGRAM_UPDATE_MAX_BYTES = 32 * 1024;
export const TELEGRAM_JOB_MAX_BYTES = 16 * 1024;
export const TELEGRAM_TEXT_MAX = 4096;
export const TELEGRAM_REPLY_MAX = 4000;
export const NO_PAIRED_COMPUTER_REPLY = "No paired computer is online right now.";

export const OASIS_TELEGRAM_TENANT_ID = "ef8d389e-3f15-43f2-ae00-3660f69a1452";

export type OasisTelegramEnv = {
  TELEGRAM_WEBHOOK_ENABLED?: string;
  OASIS_TELEGRAM_WEBHOOK_SECRET?: string;
  OASIS_TELEGRAM_JOB_SIGNING_SECRET?: string;
  OASIS_TELEGRAM_BOT_TOKEN?: string;
  OASIS_TELEGRAM_CHAT_ID?: string;
  PUBLIC_APP_URL?: string;
};

export type OasisTelegramConfig = {
  webhookSecret: string;
  jobSigningSecret: string;
  botToken: string;
  botId: number;
  chatId: string;
};

export type OasisTelegramJob = {
  v: 1;
  kind: "oasis_telegram_message";
  bot: "oasis";
  tenantId: typeof OASIS_TELEGRAM_TENANT_ID;
  botId: number;
  updateId: number;
  messageId: number;
  chatId: string;
  senderId: string;
  text: string;
};

export function telegramWebhookEnabled(env: OasisTelegramEnv): boolean {
  return String(env.TELEGRAM_WEBHOOK_ENABLED || "").trim().toLowerCase() === "on";
}

/** No generic TELEGRAM_* fallback: this lane must be the exact OASIS bot. */
export function oasisTelegramConfig(env: OasisTelegramEnv): OasisTelegramConfig | null {
  const webhookSecret = String(env.OASIS_TELEGRAM_WEBHOOK_SECRET || "").trim();
  const jobSigningSecret = String(env.OASIS_TELEGRAM_JOB_SIGNING_SECRET || "").trim();
  const botToken = String(env.OASIS_TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(env.OASIS_TELEGRAM_CHAT_ID || "").trim();
  const botTokenMatch = /^([1-9]\d{4,14}):[A-Za-z0-9_-]{20,}$/.exec(botToken);
  const botId = botTokenMatch ? Number(botTokenMatch[1]) : NaN;
  if (
    !webhookSecret ||
    !jobSigningSecret ||
    !Number.isSafeInteger(botId) ||
    botId < 1 ||
    !/^[1-9]\d{3,18}$/.test(chatId)
  ) {
    return null;
  }
  return { webhookSecret, jobSigningSecret, botToken, botId, chatId };
}

/** Compare fixed-size SHA-256 digests, not the caller-controlled strings. */
export async function constantTimeSecretEqual(expected: string, received: string | null): Promise<boolean> {
  if (!expected || received === null || received.length > 256) return false;
  const bytes = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", bytes.encode(expected)),
    crypto.subtle.digest("SHA-256", bytes.encode(received)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function telegramInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const UNSUPPORTED_MESSAGE_FIELDS = [
  "animation",
  "audio",
  "contact",
  "document",
  "location",
  "photo",
  "poll",
  "sticker",
  "venue",
  "video",
  "video_note",
  "voice",
] as const;

export type TelegramUpdateParse =
  | { ok: true; job: OasisTelegramJob }
  | { ok: false; reason: string };

/**
 * Accept only an ordinary text message from CC's configured private chat.
 * Unsupported Telegram update types are acknowledged and ignored upstream.
 */
export function parseOasisTelegramUpdate(value: unknown, allowedChatId: string, botId: number): TelegramUpdateParse {
  if (!Number.isSafeInteger(botId) || botId < 1) return { ok: false, reason: "invalid_bot_id" };
  const update = record(value);
  if (!update) return { ok: false, reason: "invalid_update" };
  const updateId = telegramInteger(update.update_id);
  if (updateId === null) return { ok: false, reason: "invalid_update_id" };
  if (
    "callback_query" in update ||
    "channel_post" in update ||
    "edited_channel_post" in update ||
    "edited_message" in update ||
    "inline_query" in update
  ) {
    return { ok: false, reason: "unsupported_update" };
  }
  const message = record(update.message);
  if (!message) return { ok: false, reason: "unsupported_update" };
  if (UNSUPPORTED_MESSAGE_FIELDS.some((key) => key in message)) {
    return { ok: false, reason: "unsupported_message" };
  }
  const messageId = telegramInteger(message.message_id);
  const chat = record(message.chat);
  const from = record(message.from);
  const chatId = telegramInteger(chat?.id);
  const senderId = telegramInteger(from?.id);
  if (
    messageId === null ||
    !chat ||
    chat.type !== "private" ||
    chatId === null ||
    senderId === null ||
    from?.is_bot === true ||
    String(chatId) !== allowedChatId ||
    senderId !== chatId
  ) {
    return { ok: false, reason: "not_allowed" };
  }
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!text || text.length > TELEGRAM_TEXT_MAX) return { ok: false, reason: "unsupported_message" };
  return {
    ok: true,
    job: {
      v: 1,
      kind: "oasis_telegram_message",
      bot: "oasis",
      tenantId: OASIS_TELEGRAM_TENANT_ID,
      botId,
      updateId,
      messageId,
      chatId: String(chatId),
      senderId: String(senderId),
      text,
    },
  };
}

export function isOasisTelegramJob(value: unknown): value is OasisTelegramJob {
  const job = record(value);
  return Boolean(
    job &&
      job.v === 1 &&
      job.kind === "oasis_telegram_message" &&
      job.bot === "oasis" &&
      job.tenantId === OASIS_TELEGRAM_TENANT_ID &&
      telegramInteger(job.botId) !== null &&
      Number(job.botId) > 0 &&
      telegramInteger(job.updateId) !== null &&
      telegramInteger(job.messageId) !== null &&
      typeof job.chatId === "string" &&
      /^[1-9]\d{3,18}$/.test(job.chatId) &&
      job.senderId === job.chatId &&
      typeof job.text === "string" &&
      job.text.trim().length > 0 &&
      job.text.length <= TELEGRAM_TEXT_MAX,
  );
}

export function telegramReceiptId(job: Pick<OasisTelegramJob, "botId" | "updateId">): string {
  return `telegram-oasis-${job.botId}-${job.updateId}`;
}

export function telegramIdempotencyKey(job: Pick<OasisTelegramJob, "tenantId" | "botId" | "updateId">): string {
  return `telegram:oasis:${job.tenantId}:${job.botId}:${job.updateId}`;
}

export function sameTelegramJob(a: OasisTelegramJob, b: OasisTelegramJob): boolean {
  return (
    a.v === b.v &&
    a.kind === b.kind &&
    a.bot === b.bot &&
    a.tenantId === b.tenantId &&
    a.botId === b.botId &&
    a.updateId === b.updateId &&
    a.messageId === b.messageId &&
    a.chatId === b.chatId &&
    a.senderId === b.senderId &&
    a.text === b.text
  );
}
