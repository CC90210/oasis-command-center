/**
 * /agent-ops - Admin > Agent ops, Handoffs & directives (2026-10-28).
 *
 * Merges the old /inbox (the agents' notes to each other) with a way to send an agent a directive and
 * see what became of it. A directive to Bravo, Atlas or Maven is delivered by the agents owner's
 * computer into that agent's local inbox within a minute (app/api/bridge/inbox,
 * bravo_cli/inbox_relay.py), and each note says, in one line, only what its record proves: waiting,
 * delivered, read, or that no computer carries it (lib/os/agent-ops.ts deliveryStateOf).
 *
 * GATE: requireOperator() first, before any read. /inbox redirects here (lib/os/redirects.ts).
 */
import { ChevronRight } from "lucide-react";
import { Card, EmptyState, Tag } from "@/components/Card";
import { AgentInboxComposer } from "@/components/AgentInboxList";
import { AgentOpsTabs } from "@/components/os/agent-ops/AgentOpsTabs";
import { DismissNote } from "@/components/os/agent-ops/DismissNote";
import { PageFrame } from "@/components/os/PageFrame";
import { listAgentOpsMessagesDb, RELAY_RECIPIENTS, type DbInboxMessage } from "@/lib/agent-inbox-db";
import { safe } from "@/lib/api-helpers";
import { timeAgo } from "@/lib/devices/presence";
import { agentName, deliveryStateOf, type DeliveryComputer, type DeliveryTone } from "@/lib/os/agent-ops";
import { readDeliveryComputer } from "@/lib/os/agent-ops-data";
import { readAgentsOwner } from "@/lib/agents-owner";
import { getActiveProfile } from "@/lib/queries";
import { requireOperator } from "@/lib/role-surfaces-session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agent ops" };

const TONE_TEXT: Record<DeliveryTone, string> = {
  neutral: "text-fg-muted",
  info: "text-status-info",
  warm: "text-status-warm",
  engaged: "text-status-engaged",
};

const PRIORITY_TONE: Record<string, "hot" | "warm" | "info" | "neutral"> = {
  urgent: "hot",
  high: "warm",
  normal: "info",
  low: "neutral",
};

export default async function AgentOpsPage() {
  await requireOperator();
  const profile = await safe("agent-ops.profile", getActiveProfile(), null);
  const tenantId = profile?.tenant_id || "";
  const now = Date.now();
  // null = the notes could not be read ("Couldn't check", never "no notes");
  // undefined computer = its read failed, which a waiting note says.
  const [messages, computer, owner] = await Promise.all([
    tenantId ? safe<DbInboxMessage[] | null>("agent-ops.messages", listAgentOpsMessagesDb(tenantId), null) : Promise.resolve(null),
    tenantId
      ? safe<DeliveryComputer | null | undefined>("agent-ops.computer", readDeliveryComputer(tenantId), undefined)
      : Promise.resolve(undefined),
    tenantId ? readAgentsOwner(tenantId) : Promise.resolve({ state: "unavailable" as const }),
  ]);
  // Only the agents owner dispatches (app/api/inbox/post): a directive runs on their computer.
  const mayDispatch = owner.state === "set" && Boolean(profile?.auth_user_id) && owner.authUserId === profile?.auth_user_id;
  const byMessageId = new Map((messages ?? []).map((m) => [m.message_id, m]));

  return (
    <PageFrame
      title="Agent ops"
      subtitle="Send an agent a directive and see what became of it, and every change the agents made to your data."
    >
      <div className="space-y-6">
        <AgentOpsTabs active="handoffs" />

        <Card
          title="Dispatch a directive"
          subtitle={
            computer === undefined
              ? "Couldn't check which computer delivers directives just now."
              : computer === null
                ? "No computer is set up to deliver directives yet: a directive waits here until one is."
                : computer.deliversNotes
                  ? `${computer.label} delivers it to the agent's own inbox within a minute; the agent reads it at the start of its next session.`
                  : `${computer.label}'s bridge predates delivery. Restart it to update, and directives start arriving.`
          }
        >
          {mayDispatch ? (
            <AgentInboxComposer recipients={RELAY_RECIPIENTS} submitLabel="Dispatch" />
          ) : (
            <p className="text-sm text-fg-muted">
              {owner.state === "unavailable"
                ? "Couldn't check who may dispatch just now. Reload to try again."
                : owner.state === "set"
                  ? "Only the workspace's agents owner can dispatch: a directive runs on that person's computer."
                  : "No agents owner is set for this workspace yet, so directives can't be dispatched."}
            </p>
          )}
        </Card>

        <Card
          title="Directives and handoffs"
          subtitle={
            messages === null
              ? "Couldn't check the notes just now."
              : messages.length === 0
                ? "Nothing yet."
                : `The newest ${messages.length}, with what became of each.`
          }
        >
          {messages === null ? (
            <EmptyState message="Couldn't read the notes. The read failed and has been logged; this does not mean there are none. Reload to try again." />
          ) : messages.length === 0 ? (
            <EmptyState message="No directives or handoffs yet. A directive you dispatch above shows here, with whether it was delivered and read." />
          ) : (
            <ul className="divide-y divide-bg-border">
              {messages.map((m) => {
                const state = deliveryStateOf(m, computer, now);
                const parent = m.in_reply_to ? byMessageId.get(m.in_reply_to) : undefined;
                const open = !m.read_at;
                return (
                  <li key={m.id} className="space-y-1.5 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium text-fg">
                        {agentName(m.from_agent)} <span className="text-fg-dim">to</span> {agentName(m.to_agent)}
                      </span>
                      <Tag tone={PRIORITY_TONE[m.priority] ?? "neutral"}>{m.priority}</Tag>
                      {m.requires_response ? <Tag tone="accent">needs reply</Tag> : null}
                      <span className="ml-auto font-mono text-[11px] text-fg-dim">{timeAgo(m.created_at, { now })}</span>
                    </div>
                    {m.subject ? <div className="text-fg">{m.subject}</div> : null}
                    {parent ? (
                      <div className="text-[12px] text-fg-dim">In reply to: {parent.subject || parent.body.slice(0, 80)}</div>
                    ) : null}
                    {/* One line until opened, then the whole note, in place. */}
                    <details className="group">
                      <summary className="flex cursor-pointer list-none items-start gap-1.5 text-[13px] text-fg-muted hover:text-fg [&::-webkit-details-marker]:hidden">
                        <ChevronRight aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
                        <span className="min-w-0 break-words line-clamp-1 group-open:line-clamp-none group-open:whitespace-pre-wrap group-open:text-fg">{m.body}</span>
                      </summary>
                    </details>
                    <div className="flex flex-wrap items-center gap-3">
                      <span className={`inline-flex items-center gap-1.5 text-[12px] ${TONE_TEXT[state.tone]}`}>
                        <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
                        {state.text}
                      </span>
                      {open ? <DismissNote id={m.id} /> : null}
                    </div>
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
