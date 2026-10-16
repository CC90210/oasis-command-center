/**
 * /admin/agent-training - Admin > Agent training: teach one agent at a time from a link.
 *
 * "Learn from a link" (moved off Content > Content Tools, 2026-10-10, Adon) reads a web page or GitHub
 * repo and writes its hook, pacing and tone as a training note (a marketing_corpus row). Since
 * 2026-10-15 every note says WHICH agent it trains (lib/training/trains.ts), and that agent reads its
 * newest notes before it answers (lib/os/training-notes.ts, from lib/os/department-agent.ts). CC: "we
 * need to specify which agent is getting trained. Right now it's just general."
 *
 * ONE AGENT AT A TIME. The tabs across the top pick the agent (`?agent=sales`): the Learn form starts on
 * that agent ("Which agent learns this?", always sent, so the choice is never lost), and the list shows
 * what that agent reads. "All agents" lists every note and starts the form on "All agents".
 *
 * GATE: requireOperator() as the FIRST statement, exactly like every other Admin page (tests prove the
 * convention at app/admin/agents/page.tsx and friends). resolveFounder() under it is not a second access
 * gate - every platform operator is, by construction, an owner/admin of the OASIS tenant
 * (lib/platform-operator.ts) - it only reads the tenantId ToolsSection needs.
 *
 * The tool itself is gated a SECOND time, independently of this page: lib/tools/session-handlers.ts
 * refuses POST /api/tools/run and GET /api/tools/jobs for an operatorOnly tool (lib/tools/registry.ts)
 * to anyone resolvePlatformOperatorForAuthUser does not clear. tests/tools-worker.test.ts proves both.
 *
 * WHAT IS NOT OPERATOR-ONLY (Codex review round 3, MEDIUM + LOW, 2026-10-10): this page and that run-time
 * gate are. The note this tool writes is an ordinary row in the SAME marketing_corpus the Training page
 * already lists (app/founders/marketing/train/page.tsx) and the SAME ingest route already accepts, both
 * gated only by resolveFounder(). The subtitle below says only what the code actually does.
 */

import { Suspense } from "react";
import { notFound } from "next/navigation";
import { PageFrame } from "@/components/os/PageFrame";
import { resolveFounder } from "@/lib/founders/gate";
import { requireOperator } from "@/lib/role-surfaces-session";
import { ToolsSection } from "@/components/tools/ToolsSection";
import { LearnedNotes } from "@/components/tools/LearnedNotes";
import { RefreshOnToolRun } from "@/components/tools/RefreshOnToolRun";
import {
  EMPTY_CORPUS_STATS,
  getCorpusItems,
  getCorpusStats,
} from "@/lib/founders/marketing-queries";
import { TRAINS_ALL, TRAINS_VALUES, isTrains, trainsLabel } from "@/lib/training/trains";
import { trainingRowsFor } from "@/lib/os/training-notes";
import type { DepartmentKey } from "@/lib/os/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agent training · Admin" };

/** How many of the newest notes the page reads, so each agent's tab can list its own. */
const ITEMS_READ = 200;

/**
 * The reads never throw (marketing-queries.ts), but a rejected promise must not
 * take the whole page down with it: a failed read becomes `degraded`, which the
 * list says plainly instead of "nothing learned yet".
 */
async function safely<T>(label: string, read: Promise<T>, fallback: T): Promise<T> {
  try {
    return await read;
  } catch (err) {
    console.error(`[agent-training.${label}]`, err);
    return fallback;
  }
}

/**
 * The history reads sit in their own async child behind Suspense: awaited in the page
 * body they would hold back the Learn control (the page's reason to exist) for as
 * long as the slowest corpus query takes (Codex review of #612).
 */
async function LearnedNotesLoader({ tenantId, agent }: { tenantId: string; agent: DepartmentKey | null }) {
  const [stats, agentItems] = await Promise.all([
    safely("stats", getCorpusStats(tenantId), { ...EMPTY_CORPUS_STATS, degraded: true }),
    // One agent's tab: filtered in the database by the rule the agent's own read uses (null off Turso).
    agent ? safely("agent_items", trainingRowsFor(tenantId, agent), { rows: [], degraded: true }) : Promise.resolve(null),
  ]);
  const items = agentItems ?? (await safely("items", getCorpusItems(tenantId, ITEMS_READ), { rows: [], degraded: true }));
  return <LearnedNotes stats={stats} items={items} agent={agent} />;
}

const TAB = "inline-flex min-h-11 items-center rounded-md border px-3 text-sm motion-safe:transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** One tab per agent, "All agents" first. A plain link each: the page (force-dynamic) is the state. */
function AgentTabs({ current }: { current: DepartmentKey | null }) {
  return (
    <nav aria-label="Which agent to train" className="space-y-2">
      <p className="text-sm font-medium text-fg">Which agent are you training?</p>
      <ul className="flex flex-wrap gap-2">
        {TRAINS_VALUES.map((value) => {
          const active = value === TRAINS_ALL ? current === null : value === current;
          const href = value === TRAINS_ALL ? "/admin/agent-training" : `/admin/agent-training?agent=${value}`;
          return (
            <li key={value}>
              <a
                href={href}
                aria-current={active ? "page" : undefined}
                className={`${TAB} ${active ? "border-accent bg-accent-soft font-medium text-fg" : "border-hairline bg-bg-deep text-fg-muted hover:border-bg-border-strong"}`}
              >
                {trainsLabel(value)}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default async function AgentTrainingPage({ searchParams }: { searchParams?: Promise<{ agent?: string | string[] }> }) {
  await requireOperator();
  const founder = await resolveFounder();
  if (!founder) notFound();
  const raw = (await searchParams)?.agent;
  const agent: DepartmentKey | null = typeof raw === "string" && isTrains(raw) && raw !== TRAINS_ALL ? raw : null;

  return (
    <PageFrame
      title="Agent training"
      subtitle="Pick an agent, then teach it from a link: it reads its newest notes before it answers. Operators only can run this here. The notes join the workspace's Training material, which the Content team can also see on Training."
    >
      <div className="space-y-8">
        <AgentTabs current={agent} />
        {/* Keyed on the agent so the form starts again on that agent when the tab changes. */}
        <ToolsSection
          key={agent ?? TRAINS_ALL}
          tenantId={founder.tenantId}
          audience="operator"
          className=""
          fieldDefaults={{ learn_from_link: { trains: agent ?? TRAINS_ALL } }}
        />
        <RefreshOnToolRun />
        <Suspense
          fallback={<p className="rounded-xl border border-bg-border bg-bg-panel p-4 text-sm text-fg-muted">Loading what it has learned…</p>}
        >
          <LearnedNotesLoader tenantId={founder.tenantId} agent={agent} />
        </Suspense>
      </div>
    </PageFrame>
  );
}
