/**
 * notify/alert-route.ts - THE place an alert's Telegram audience is chosen.
 *
 * WHY ONE RESOLVER (2026-10-02). The lane used to be a constant at each call
 * site: the drips executor paged "operator" for a carrier outage while the
 * reconcile cron paged "sunbiz-ops" for the same alert type on the same
 * card, the reply agent paged "operator" for every workspace's customers, and
 * a client workspace's alerts could only ever reach an OASIS chat. The lane is
 * a property of the WORKSPACE, never of the call site, so it is decided here,
 * from the tenant id alone:
 *
 *   - OASIS's own workspaces (isOasisInternalTenant, by id) -> OASIS's
 *     "operator" chat;
 *   - the retired SunBiz workspace -> nobody: its card is kept, nothing pages;
 *   - any other workspace -> the bot it saved under Connections > Telegram
 *     (./workspace-telegram.ts), or nobody outside the app when it saved none.
 *
 * Every alert sender goes through pushWorkspaceAlert. A file other than this
 * one and ./telegram.ts that names a lane fails tests/workspace-alerts.test.ts
 * (a ratchet: the few files still allowed are listed there with the reason).
 *
 * THE OUTCOME IS WORDS. What the push did is returned in the words an alert
 * card shows its owner ("Sent to Telegram", "Not sent: no Telegram bot
 * connected"), one wording for every caller.
 */
import "server-only";
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";
import { sendTelegram } from "@/lib/notify/telegram";
import { sendWorkspaceTelegram, workspaceTelegramOutcome } from "@/lib/notify/workspace-telegram";
import { isRetiredTenant } from "@/lib/tenant/retired";

/** Who a workspace's alerts reach outside the app. */
export type AlertAudience = "oasis_operator" | "workspace_bot" | "card_only";

export function alertAudienceFor(tenantId: string | null | undefined): AlertAudience {
  if (isRetiredTenant(tenantId)) return "card_only";
  if (isOasisInternalTenant(tenantId)) return "oasis_operator";
  return "workspace_bot";
}

export type AlertPush = {
  /** A person was reached. */
  delivered: boolean;
  /** What happened, in the words the card shows. */
  outcome: string;
};

type LaneResult = { ok: boolean; reason?: string; degraded?: boolean };

/**
 * OASIS's own chat's answer, in the card's words. A delivery that only
 * reached a lane's backup chat is not "Sent": the chat its people read is
 * broken, and the card must say so. Exported for tests.
 */
export function oasisLaneOutcome(sent: LaneResult): string {
  if (sent.ok && !sent.degraded) return "Sent to Telegram";
  if (sent.ok) return "Sent to the backup Telegram chat: the main chat refused it";
  const reason = sent.reason || "";
  if (reason.startsWith("telegram_lane_not_configured")) return "Not sent: the Telegram alert chat is not set up";
  const http = /^telegram_http_(\d+)(?::\s*([\s\S]*))?$/.exec(reason);
  if (http) return `Not sent: Telegram said: ${(http[2]?.trim() || `HTTP ${http[1]}`).slice(0, 200)}`;
  return "Not sent: Telegram could not be reached";
}

/**
 * Push one alert (Telegram HTML, already escaped) to this workspace's own
 * audience. Never throws, never reaches another workspace's chat.
 */
export async function pushWorkspaceAlert(tenantId: string, text: string): Promise<AlertPush> {
  const audience = alertAudienceFor(tenantId);
  if (audience === "card_only") return { delivered: false, outcome: "Not sent: this workspace is retired" };
  if (audience === "oasis_operator") {
    const sent: LaneResult = await sendTelegram(text, { lane: "operator" }).catch((err: unknown) => ({
      ok: false,
      reason: err instanceof Error ? err.message : "telegram_error",
    }));
    return { delivered: sent.ok, outcome: oasisLaneOutcome(sent) };
  }
  const result = await sendWorkspaceTelegram(tenantId, text);
  return { delivered: result.ok, outcome: workspaceTelegramOutcome(result) };
}
