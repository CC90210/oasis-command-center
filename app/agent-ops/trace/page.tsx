/**
 * /agent-ops/trace - Admin > Agent ops, Execution trace (2026-10-28).
 *
 * The old /runs, moved beside the directives: every change an agent made to the workspace's data (a
 * dashboard_action event, from the Coding harness after Apply and Confirm, or from a cloud chat), whether
 * it worked, and which fields it changed, key by key (lib/os/agent-ops.ts keyChanges). Values are
 * scrubbed of secrets before they are drawn.
 *
 * GATE: requireOperator() first, before any read. /runs redirects here (lib/os/redirects.ts).
 */
import { Card, EmptyState, Tag } from "@/components/Card";
import { AgentOpsTabs } from "@/components/os/agent-ops/AgentOpsTabs";
import { PageFrame } from "@/components/os/PageFrame";
import { safe } from "@/lib/api-helpers";
import { timeAgo } from "@/lib/devices/presence";
import { agentName, keyChanges } from "@/lib/os/agent-ops";
import { getActiveProfile, recentActions } from "@/lib/queries";
import { requireOperator } from "@/lib/role-surfaces-session";
import { redactAll } from "@/lib/secret-redaction";

export const dynamic = "force-dynamic";
export const metadata = { title: "Execution trace" };

type ActionPayload = {
  type?: string;
  ok?: boolean;
  summary?: string | null;
  error?: string | null;
  before?: unknown;
  after?: unknown;
};

export default async function AgentOpsTracePage() {
  await requireOperator();
  const profile = await safe("agent-ops.trace.profile", getActiveProfile(), null);
  const tenantId = profile?.tenant_id || "";
  const now = Date.now();
  // null = the audit log could not be read: "Couldn't check", never "nothing changed".
  const events = tenantId ? await safe("agent-ops.trace.actions", recentActions(tenantId, 100), null) : null;

  return (
    <PageFrame
      title="Agent ops"
      subtitle="Send an agent a directive and see what became of it, and every change the agents made to your data."
    >
      <div className="space-y-6">
        <AgentOpsTabs active="trace" />
        <Card
          title="Execution trace"
          subtitle={
            events === null
              ? "Couldn't check the audit log just now."
              : events.length === 0
                ? "Nothing yet."
                : `The last ${events.length} changes, across every agent.`
          }
        >
          {events === null ? (
            <EmptyState message="Couldn't check the agent actions. The read failed and has been logged; this does not mean nothing changed. Reload to try again." />
          ) : events.length === 0 ? (
            <EmptyState message="No agent has changed your data yet. A change from the Coding harness (after you Apply and Confirm it) or from a cloud chat lands here, with what it changed." />
          ) : (
            <ul className="divide-y divide-bg-border">
              {events.map((ev) => {
                const p = (ev.payload || {}) as ActionPayload;
                const ok = Boolean(p.ok);
                const { changes, more } = keyChanges(p.before, p.after);
                return (
                  <li key={ev.id} className="space-y-1.5 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Tag tone={ok ? "engaged" : "warm"}>{ok ? "worked" : "failed"}</Tag>
                      <span className="font-medium text-fg">{agentName(ev.publisher_agent)}</span>
                      <span className="font-mono text-[12px] text-fg-muted">{p.type || "unknown action"}</span>
                      <span className="ml-auto font-mono text-[11px] text-fg-dim">{timeAgo(ev.published_at, { now })}</span>
                    </div>
                    <div className="break-words text-fg-muted">
                      {redactAll(ok ? p.summary || "(no summary)" : p.error || "(no error message)")}
                    </div>
                    {changes.length > 0 ? (
                      <dl className="grid gap-x-3 gap-y-1 rounded-md border border-bg-border bg-bg-deep/40 px-3 py-2 font-mono text-[11.5px] sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
                        {changes.map((c) => (
                          <div key={c.key} className="contents">
                            <dt className="truncate text-fg-dim">{c.key}</dt>
                            <dd className="min-w-0 break-words">
                              {c.before !== null ? <span className="text-status-warm line-through decoration-status-warm/50">{redactAll(c.before)}</span> : null}
                              {c.before !== null && c.after !== null ? <span className="text-fg-dim"> {"->"} </span> : null}
                              {c.after !== null ? <span className="text-status-engaged">{redactAll(c.after)}</span> : null}
                            </dd>
                          </div>
                        ))}
                        {more > 0 ? <div className="text-fg-dim sm:col-span-2">and {more} more</div> : null}
                      </dl>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </PageFrame>
  );
}
