/**
 * JevCard - Settings > AI brain: Jev (TypeSafe's System One), the specialist
 * classifier, as this workspace has it.
 *
 * Every line is the workspace's real state or a sourced fact:
 *   status     the Jev connection, through the Connections hub's own resolver
 *              (lib/os/connectors.ts): "Not connected" until a key exists,
 *              green only after a live check passed in the last day
 *   mode       manifest.integrations.jev, or the default (shadow for OASIS's
 *              own workspace, off for clients), and what that means here
 *   numbers    this workspace's jev_calls over 30 days: last latency, shadow
 *              agreement, failures. No calls = "none yet", never 0%.
 *   data       where the text goes (TypeSafe, United States), what TypeSafe
 *              says about training and retention, and the price, each as
 *              TypeSafe publishes it (checked 2026-09-30).
 *
 * Server component; the page reads the facts and passes them in.
 */

import Link from "next/link";
import { StatusLine } from "@/components/os/connections/StatusLine";
import { formatVerifiedAgo, type ConnectorStatus } from "@/lib/os/connectors";
import type { PublicConnection } from "@/lib/connections/store";
import type { JevStats, ResolvedJevMode } from "@/lib/jev/mode";

export type JevCardFacts = {
  /** The card's status, from the Connections hub's resolver (never built here). */
  status: ConnectorStatus;
  connection: PublicConnection | null;
  mode: ResolvedJevMode | null;
  /** null when the telemetry could not be read (or its table is not installed). */
  stats: JevStats | null;
  statsNote: string | null;
};

function modeSentence(mode: ResolvedJevMode | null, oasis: boolean): string {
  if (!mode) return "The mode could not be read just now, so nothing is sent to Jev.";
  const origin = mode.source === "manifest" ? "set for this workspace" : oasis ? "the default for OASIS's own workspace" : "the default for a client workspace";
  switch (mode.mode) {
    case "off":
      return `Off (${origin}). Nothing is sent to Jev.`;
    case "shadow":
      return `Shadow (${origin}). OASIS decides as it always does; Jev answers the same question afterwards, and only whether it agreed is kept.`;
    default:
      return `On (${origin}). OASIS does not let Jev decide anything yet, so it runs exactly as shadow.`;
  }
}

export function JevCard({
  facts,
  nowMs,
  canManage,
  oasis,
  textApproved,
}: {
  facts: JevCardFacts;
  nowMs: number;
  canManage: boolean;
  oasis: boolean;
  /** lib/jev/mode.ts JEV_TEXT_PROCESSING_APPROVED: may workspace text go to TypeSafe at all yet? */
  textApproved: boolean;
}) {
  const s = facts.stats;
  // A refused or broken key sends nothing (lib/jev/mode.ts jevKeyFor).
  const connected = !!facts.connection && facts.connection.status !== "expired" && facts.connection.status !== "error";
  const sends = connected && facts.mode !== null && facts.mode.mode !== "off";
  return (
    <section className="rounded-xl border border-hairline bg-bg-panel" aria-labelledby="jev-card-title">
      <header className="flex flex-wrap items-start justify-between gap-3 px-4 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 id="jev-card-title" className="text-sm font-semibold text-fg">
              Jev (TypeSafe) · specialist classifier
            </h2>
            <StatusLine status={facts.status} />
          </div>
          <p className="mt-1 text-[13px] leading-5 text-fg-muted">
            A fast model for &quot;which one of these&quot; questions, paid with your own TypeSafe key. It never writes, sends
            or decides anything.
          </p>
        </div>
        {canManage && (
          <Link href="/settings/connections?app=jev" prefetch={false} className={connected ? "btn-secondary" : "btn-primary"}>
            {connected ? "Manage key" : "Connect a key"}
          </Link>
        )}
      </header>

      <dl className="grid gap-x-4 gap-y-3 border-t border-hairline px-4 py-4 text-[13px] leading-5 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <dt className="font-medium text-fg-dim">Mode</dt>
        <dd className="text-fg">{modeSentence(facts.mode, oasis)}</dd>

        <dt className="font-medium text-fg-dim">What OASIS asks it</dt>
        <dd className="text-fg-muted">
          {!textApproved
            ? "Nothing yet. TypeSafe is not on OASIS's published list of processors, so no workspace text is sent to it until that is approved. Once it is, in shadow: the priority and category of each new support ticket, and which department a message in a general Slack channel belongs to. The key check sends no data."
            : sends
              ? "The priority and category of each new support ticket, and which department a message in a general Slack channel belongs to. Nothing else."
              : connected
                ? "Nothing while the mode is off."
                : "Nothing: no key is connected."}
          {oasis && (
            <span className="mt-1 block text-fg-dim">
              OASIS&apos;s inbound email classifier runs outside this app with its own key and switch, and is not counted here.
            </span>
          )}
        </dd>

        <dt className="font-medium text-fg-dim">Last 30 days</dt>
        <dd className="text-fg-muted">
          {s === null ? (
            facts.statsNote ?? "Could not read Jev's numbers just now."
          ) : s.calls === 0 ? (
            "No calls yet."
          ) : (
            <>
              {s.calls} {s.calls === 1 ? "answer" : "answers"} recorded
              {s.agreementPct === null ? ", none comparable yet" : `, agreed with OASIS ${s.agreementPct}% of the time`}
              {s.failed > 0 ? `; ${s.failed} did not answer` : ""}.
              {s.lastLatencyMs !== null && ` Last call took ${s.lastLatencyMs} ms${s.lastAt ? `, ${formatVerifiedAgo(s.lastAt, nowMs)}` : ""}.`}
            </>
          )}
        </dd>

        <dt className="font-medium text-fg-dim">Where the text goes</dt>
        <dd className="text-fg-muted">
          To TypeSafe, hosted in the United States. TypeSafe&apos;s privacy policy says it does not train or fine-tune models
          on your inputs; it keeps usage telemetry and names no retention period. Under Québec&apos;s Law 25, sending personal
          information outside Québec calls for a privacy impact assessment first. OASIS stores only timing and agreement,
          never the text or Jev&apos;s answer.
        </dd>

        <dt className="font-medium text-fg-dim">Price</dt>
        <dd className="text-fg-muted">
          $42 per billion input tokens; output tokens are free (TypeSafe&apos;s published price, docs.typesafe.ai/models,
          checked 2026-09-30). Billed by TypeSafe to your key.
        </dd>
      </dl>
    </section>
  );
}
