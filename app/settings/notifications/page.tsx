/**
 * /settings/notifications — Settings › Notifications. Everyone.
 *
 * Two different Telegram bots, each named for what it is, each in the words
 * every other screen uses for it (2026-10-08, CC: Notifications said Telegram
 * was "not set up" while Connections said "Connected"):
 *
 *   - The WORKSPACE's team bot: the Connections card's own status
 *     (lib/os/connectors.ts resolveConnectorStatus over the hub's facts), so
 *     this page, Connections and Chat apps can never answer differently. Owners
 *     and admins see it, the same rule as Chat apps and Connections.
 *   - YOUR OWN bot: lib/os/connectors.ts personalTelegramStatus over
 *     lib/integrations/telegram-personal.ts readPersonalTelegramFact, the same
 *     words its setup card shows. Nothing sends to a personal bot yet, and the
 *     page says so instead of promising alerts.
 *
 * A failed read is "Status unavailable", never "not set up": both readers fail
 * loud so those two can't be confused.
 *
 * Choosing which events notify you has no store yet, and the page says so,
 * as a state with no release promise, rather than rendering toggles that
 * save nowhere.
 */

import Link from "next/link";
import { requireSettingsSection } from "@/components/settings/settings-viewer";
import { PageFrame } from "@/components/os/PageFrame";
import { ConnectorIcon } from "@/components/os/connections/ConnectorIcon";
import { StatusLine } from "@/components/os/connections/StatusLine";
import { loadConnectorFacts } from "@/components/os/connections/connector-facts";
import {
  connectorBySlug,
  connectorHref,
  personalTelegramStatus,
  resolveConnectorStatus,
  type ConnectorStatus,
} from "@/lib/os/connectors";
import { readPersonalTelegramFact } from "@/lib/integrations/telegram-personal";

export const dynamic = "force-dynamic";

async function yourTelegram(tenantId: string, userId: string): Promise<ConnectorStatus> {
  try {
    return personalTelegramStatus(await readPersonalTelegramFact(tenantId, userId));
  } catch (error) {
    console.error("[settings.notifications.telegram]", error);
    return personalTelegramStatus(null);
  }
}

export default async function SettingsNotificationsPage() {
  const viewer = await requireSettingsSection("notifications");
  const telegram = connectorBySlug("telegram");
  const nowMs = Date.now();
  const [workspaceBot, yours] = await Promise.all([
    viewer.access.canManage && telegram
      ? loadConnectorFacts({ tenantId: viewer.tenantId, userId: viewer.userId, personal: false }).then((facts) =>
          resolveConnectorStatus(telegram, facts, nowMs),
        )
      : Promise.resolve(null),
    yourTelegram(viewer.tenantId, viewer.userId),
  ]);

  return (
    <PageFrame title="Notifications" subtitle="The workspace's Telegram bot, and your own.">
      <div className="space-y-4">
        <section className="rounded-xl border border-hairline bg-bg-panel">
          <div className="flex flex-wrap items-start gap-3 px-4 py-4">
            {telegram && <ConnectorIcon def={telegram} size="lg" />}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h2 className="text-sm font-semibold text-fg">Workspace Telegram bot</h2>
                {workspaceBot && <StatusLine status={workspaceBot} />}
              </div>
              <p className="mt-1 text-[13px] leading-5 text-fg-muted">
                {workspaceBot
                  ? `The team bot set up in Connections, with the same status it shows there. ${workspaceBot.detail ?? ""}`
                  : // Members are not shown the bot's status, so this says who sets it up, never that one exists.
                    "An owner or admin sets up the team bot in Connections."}
              </p>
            </div>
            {workspaceBot && (
              <Link href={connectorHref("telegram")} prefetch={false} className="btn-secondary">
                Open in Connections
              </Link>
            )}
          </div>
        </section>

        <section className="rounded-xl border border-hairline bg-bg-panel">
          <div className="flex flex-wrap items-start gap-3 px-4 py-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h2 className="text-sm font-semibold text-fg">Your own Telegram bot</h2>
                <StatusLine status={yours} />
              </div>
              <p className="mt-1 text-[13px] leading-5 text-fg-muted">
                A bot only your login uses, separate from the workspace bot. {yours.detail}
              </p>
            </div>
            <Link href="/settings/chat-apps" prefetch={false} className="btn-secondary">
              {yours.kind === "not_connected" ? "Set up" : "Manage"}
            </Link>
          </div>
        </section>

        <section className="rounded-xl border border-hairline bg-bg-panel px-4 py-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="text-sm font-semibold text-fg">Choose what notifies you</h2>
            <StatusLine status={{ kind: "coming_soon", label: "Not built yet" }} />
          </div>
          <p className="mt-1 text-[13px] leading-5 text-fg-muted">
            Choosing what notifies you is not built yet. The alerts your workspace already sends keep going where
            they go today.
          </p>
        </section>
      </div>
    </PageFrame>
  );
}
