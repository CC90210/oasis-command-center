/**
 * /settings/chat-apps — Settings › Chat apps: where the team talks to its AI
 * teammates outside the web app (plan pillar 10, "Chat-app bridges").
 *
 * Honest about what exists today:
 *   - Slack: not built. "Coming in Phase 2", with what it will do.
 *   - Telegram: each person's own alert bot works now (TelegramConnectCard,
 *     rendered by SettingsContent's chat-apps section), and owners see the
 *     shared team-alerts bot's measured status. Two-way AI teammates in
 *     Telegram chats are Phase 2 and say so.
 *   - Discord, Microsoft Teams, WhatsApp: planned, nothing more.
 *
 * OASIS's own Telegram bridges on CC's machine are not this and never appear
 * here; they are CC's personal channel (plan decision 3).
 */

import Link from "next/link";
import { SettingsContent } from "@/components/settings/SettingsContent";
import { ChatAppCard } from "@/components/settings/ChatAppCard";
import { requireSettingsSection } from "@/components/settings/settings-viewer";
import { PageFrame } from "@/components/os/PageFrame";
import { ConnectorIcon } from "@/components/os/connections/ConnectorIcon";
import { StatusLine } from "@/components/os/connections/StatusLine";
import { loadConnectorFacts } from "@/components/os/connections/connector-facts";
import {
  connectorBySlug,
  resolveConnectorStatus,
  connectorHref,
  type ConnectorDef,
  type ConnectorStatus,
} from "@/lib/os/connectors";

export const dynamic = "force-dynamic";

function plannedStatus(def: ConnectorDef): ConnectorStatus {
  return {
    kind: "coming_soon",
    label: def.plannedFor === "Phase 2" ? "Coming in Phase 2" : "Planned",
  };
}

export default async function SettingsChatAppsPage() {
  const viewer = await requireSettingsSection("chat-apps");
  const slack = connectorBySlug("slack");
  const telegram = connectorBySlug("telegram");
  const later = ["discord", "microsoft-teams", "whatsapp"]
    .map(connectorBySlug)
    .filter((d): d is ConnectorDef => d !== null);

  // The shared team-alerts bot is workspace state: owners and admins only,
  // from the same facts and rule as the Connections hub.
  let telegramTeamStatus: ConnectorStatus | null = null;
  if (viewer.access.canManage && telegram) {
    const facts = await loadConnectorFacts({ tenantId: viewer.tenantId, userId: viewer.userId });
    telegramTeamStatus = resolveConnectorStatus(telegram, facts, Date.now());
  }

  return (
    <PageFrame
      title="Chat apps"
      subtitle="Add your AI teammates to the chat your team already uses, next to the people they work with. The same agents, approvals and rules as the web app."
    >
      <div className="space-y-4">
        {slack && (
          <ChatAppCard def={slack} status={plannedStatus(slack)}>
            <p className="text-[13px] leading-5 text-fg-muted">
              One OASIS app installs in your Slack workspace. Pick a channel for each department, such as
              #sales or #marketing, and that department&apos;s agent answers there under its own name. Your team
              can also message an agent directly. Channels shared with other companies never receive team-only
              information.
            </p>
            <p className="text-[13px] leading-5 text-fg-dim">Not available to install yet.</p>
          </ChatAppCard>
        )}

        {telegram && (
          <ChatAppCard def={telegram} status={telegramTeamStatus}>
            {telegramTeamStatus && (
              <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                <div className="min-w-0">
                  <div className="font-medium text-fg">Team alerts bot</div>
                  <div className="text-fg-muted">One bot and one chat that receive the workspace&apos;s shared alerts.</div>
                </div>
                <Link href={connectorHref("telegram")} prefetch={false} className="text-[13px] text-accent hover:underline">
                  Set up in Connections
                </Link>
              </div>
            )}
            <div className="text-[13px]">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium text-fg">AI teammates in Telegram</span>
                <StatusLine status={{ kind: "coming_soon", label: "Coming in Phase 2" }} />
              </div>
              <p className="mt-0.5 leading-5 text-fg-muted">
                Message the OASIS bot to reach your Chief of Staff, or add it to a group chat and link the group to a
                department. Approvals will arrive as buttons.
              </p>
            </div>
          </ChatAppCard>
        )}

        {/* Each person's own alert bot (and SunBiz's link-code card on its own
            workspace) — SettingsContent's chat-apps cards, unchanged. */}
        <SettingsContent section="chat-apps" viewerAccess={viewer.viewerAccess} />

        {later.length > 0 && (
          <section className="rounded-xl border border-hairline bg-bg-panel px-4 py-4">
            <h2 className="text-sm font-semibold text-fg">Later</h2>
            <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">
              Planned after Slack and Telegram. Nothing to set up yet.
            </p>
            <ul className="mt-3 grid gap-2 sm:grid-cols-3">
              {later.map((d) => (
                <li key={d.slug} className="flex items-center gap-2.5 rounded-lg border border-hairline bg-bg-raised/40 px-3 py-2">
                  <ConnectorIcon def={d} size="sm" />
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-fg">{d.name}</div>
                    <StatusLine status={plannedStatus(d)} />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </PageFrame>
  );
}
