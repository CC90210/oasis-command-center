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

import { notFound } from "next/navigation";
import { PageFrame } from "@/components/os/PageFrame";
import { resolveFounder } from "@/lib/founders/gate";
import { requireOperator } from "@/lib/role-surfaces-session";
import { ToolsSection } from "@/components/tools/ToolsSection";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agent training · Admin" };

export default async function AgentTrainingPage() {
  await requireOperator();
  const founder = await resolveFounder();
  if (!founder) notFound();

  return (
    <PageFrame
      title="Agent training"
      subtitle="Operators only can run this here. What it learns joins the workspace's Training material, which the Content team can also see on Training."
    >
      <ToolsSection tenantId={founder.tenantId} audience="operator" className="" />
    </PageFrame>
  );
}
