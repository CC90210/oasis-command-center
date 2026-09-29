/**
 * /settings/notifications — Settings › Notifications. Everyone.
 *
 * Says where YOUR alerts go today, from the one per-person channel that exists:
 * your own Telegram alert bot (lib/integrations/telegram-personal.ts, the same
 * strict read /api/integrations/personal/telegram serves the card with). A
 * failed read is "Status unavailable", never "not set up" — the reader throws
 * on purpose so those two can't be confused.
 *
 * Choosing which events notify you has no store yet; that arrives with the
 * Feed's approvals (Phase 2), and the page says so rather than rendering
 * toggles that save nowhere.
 */

import Link from "next/link";
import { requireSettingsSection } from "@/components/settings/settings-viewer";
import { PageFrame } from "@/components/os/PageFrame";
import { ConnectorIcon } from "@/components/os/connections/ConnectorIcon";
import { StatusLine } from "@/components/os/connections/StatusLine";
import { connectorBySlug, type ConnectorStatus } from "@/lib/os/connectors";
import { getTelegramStatus } from "@/lib/integrations/telegram-personal";

export const dynamic = "force-dynamic";

async function personalTelegramStatus(tenantId: string, userId: string): Promise<ConnectorStatus> {
  try {
    const s = await getTelegramStatus(tenantId, userId);
    if (s.linked) {
      // Verified when it was set up (the bot token passed getMe and the chat id
      // was read from the bot's own updates), not re-checked on every visit.
      return {
        kind: "configured",
        label: s.username ? `Linked · @${s.username}` : "Linked",
      };
    }
    if (s.connected) {
      return { kind: "attention", label: "Bot saved · chat not linked yet" };
    }
    return { kind: "not_connected", label: "Not set up" };
  } catch (error) {
    console.error("[settings.notifications.telegram]", error);
    return { kind: "unknown", label: "Status unavailable" };
  }
}

export default async function SettingsNotificationsPage() {
  const viewer = await requireSettingsSection("notifications");
  const telegram = connectorBySlug("telegram");
  const status = await personalTelegramStatus(viewer.tenantId, viewer.userId);

  return (
    <PageFrame title="Notifications" subtitle="Where your own alerts reach you.">
      <div className="space-y-4">
        <section className="rounded-xl border border-hairline bg-bg-panel">
          <div className="flex flex-wrap items-start gap-3 px-4 py-4">
            {telegram && <ConnectorIcon def={telegram} size="lg" />}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h2 className="text-sm font-semibold text-fg">Your Telegram alert bot</h2>
                <StatusLine status={status} />
              </div>
              <p className="mt-1 text-[13px] leading-5 text-fg-muted">
                A bot that belongs only to your login and sends your own alerts to your phone. A teammate&apos;s bot
                never receives yours.
              </p>
            </div>
            <Link href="/settings/chat-apps" prefetch={false} className="btn-secondary">
              {status.kind === "configured" ? "Manage" : "Set up"}
            </Link>
          </div>
        </section>

        <section className="rounded-xl border border-hairline bg-bg-panel px-4 py-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="text-sm font-semibold text-fg">Choose what notifies you</h2>
            <StatusLine status={{ kind: "coming_soon", label: "Coming in Phase 2" }} />
          </div>
          <p className="mt-1 text-[13px] leading-5 text-fg-muted">
            Picking which events reach you, and where, arrives with approvals in the Feed. Until then, the alerts
            your workspace already sends keep going where they go today.
          </p>
        </section>
      </div>
    </PageFrame>
  );
}
