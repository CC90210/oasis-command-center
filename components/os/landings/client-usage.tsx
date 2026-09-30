/**
 * ClientUsagePanel — the record's Usage tab: what the client does in their own
 * OASIS workspace over the last 30 days (lib/os/customers/usage.ts). This is
 * how OASIS collects its clients' usage.
 *
 * Shown once the record is linked to the client's workspace; the link is the
 * platform operator's to make (LinkWorkspaceControl), everyone else is told
 * who can. "No snapshot yet" is said as such, never as zeros.
 */
import { Card, EmptyState } from "@/components/Card";
import { timeAgo } from "@/lib/fmt";
import type { ClientUsage } from "@/lib/os/customers/usage";
import { LinkWorkspaceControl } from "@/components/os/landings/clients-actions";

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-bg-panel px-4 py-3">
      <div className="text-xs text-fg-dim">{label}</div>
      <div className="mt-1 text-base font-semibold tabular-nums text-fg">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-fg-dim">{hint}</div>}
    </div>
  );
}

export function ClientUsagePanel({
  customerId,
  usage,
  linkable,
}: {
  customerId: string;
  usage: ClientUsage | null;
  /** The operator's workspace list; null when the viewer may not link. */
  linkable: Array<{ id: string; name: string; slug: string | null }> | null;
}) {
  const control = linkable ? (
    <LinkWorkspaceControl
      customerId={customerId}
      current={usage?.workspace ? { id: usage.workspace.id, label: usage.workspace.name } : null}
      options={linkable.map((w) => ({ value: w.id, label: w.slug ? `${w.name} (${w.slug})` : w.name }))}
    />
  ) : null;

  if (!usage) {
    return (
      <Card>
        <div className="space-y-3 py-2">
          <p className="text-sm font-medium text-fg">Not linked to the client&rsquo;s workspace yet.</p>
          <p className="max-w-prose text-[13px] text-fg-muted">
            Once this record is linked to the client&rsquo;s own OASIS workspace, this tab shows what they do there: messages
            handled, leads processed, AI actions, hours saved, agent activity, approvals and support tickets.
            {linkable ? "" : " The platform operator links it."}
          </p>
          {control}
        </div>
      </Card>
    );
  }

  const r = usage.roi;
  const noSnapshot = r.snapshotDays === 0;
  return (
    <div className="space-y-6">
      <p className="text-[13px] text-fg-muted">
        {usage.workspace ? (
          <>
            Their workspace: <span className="text-fg">{usage.workspace.name}</span>
            {usage.workspace.slug ? <span className="font-mono text-xs text-fg-dim"> ({usage.workspace.slug})</span> : null}.{" "}
          </>
        ) : (
          <span className="text-status-warm">The linked workspace no longer exists. </span>
        )}
        The last {usage.windowDays} days, since {usage.since}.
      </p>
      {noSnapshot ? (
        <Card>
          <EmptyState message="No usage snapshot for this workspace in the last 30 days. The nightly roll-up has not recorded it yet, so its numbers are not known." />
        </Card>
      ) : (
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Figure label="Messages handled" value={r.messagesHandled.toLocaleString("en-US")} />
          <Figure label="Leads processed" value={r.leadsProcessed.toLocaleString("en-US")} />
          <Figure label="AI actions" value={r.aiActionsTaken.toLocaleString("en-US")} />
          <Figure
            label="Hours saved (estimate)"
            value={`${r.hoursSaved}h`}
            hint={`${r.snapshotDays} day${r.snapshotDays === 1 ? "" : "s"} recorded; last ${r.lastSnapshot ?? "none"}`}
          />
        </section>
      )}
      <section className="grid gap-3 sm:grid-cols-3">
        <Figure
          label="Agent channels used"
          value={String(usage.agents.channelsUsed)}
          hint={
            usage.agents.channelsUsed
              ? `${usage.agents.lastTurnFailed} ended on a failed turn · last ${timeAgo(usage.agents.lastTurnAt)}`
              : "No agent turn in 30 days"
          }
        />
        <Figure
          label="Approvals raised"
          value={String(usage.approvals.raised)}
          hint={`${usage.approvals.pending} waiting · ${usage.approvals.executed} carried out · ${usage.approvals.failed} failed`}
        />
        <Figure label="Tickets on their desk" value={String(usage.tickets.opened)} hint={`${usage.tickets.stillOpen} still open`} />
      </section>
      {control && <div className="border-t border-hairline pt-4">{control}</div>}
    </div>
  );
}
