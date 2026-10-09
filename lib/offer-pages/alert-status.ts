/**
 * lib/offer-pages/alert-status.ts - the builder's line about who hears of a
 * new lead on an offer, shown above the tabs before Publish so nobody
 * publishes a silent drop box (design 2.2).
 *
 * ONE ANSWER PER INTEGRATION (#553; CC, 2026-10-08: Notifications said
 * Telegram was not set up while Connections said it was). A client
 * workspace's alert goes to the team bot saved under Connections > Telegram
 * (lib/notify/workspace-telegram.ts), so this line reads THAT card's status
 * through the one resolver (loadWorkspaceConnectorStatus over
 * lib/os/connectors.ts) and quotes its words. It never decides from the saved
 * fields alone: a bot whose last Test failed is not "alerting your bot".
 *
 * OASIS's own workspaces alert OASIS's operator chat, not a workspace card
 * (lib/notify/alert-route.ts), so their line names that route. A retired
 * workspace pages no one.
 */
import "server-only";
import { alertAudienceFor } from "@/lib/notify/alert-route";
import { loadWorkspaceConnectorStatus } from "@/components/os/connections/connector-facts";
import type { ConnectorStatus } from "@/lib/os/connectors";

export type OfferAlertStatus = { connected: boolean; line: string };

const UNKNOWN: OfferAlertStatus = {
  connected: false,
  line: "Couldn't check your alert channel. Leads still appear in Offers and the pipeline.",
};

/**
 * A client workspace's line, from its Telegram card's own status (null: the
 * read failed, which is never "not connected").
 */
export function clientAlertLine(card: ConnectorStatus | null): OfferAlertStatus {
  if (!card) return UNKNOWN;
  switch (card.kind) {
    case "connected":
      return { connected: true, line: "New leads alert your Telegram bot." };
    case "not_connected":
      return {
        connected: false,
        line: "No alert channel connected - leads will only appear in Offers and the pipeline. Connect Telegram under Connections to be told.",
      };
    case "configured":
      return {
        connected: false,
        line: `New leads go to your Telegram bot. Connections shows it as "${card.label}": run Test there to be sure you are told.`,
      };
    case "attention":
      return {
        connected: false,
        line: `New leads go to your Telegram bot, but Connections shows it as "${card.label}": fix it there, or you won't be told. Leads still appear in Offers and the pipeline.`,
      };
    default:
      return UNKNOWN;
  }
}

export async function offerAlertStatus(
  tenantId: string,
  telegramCard: (tenantId: string) => Promise<ConnectorStatus | null> = (id) => loadWorkspaceConnectorStatus(id, "telegram"),
): Promise<OfferAlertStatus> {
  const audience = alertAudienceFor(tenantId);
  if (audience === "oasis_operator") return { connected: true, line: "New leads alert you on Telegram." };
  if (audience === "card_only") return { connected: false, line: "This workspace is closed, so new leads alert no one." };
  try {
    return clientAlertLine(await telegramCard(tenantId));
  } catch (err) {
    console.error("[offer-pages.alert-status] the Telegram card could not be read", {
      tenant_id: tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return UNKNOWN;
  }
}
