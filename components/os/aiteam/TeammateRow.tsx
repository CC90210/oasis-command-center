/**
 * TeammateRow — one AI teammate on the AI Team roster: initial, name, what it
 * does, which departments it leads, and where it lives.
 *
 * WHERE IT LIVES IS STATED, NOT IMPLIED. "App channel" is the department
 * channel (or the custom teammate's chat) inside this app and says whether it
 * can answer, with the reason when it cannot ("not working: AI account refused
 * the request (check billing)"). It used to be labelled "Web", which read as a
 * web-access capability and sent the owner hunting for a tool setting when the
 * cause was the provider's last refusal (S4-01). Slack is the workspace's real
 * state (lib/slack/status.ts): the channels mapped to the department, "by
 * @mention" when none is, "not connected", or "app not set up" where OASIS's
 * Slack app is not on this deployment. Custom teammates do not answer in Slack,
 * so their rows say nothing about it. When the Slack card itself says the
 * connection needs attention or could not be checked, the row says the card's
 * words instead of the channels (lib/os/connectors.ts connectionProblem): a
 * mapped channel on an expired connection answers nobody. Telegram carries
 * alerts only today: no teammate answers there, and the row says that only
 * where the workspace has a Telegram team bot set up (the Telegram card's own
 * status), never as a fixed line.
 *
 * ON / OFF (W4a, S2-06). An owner or admin gets a real switch on every
 * teammate that has one (the page passes a TeammateToggle as `control`: POST
 * /api/tenant/agents/toggle), so a teammate built in the builder is never stuck
 * "Off" with no way to turn it on. Core teammates have no switch. Everyone
 * else reads the state word.
 *
 * Server component, with no client import of its own (the page hands the
 * switch in), so it renders anywhere. Dense rows on a hairline list, the same
 * density as the rail and the channel; no card grid.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import type { TeammateHome } from "./roster";
import type { SlackHome } from "@/lib/slack/status";

/**
 * ready          answering (a key on file, and no failed last turn)
 * not_working    a key on file, but its channel's last turn failed; the
 *                department header says "Not working" for the same reason
 * not_connected  no AI account, or no agent settings, for this workspace
 * not_set_up     no teammate behind this department yet
 * off            the teammate is switched off in this workspace
 * unknown        a read behind the answer failed, so it is not known
 */
export type WebState = "ready" | "not_working" | "not_connected" | "not_set_up" | "off" | "unknown";

const WEB_LABEL: Record<WebState, string> = {
  ready: "App channel",
  not_working: "App channel · not working",
  not_connected: "App channel · not connected",
  not_set_up: "App channel · not set up",
  off: "App channel · off",
  unknown: "App channel · couldn’t check",
};

/** The chip's text: the state, and for a failure the short reason the header gives. */
export function webLabel(web: WebState, reason?: string | null): string {
  return web === "not_working" && reason ? `${WEB_LABEL[web]}: ${reason}` : WEB_LABEL[web];
}

function Initial({ name }: { name: string }) {
  const letter = (name.trim().charAt(0) || "?").toUpperCase();
  return (
    <span
      aria-hidden
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-hairline bg-bg-raised text-sm font-semibold text-fg"
    >
      {letter}
    </span>
  );
}

function slackLabel(slack: SlackHome): string {
  switch (slack.kind) {
    case "channels":
      return `Slack · ${slack.names.map((n) => `#${n}`).join(", ")}`;
    case "mention_only":
      return "Slack · by @mention";
    case "not_connected":
      return "Slack · not connected";
    case "not_configured":
      return "Slack · app not set up";
    default:
      return "Slack · couldn’t check";
  }
}

export function Homes({
  web,
  webReason,
  slack,
  slackProblem,
  telegramSetUp,
}: {
  web: WebState;
  webReason?: string | null;
  slack?: SlackHome;
  /** The Slack card's own words when its connection is a problem (connectionProblem); null when it is fine. */
  slackProblem?: string | null;
  /** The workspace has a Telegram team bot set up (connectionSetUp of the Telegram card). */
  telegramSetUp?: boolean;
}) {
  const slackAnswers = !!slack && (slack.kind === "channels" || slack.kind === "mention_only");
  return (
    <ul aria-label="Where it lives" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-4">
      <li
        className={`inline-flex items-center gap-1 ${
          web === "ready" ? "text-fg-muted" : web === "not_working" ? "text-status-hot" : "text-fg-dim"
        }`}
      >
        {web === "ready" && <Check className="h-3.5 w-3.5 text-status-engaged" strokeWidth={2} aria-hidden />}
        {webLabel(web, webReason)}
      </li>
      {slack &&
        (slackAnswers && slackProblem ? (
          <li className="text-status-warm">Slack · {slackProblem}</li>
        ) : (
          <li className={slackAnswers ? "text-fg-muted" : "text-fg-dim"}>{slackLabel(slack)}</li>
        ))}
      {telegramSetUp && <li className="text-fg-dim">Telegram · alerts only</li>}
    </ul>
  );
}

export function TeammateRow({
  name,
  summary,
  meta,
  departments,
  web,
  webReason,
  slack,
  slackProblem,
  telegramSetUp,
  href,
  badge,
  control,
}: {
  name: string;
  summary: string;
  /** Category, or "Custom". Muted, beside the name. */
  meta?: string;
  departments?: readonly TeammateHome[];
  web: WebState;
  /** Why the app channel is not working, in the header's short words (lib/os/channel/outcome failureCopy). */
  webReason?: string | null;
  /** Where it lives in Slack; absent for teammates that do not answer there. */
  slack?: SlackHome;
  /** The Slack card's words when its connection is a problem; null when it is fine. */
  slackProblem?: string | null;
  /** The workspace has a Telegram team bot set up. */
  telegramSetUp?: boolean;
  /** Where the name links: the teammate's channel or chat. */
  href?: string | null;
  /** A short state word on the right, e.g. "On" / "Off", for a viewer with no switch. */
  badge?: string;
  /** The On/Off switch an owner or admin gets (a TeammateToggle); it takes the badge's place. */
  control?: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <Initial name={name} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          {href ? (
            <Link href={href} prefetch={false} className="text-sm font-semibold text-fg hover:underline">
              {name}
            </Link>
          ) : (
            <span className="text-sm font-semibold text-fg">{name}</span>
          )}
          {meta && <span className="text-xs text-fg-dim">{meta}</span>}
        </div>
        {summary && <p className="text-[13px] leading-5 text-fg-muted">{summary}</p>}
        {departments && departments.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {departments.map((d) => (
              <Link
                key={d.href}
                href={d.href}
                prefetch={false}
                className="inline-flex h-6 items-center rounded-md border border-hairline px-1.5 text-xs font-medium text-fg-muted transition-colors duration-150 hover:bg-active-hover hover:text-fg"
              >
                {d.label}
              </Link>
            ))}
          </div>
        )}
        <Homes web={web} webReason={webReason} slack={slack} slackProblem={slackProblem} telegramSetUp={telegramSetUp} />
      </div>
      {control
        ? control
        : badge && (
            <span className="shrink-0 rounded-md border border-hairline px-1.5 py-0.5 text-[11px] font-medium leading-4 text-fg-muted">
              {badge}
            </span>
          )}
    </li>
  );
}
