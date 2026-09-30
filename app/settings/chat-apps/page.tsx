/**
 * /settings/chat-apps — Settings › Chat apps: where the team talks to its AI
 * teammates outside the web app (plan pillar 10, "Chat-app bridges").
 *
 * Honest about what exists today:
 *   - Slack: built (lib/slack/*). It works on a deployment that holds OASIS's
 *     Slack app (the Worker secrets); where it does not, the card says "Slack
 *     app not configured yet" and offers no button. Owners and admins install
 *     it, see the connected workspace, and map each channel to a department
 *     and, optionally, a client. @mentions get a department's draft that waits
 *     for approval; mapped channels show on the client's Conversations tab.
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
import { SlackChannelMap } from "@/components/settings/SlackChannelMap";
import { SlackDisconnect } from "@/components/settings/SlackDisconnect";
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
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { loadSlackSettings, type SlackSettings } from "@/lib/slack/settings";
import { slackInstallBanner } from "@/lib/slack/copy";
import { SLACK_RETENTION_DAYS } from "@/lib/slack/retention";

export const dynamic = "force-dynamic";

function plannedStatus(def: ConnectorDef): ConnectorStatus {
  return {
    kind: "coming_soon",
    label: def.plannedFor === "Phase 2" ? "Coming in Phase 2" : "Planned",
  };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SettingsChatAppsPage({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await requireSettingsSection("chat-apps");
  const params = await searchParams;
  const slack = connectorBySlug("slack");
  const telegram = connectorBySlug("telegram");
  const later = ["discord", "microsoft-teams", "whatsapp"]
    .map(connectorBySlug)
    .filter((d): d is ConnectorDef => d !== null);
  const nowMs = Date.now();

  // Every status comes from the Connections hub's own facts and resolver, never
  // built here. The shared team-alerts bot is owners and admins only.
  const facts = await loadConnectorFacts({ tenantId: viewer.tenantId, userId: viewer.userId });
  const slackCardStatus = slack ? resolveConnectorStatus(slack, facts, nowMs) : null;
  let telegramTeamStatus: ConnectorStatus | null = null;
  if (viewer.access.canManage && telegram) {
    telegramTeamStatus = resolveConnectorStatus(telegram, facts, nowMs);
  }

  // Slack: the workspace's connection and channel map. A read that fails says
  // "Status unavailable", never "Not connected".
  let slackSettings: SlackSettings | null = null;
  if (tursoConfigured()) {
    try {
      slackSettings = await loadSlackSettings(getTursoClient(), viewer.tenantId, { nowMs });
    } catch (err) {
      console.error("[settings.chat-apps.slack]", { tenantId: viewer.tenantId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const banner = slackInstallBanner(params.slack, params.reason);
  const conn = slackSettings?.connection ?? null;
  const departments = OS_DEPARTMENTS.map((d) => ({ key: d.key, label: d.label }));

  return (
    <PageFrame
      title="Chat apps"
      subtitle="Add your AI teammates to the chat your team already uses, next to the people they work with. The same agents, approvals and rules as the web app."
    >
      <div className="space-y-4">
        {slack && (
          <ChatAppCard def={slack} status={slackCardStatus}>
            {banner && (
              <p role="status" className={`text-[13px] leading-5 ${banner.ok ? "text-fg" : "text-status-warm"}`}>
                {banner.text}
              </p>
            )}

            {!slackSettings ? (
              <p className="text-[13px] leading-5 text-fg-muted">
                OASIS could not read this workspace&apos;s Slack connection just now. Refresh to try again.
              </p>
            ) : !slackSettings.appConfigured ? (
              <div className="space-y-1.5">
                <p className="text-[13px] leading-5 text-fg-muted">
                  OASIS&apos;s Slack app is not set up on this deployment yet, so Slack cannot be installed here. Nothing is
                  broken on your side.
                </p>
                {viewer.access.isOperator && slackSettings.missingSecrets.length > 0 && (
                  <p className="text-[12px] leading-4 text-fg-dim">
                    Missing Worker secrets: {slackSettings.missingSecrets.join(", ")}.
                  </p>
                )}
              </div>
            ) : !conn ? (
              <div className="space-y-2">
                {slackSettings.askedForSlack && (
                  <p className="text-[13px] font-medium leading-5 text-fg">
                    You said your team uses Slack. Connect it here so your departments can answer there.
                  </p>
                )}
                <p className="text-[13px] leading-5 text-fg-muted">
                  Install the OASIS app in your Slack workspace, then pick a department for each channel. An @mention gets
                  a draft reply from that department, and nothing is posted until an owner or admin approves it.
                </p>
                {viewer.access.canManage ? (
                  <a href="/api/connections/slack/authorize" className="btn-primary inline-flex">
                    Add to Slack
                  </a>
                ) : (
                  <p className="text-[13px] leading-5 text-fg-dim">An owner or admin installs Slack for the workspace.</p>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 text-[13px] leading-5">
                    <div className="font-medium text-fg">{conn.account_label ?? conn.account_id ?? "Slack workspace"}</div>
                    <div className="text-fg-muted">
                      {conn.last_health_detail ??
                        `Mirrored messages are deleted after ${SLACK_RETENTION_DAYS} days. Replies wait for approval in the Feed or in Slack.`}
                    </div>
                  </div>
                  {viewer.access.canManage && <SlackDisconnect teamName={conn.account_label} />}
                </div>
                {slackSettings.routesNotInstalled ? (
                  <p className="text-[13px] leading-5 text-status-warm">
                    The channel map is not available on this deployment yet (its database tables are not installed), so
                    nothing is mirrored or answered.
                  </p>
                ) : viewer.access.canManage ? (
                  <SlackChannelMap
                    departments={departments}
                    savedRoutes={(slackSettings.routes ?? []).map((r) => ({
                      channel_id: r.channel_id,
                      channel_name: r.channel_name,
                      department: r.department,
                      customer_id: r.customer_id,
                    }))}
                  />
                ) : (
                  <ul className="space-y-1 text-[13px] leading-5">
                    {(slackSettings.routes ?? []).length === 0 ? (
                      <li className="text-fg-muted">No channel is mapped yet. An owner or admin maps channels.</li>
                    ) : (
                      (slackSettings.routes ?? []).map((r) => (
                        <li key={r.channel_id} className="text-fg-muted">
                          <span className="font-medium text-fg">#{r.channel_name ?? r.channel_id}</span>{" "}
                          {r.department ? OS_DEPARTMENTS.find((d) => d.key === r.department)?.label : "General"}
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </div>
            )}
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
