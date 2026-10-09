/**
 * notify/workspace-telegram.ts - the Telegram bot a workspace saved for itself
 * (Connections > Telegram), and the only Telegram a client workspace's alerts
 * may reach.
 *
 * WHY THIS EXISTS (2026-10-02). Every lane in ./telegram.ts is an OASIS
 * deployment credential: "operator" is CC's bot, "sunbiz-ops" the retired
 * SunBiz ops bot. writeAgentAlert pushed every alert on the lane its caller
 * named, whichever workspace the alert was about, so a client's alerts (the
 * SMS reply agent's escalations of the client's own customers' texts above
 * all) reached CC's phone while the client heard nothing. Meanwhile the bot a
 * client saves under Connections > Telegram (service "telegram", fields
 * bot_token and chat_id) was read by no sender at all.
 *
 * ONE SOURCE, NO FALLBACK. This reads that workspace's saved fields with the
 * store's strict reader, which never consults an env value for any tenant,
 * OASIS included, and sends to exactly that chat through sendTelegram's
 * explicit target, which has no second address. No branch here can reach a
 * lane.
 *
 * HONEST FAILURES. A field that is not saved is "not connected". A saved
 * field that will not decrypt, or a store that could not be read, says so
 * instead: "not connected" would send the owner to set up a bot they already
 * set up. The bundle reader (getTenantIntegrationBundle) folds both of those
 * into a missing field, which is why it is not used here.
 */
import "server-only";
import { sendTelegram } from "@/lib/notify/telegram";
import { readTenantCredentialStrict } from "@/lib/tenant-integration-store";

/** The service Connections > Telegram saves the workspace's bot under. */
export const WORKSPACE_TELEGRAM_SERVICE = "telegram";

export type WorkspaceTelegramFailure =
  /** The workspace has not saved a bot token and a chat id. */
  | "workspace_telegram_not_connected"
  /** A saved field will not decrypt. */
  | "workspace_telegram_unreadable"
  /** The saved fields could not be read at all. */
  | "workspace_telegram_lookup_failed"
  /** Telegram refused the message, or could not be reached. */
  | "workspace_telegram_send_failed";

export type WorkspaceTelegramResult =
  | { ok: true }
  | { ok: false; reason: WorkspaceTelegramFailure; detail?: string };

type FieldRead = { ok: true; value: string } | { ok: false; reason: WorkspaceTelegramFailure };

async function readField(tenantId: string, fieldKey: "bot_token" | "chat_id"): Promise<FieldRead> {
  try {
    const read = await readTenantCredentialStrict(tenantId, WORKSPACE_TELEGRAM_SERVICE, fieldKey);
    if (read.ok) {
      const value = read.value.trim();
      return value ? { ok: true, value } : { ok: false, reason: "workspace_telegram_not_connected" };
    }
    if (read.reason === "missing") return { ok: false, reason: "workspace_telegram_not_connected" };
    if (read.reason === "unreadable") return { ok: false, reason: "workspace_telegram_unreadable" };
    return { ok: false, reason: "workspace_telegram_lookup_failed" };
  } catch (err) {
    console.error("[workspace-telegram] saved bot read failed", {
      tenantId,
      fieldKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: "workspace_telegram_lookup_failed" };
  }
}

/**
 * Telegram's refusal in words an owner can act on ("Telegram said: Bad
 * Request: chat not found"). The bot token never leaves this function inside
 * it: Telegram may quote the request, and a network error message may quote
 * the request URL, which carries the token.
 */
function sendFailureDetail(reason: string | undefined, token: string): string {
  const raw = (reason || "").split(token).join("[token]");
  const http = /^telegram_http_(\d+)(?::\s*([\s\S]*))?$/.exec(raw);
  if (http) return `Telegram said: ${(http[2]?.trim() || `HTTP ${http[1]}`).slice(0, 200)}`;
  return "Telegram could not be reached";
}

/**
 * Send `text` (Telegram HTML, already escaped by the caller) to the bot and
 * chat this workspace saved. Never throws, never uses a lane or an env value.
 */
export async function sendWorkspaceTelegram(tenantId: string, text: string): Promise<WorkspaceTelegramResult> {
  const id = (tenantId || "").trim();
  if (!id) return { ok: false, reason: "workspace_telegram_not_connected" };
  const [token, chat] = await Promise.all([readField(id, "bot_token"), readField(id, "chat_id")]);
  if (!token.ok) return token;
  if (!chat.ok) return chat;
  const sent = await sendTelegram(text, { token: token.value, chatId: chat.value });
  if (sent.ok) return { ok: true };
  return { ok: false, reason: "workspace_telegram_send_failed", detail: sendFailureDetail(sent.reason, token.value) };
}

/**
 * The outcome in the words the alert card shows its owner. One wording for
 * every caller (lib/notify/alert-route.ts), so a card and a ticket never
 * describe the same failure two ways.
 */
export function workspaceTelegramOutcome(result: WorkspaceTelegramResult): string {
  if (result.ok) return "Sent to Telegram";
  switch (result.reason) {
    case "workspace_telegram_not_connected":
      return "Not sent: no Telegram bot connected";
    case "workspace_telegram_unreadable":
      return "Not sent: the saved Telegram bot could not be read";
    case "workspace_telegram_lookup_failed":
      return "Not sent: the saved Telegram bot could not be checked";
    default:
      return `Not sent: ${result.detail || "Telegram refused it"}`;
  }
}
