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
 *   - Telegram: each person can link their own bot (TelegramConnectCard,
 *     rendered by SettingsContent's chat-apps section), though nothing sends
 *     to a personal bot yet, and owners see the shared team-alerts bot's
 *     status (its Connections card's own). Two-way AI teammates in Telegram
 *     chats are not built, and the card says exactly that: a state, never a
 *     release promise, with a button that asks OASIS for it.
 *   - Discord, Microsoft Teams, WhatsApp: not built. Each opens the shared
 *     Connections drawer, which says why and files the request (no dead chip).
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
import { ConnectorDrawerButton } from "@/components/os/connections/ConnectorDrawerButton";
import { RequestConnector } from "@/components/os/connections/RequestConnector";
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
import { SLACK_APPROVAL_RULE, slackInstallBanner } from "@/lib/slack/copy";
import { answeringDepartments } from "@/lib/slack/routing";
import { getManifest } from "@/lib/manifest/loader";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import { SLACK_RETENTION_DAYS } from "@/lib/slack/retention";

export const dynamic = "force-dynamic";

/** An app nothing is built for yet: the state, with no date or phase attached. */
const NOT_BUILT: ConnectorStatus = { kind: "coming_soon", label: "Not built yet" };

/** The not-built Telegram capability, as its request names it on OASIS's desk. */
const TELEGRAM_TEAMMATES = "AI teammates in Telegram";
const TELEGRAM_TEAMMATES_REASON =
  "Today Telegram carries alerts only. A teammate you could message directly, or add to a group chat and link to a department, is not built.";

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
  // This workspace's ways into Slack that are not built yet, as the
  // Connections drawer states them (resolved for its kind of workspace).
  const slackPending = (slackCardStatus?.paths ?? []).filter((p) => p.requestable);
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
  // Only departments with an AI teammate in THIS workspace can answer in Slack,
  // so only they are offered (the channels API refuses the rest). Who leads a
  // department is the workspace manifest's answer, read the way the Slack job
  // and the chat route read it (the slug this workspace owns).
  // resolveOwnedSlug answers a read that FAILED with null (it swallows both of
  // its reads: lib/manifest/tenant-scope.ts), so a null slug is "could not
  // check", never "no department can answer here" (W4a D1, as lib/slack/jobs.ts
  // and the channels API treat it).
  const manifestSlug = await resolveOwnedSlug(viewer.tenantId);
  const rosterUnread = manifestSlug === null;
  const manifest = manifestSlug ? await getManifest(manifestSlug, viewer.tenantId) : null;
  const answering = rosterUnread ? [] : answeringDepartments({ oasis: viewer.access.oasisWorkspace, manifest });
  const mappableDepartments = OS_DEPARTMENTS.filter((d) => answering.includes(d.key)).map((d) => ({ key: d.key, label: d.label }));

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
            ) : !conn && slackPending.length > 0 ? (
              // This workspace's own way into Slack is not built yet: the same
              // state and request as the Connections drawer, never a dead card.
              <div className="space-y-3">
                {slackPending.map((p) => (
                  <div key={p.title} className="space-y-2">
                    <p className="text-[13px] leading-5 text-fg-muted">
                      <span className="font-medium text-fg">{p.title}</span> ({p.state.toLowerCase()}). {p.body}
                    </p>
                    <RequestConnector name={`Slack (${p.title})`} reason={p.body} from="Settings > Chat apps" buttonClassName="btn-secondary" />
                  </div>
                ))}
              </div>
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
                  a draft reply from that department. {SLACK_APPROVAL_RULE}
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
                  {viewer.access.canManage && <SlackDisconnect teamName={conn.account_label} retentionDays={SLACK_RETENTION_DAYS} />}
                </div>
                {slackSettings.routesNotInstalled ? (
                  <p className="text-[13px] leading-5 text-status-warm">
                    The channel map is not available on this deployment yet (its database tables are not installed), so
                    nothing is mirrored or answered.
                  </p>
                ) : viewer.access.canManage && rosterUnread ? (
                  // The roster could not be read: say so and retry, never offer a
                  // map in which no department can answer.
                  <p role="status" className="text-[13px] leading-5 text-status-warm">
                    OASIS couldn&apos;t check which departments can answer in Slack just now. Reload in a minute.
                  </p>
                ) : viewer.access.canManage ? (
                  <SlackChannelMap
                    departments={mappableDepartments}
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
                <StatusLine status={{ kind: "coming_soon", label: "Telegram teammates are not built yet" }} />
              </div>
              <p className="mt-0.5 leading-5 text-fg-muted">
                Today Telegram carries alerts only. A teammate you could message directly, or add to a group chat and
                link to a department, is not built.
              </p>
              <div className="mt-2">
                <RequestConnector name={TELEGRAM_TEAMMATES} reason={TELEGRAM_TEAMMATES_REASON} from="Settings > Chat apps" buttonClassName="btn-secondary" />
              </div>
            </div>
          </ChatAppCard>
        )}

        {/* Each person's own alert bot (and SunBiz's link-code card on its own
            workspace) — SettingsContent's chat-apps cards, unchanged. */}
        <SettingsContent section="chat-apps" viewerAccess={viewer.viewerAccess} />

        {later.length > 0 && (
          <section className="rounded-xl border border-hairline bg-bg-panel px-4 py-4">
            <h2 className="text-sm font-semibold text-fg">Not built</h2>
            <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">
              Nothing exists for these yet, so there is nothing to set up. Open one to see why, and ask OASIS for it.
            </p>
            <ul className="mt-3 grid gap-2 sm:grid-cols-3">
              {later.map((d) => (
                <li key={d.slug}>
                  {/* The same drawer as Settings > Connections: why, and the request (no dead chip). */}
                  <ConnectorDrawerButton
                    slug={d.slug}
                    status={resolveConnectorStatus(d, facts, nowMs)}
                    requestFrom="Settings > Chat apps"
                    ariaLabel={`${d.name}: not built yet. Open to see why and ask OASIS for it`}
                    className="flex w-full items-center gap-2.5 rounded-lg border border-hairline bg-bg-raised/40 px-3 py-2 text-left transition-colors duration-150 hover:border-bg-border-strong hover:bg-bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent/70"
                    label={
                      <>
                        <ConnectorIcon def={d} size="sm" />
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-medium text-fg">{d.name}</span>
                          <StatusLine status={NOT_BUILT} />
                        </span>
                      </>
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </PageFrame>
  );
}
