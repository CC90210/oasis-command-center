/**
 * /admin/agent-training - Admin > Agent training: "Learn from a link", moved
 * off Content > Content Tools (2026-10-10, Adon). It reads a web page or
 * GitHub repo and writes its hook, pacing and tone into the OASIS
 * workspace's training material (marketing_corpus) - material that shapes
 * how OASIS's own agents write, not a workspace content tool, so STARTING
 * it belongs behind the shield with every other OASIS platform internal.
 *
 * GATE: requireOperator() as the FIRST statement, exactly like every other
 * Admin page (tests prove the convention at app/admin/agents/page.tsx and
 * friends). resolveFounder() under it is not a second access gate - every
 * platform operator is, by construction, an owner/admin of the OASIS tenant
 * (lib/platform-operator.ts) - it only reads the tenantId ToolsSection needs,
 * the same call the Content Tools page makes for the same reason.
 *
 * The tool itself is gated a SECOND time, independently of this page:
 * lib/tools/session-handlers.ts refuses POST /api/tools/run and GET
 * /api/tools/jobs for an operatorOnly tool (lib/tools/registry.ts) to anyone
 * resolvePlatformOperatorForAuthUser does not clear, so a non-operator who
 * calls the API directly (never loading this page at all) is refused there
 * too. tests/tools-worker.test.ts proves both directions.
 *
 * WHAT IS NOT OPERATOR-ONLY (Codex review round 3, MEDIUM + LOW, 2026-10-10):
 * this page and that run-time gate are. The note this tool writes is an
 * ordinary row in the SAME marketing_corpus the Training page already lists
 * (app/founders/marketing/train/page.tsx) and the SAME ingest route already
 * accepts (app/api/founders/marketing/ingest/route.ts) - both gated only by
 * resolveFounder(), which admits every canSeeMarketing persona (founder,
 * marketing, builder), not only operators. So a non-operator OASIS founder
 * (a marketing or builder seat) can already see a learned link's title, URL
 * and label on Training, and can already queue a link into the same corpus
 * there. The subtitle below says only what the code actually does; it does
 * NOT claim the corpus itself is operator-only. Widening the founders-portal
 * gate to match would be a product decision (hide or scope rows written
 * via "toolkit:learn_from_link", or gate Training/ingest for operators),
 * not made here - flagged for Adon, not silently decided.
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

export const dynamic = "force-dynamic";
export const metadata = { title: "Agent training · Admin" };

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
async function LearnedNotesLoader({ tenantId }: { tenantId: string }) {
  const [stats, items] = await Promise.all([
    safely("stats", getCorpusStats(tenantId), { ...EMPTY_CORPUS_STATS, degraded: true }),
    safely("items", getCorpusItems(tenantId, 16), { rows: [], degraded: true }),
  ]);
  return <LearnedNotes stats={stats} items={items} />;
}

export default async function AgentTrainingPage() {
  await requireOperator();
  const founder = await resolveFounder();
  if (!founder) notFound();

  return (
    <PageFrame
      title="Agent training"
      subtitle="Operators only can run this here. What it learns joins the workspace's Training material, which the Content team can also see on Training."
    >
      <div className="space-y-8">
        <ToolsSection tenantId={founder.tenantId} audience="operator" className="" />
        <RefreshOnToolRun />
        <Suspense
          fallback={<p className="rounded-xl border border-bg-border bg-bg-panel p-4 text-sm text-fg-muted">Loading what it has learned…</p>}
        >
          <LearnedNotesLoader tenantId={founder.tenantId} />
        </Suspense>
      </div>
    </PageFrame>
  );
}
