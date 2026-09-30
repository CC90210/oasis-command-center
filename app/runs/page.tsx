import { Card, EmptyState, PageHeader, Tag } from "@/components/Card";
import { recentActions, getActiveProfile } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { timeAgo } from "@/lib/fmt";
import { requireOperator } from "@/lib/role-surfaces-session";

export const dynamic = "force-dynamic";

type ActionPayload = {
  type?: string;
  ok?: boolean;
  summary?: string | null;
  error?: string | null;
  before?: unknown;
  after?: unknown;
  user_id?: string;
};

export default async function RunsPage() {
  // Operator-only (P0-5). Gate before any query, so a client member never has
  // the agent audit log fetched, rather than fetched and left unpainted.
  await requireOperator();
  const profile = await getActiveProfile();
  if (!profile?.tenant_id) {
    return (
      <div>
        <PageHeader title="Runs" subtitle="No tenant context." />
        <Card title="Action history">
          <EmptyState message="Sign in to load mutation history." />
        </Card>
      </div>
    );
  }
  // null = the audit log could not be read: "Couldn't check", never the
  // "No agent mutations recorded yet" of a log that really is empty.
  const events = await safe("runs.recent_actions", recentActions(profile.tenant_id, 100), null);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Runs"
        subtitle="Audit log of every change an agent makes to your dashboard data."
      />

      <Card title="What lands here">
        <div className="space-y-3 text-sm text-fg-muted leading-relaxed">
          <p>
            When an agent changes something in your dashboard — a lead&apos;s
            status, a profile field, a plan-template entry — it writes a{" "}
            <span className="font-mono text-fg">&lt;dashboard-action&gt;</span>{" "}
            marker in its reply, and the Command Center applies it to your
            workspace&apos;s data. Every one of those changes is logged here,
            success or failure, with the agent that made it and when.
          </p>
          <p>
            <span className="text-fg font-medium">The Coding harness and cloud chats both land here.</span>{" "}
            The harness runs Claude Code on your computer; its reply comes back
            through the Command Center, which applies and logs the markers the
            same way it does for a cloud chat. Two places to work, one audit trail.
          </p>
          <p className="text-fg-dim">
            <span className="text-fg font-medium">When to look here:</span>{" "}
            something unexpected changed — a value you didn&apos;t expect to
            move, a stage transition that surprised you. The Runs log shows
            who did it, what the change was, and whether it succeeded.
          </p>
        </div>
      </Card>

      <Card
        title="Recent agent actions"
        subtitle={
          events === null
            ? "Couldn't check the audit log just now."
            : events.length === 0
              ? "Empty so far — ask an agent to update something to see it here."
              : `Last ${events.length} mutations across all agents.`
        }
      >
        {events === null ? (
          <EmptyState message="Couldn't check the agent actions. The read failed and has been logged; this does not mean nothing changed. Reload to try again." />
        ) : events.length === 0 ? (
          <EmptyState message="No agent mutations recorded yet. When an agent changes dashboard data from the Coding harness or a chat, the change lands here." />
        ) : (
          <ul className="divide-y divide-bg-border">
            {events.map((ev) => {
              const p = (ev.payload || {}) as ActionPayload;
              const ok = !!p.ok;
              return (
                <li
                  key={ev.id}
                  className="py-3 flex items-start gap-3 text-sm"
                >
                  <Tag tone={ok ? "engaged" : "warm"}>{ok ? "ok" : "err"}</Tag>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                        {ev.publisher_agent}
                      </span>
                      <span className="font-mono text-fg">
                        {p.type || "?"}
                      </span>
                    </div>
                    <div className="text-fg-muted mt-0.5 break-words">
                      {ok
                        ? p.summary || "(no summary)"
                        : p.error || "(no error message)"}
                    </div>
                  </div>
                  <span className="text-xs text-fg-dim font-mono flex-shrink-0">
                    {timeAgo(ev.published_at)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
