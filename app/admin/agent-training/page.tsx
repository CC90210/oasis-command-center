/**
 * /admin/agent-training - Admin > Agent training: "Learn from a link", moved
 * off Content > Content Tools (2026-10-10, Adon). It reads a web page or
 * GitHub repo and writes its hook, pacing and tone into the agent-harness
 * training corpus (marketing_corpus) - material that shapes how OASIS's own
 * agents write, not a workspace content tool, so it belongs behind the
 * shield with every other OASIS platform internal, not on a page a client
 * workspace's own founders could one day reach.
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
      subtitle="Agent-harness training material. Operators only; clients and other founders never see this page or its results."
    >
      <ToolsSection tenantId={founder.tenantId} audience="operator" className="" />
    </PageFrame>
  );
}
