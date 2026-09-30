import { Card, PageHeader } from "@/components/Card";
import { AgentInboxList, AgentInboxComposer } from "@/components/AgentInboxList";
import { listUnreadDb, listReadDb, dbToUiShape } from "@/lib/agent-inbox-db";
import { getActiveProfile } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { requireOperator } from "@/lib/role-surfaces-session";

export const dynamic = "force-dynamic";

/**
 * /inbox — the agents' notes to each other, read from the Turso agent inbox
 * only (2026-09-30). It also read the local agent-inbox folder through
 * lib/agent-inbox-fs, which does not exist on the Cloudflare Worker, so that
 * half always came back empty. The module stays for the local tools that still
 * use it; this page no longer imports it.
 */
export default async function InboxPage() {
  // Operator-only (P0-5), before any query. This page used an email match to
  // decide only whether to SHOW the composer, while the agent-to-agent log
  // itself was fetched and rendered for any signed-in member.
  await requireOperator();
  const profile = await safe("inbox.profile", getActiveProfile(), null);
  const tenantId = profile?.tenant_id || "";

  // null = the read failed: "Couldn't check", never "no new messages".
  const [unreadRows, readRows] = await Promise.all([
    tenantId ? safe("inbox.db_unread", listUnreadDb(tenantId), null) : Promise.resolve(null),
    tenantId ? safe("inbox.db_read", listReadDb(tenantId, undefined, 50), null) : Promise.resolve(null),
  ]);
  const unread = unreadRows?.map(dbToUiShape) ?? null;
  const read = readRows?.map(dbToUiShape).slice(0, 50) ?? null;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Agent Inbox"
        subtitle="Notes the agents leave each other. You rarely need this page; the chat reads it for you."
      />

      <Card title="What this is">
        <div className="space-y-4 text-sm text-fg-muted leading-relaxed">
          <p>
            <span className="text-fg font-medium">You don&apos;t use the inbox directly. The agents do.</span>{" "}
            When an agent finishes something another agent should pick up, it
            leaves a note here. The next time the recipient runs, it reads its
            unread notes before anything else. This page is the record of those
            handoffs.
          </p>
          <p className="text-fg-dim">
            <span className="text-fg font-medium">When to look here:</span>{" "}
            you want the record of what the agents passed to each other, you want
            to leave an agent a non-urgent note for its next run (the box below),
            or something feels off and you want to see what an agent was told.
          </p>
        </div>
      </Card>

      <Card title="What happens when you post">
        <div className="space-y-3 text-sm text-fg-muted leading-relaxed">
          <ol className="list-decimal pl-5 space-y-2">
            <li>
              Your note is saved to the agent inbox in the Command Center&apos;s
              database (Turso), so every machine sees it.
            </li>
            <li>
              The next time the recipient answers in a chat or starts a session on
              your computer, the note is put in front of it, and it deals with it
              before whatever else you asked.
            </li>
            <li>
              Once handled, the note is marked read here. An agent that replies
              leaves its answer in your inbox.
            </li>
          </ol>
          <p className="text-fg-dim">
            <span className="text-fg font-medium">Not real-time.</span> Posting
            here interrupts nothing; it waits for the recipient&apos;s next run.
            For something you need now, ask in the Coding harness.
          </p>
        </div>
      </Card>

      <Card
        title="Messages"
        subtitle={
          unread === null || read === null
            ? "Couldn't check the inbox just now."
            : unread.length > 0
              ? `${unread.length} unread · ${read.length} archived`
              : `${read.length} archived · no new messages`
        }
      >
        {unread === null || read === null ? (
          <p className="text-sm text-fg-muted">
            Couldn&apos;t check the agent inbox just now. The read failed and has been logged; this does not mean there are no messages. Reload to try again.
          </p>
        ) : (
          <AgentInboxList unread={unread} read={read} />
        )}
      </Card>
      {/* Every viewer who reaches this line passed requireOperator above. */}
      <details className="rounded-lg border border-bg-border bg-bg-elev/40">
        <summary className="cursor-pointer px-5 py-4 text-sm font-bold uppercase tracking-[0.14em] text-fg-muted hover:text-fg">
          Post a message (admin · expand)
        </summary>
        <div className="px-5 pb-5">
          <p className="text-xs text-fg-dim mb-3">
            You usually don&apos;t need this — ask in the Coding harness
            instead. Use this only for a non-urgent note that should wait until
            the next time that agent runs.
          </p>
          <AgentInboxComposer />
        </div>
      </details>
    </div>
  );
}
