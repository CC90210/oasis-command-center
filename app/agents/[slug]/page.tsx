/**
 * /agents/<slug> - chat with one of this workspace's custom teammates, inside
 * the OS shell (W1a, U1-04).
 *
 * It was /t/<slug>/agent/<agent>, which switched the rail off for the legacy
 * manifest sidebar. That page moves the viewers this page serves here, for a
 * custom teammate (lib/os/redirects.ts OS_VIEWER_MOVES).
 *
 * This page reads only the SESSION's workspace. It serves a teammate only when
 * this workspace built it, the roster's "custom teammates"
 * (components/os/aiteam/roster.ts): a platform agent, another workspace's
 * agent and an unknown slug are all the same 404, so a slug confirms nothing.
 * Department leads have their own channel at /team/<dept>.
 *
 * GATES, before any read, are the AI team page's own (app/agents/page.tsx):
 * requireSystemSurface, then a provisioned workspace and the rail's "/agents"
 * row (components/os/aiteam/access.ts aiTeamServes).
 *
 * The chat posts no workspace slug: /api/agents/chat takes the workspace from
 * the session, as a department channel does.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Settings } from "lucide-react";
import { Card, EmptyState } from "@/components/Card";
import { AgentChat } from "@/components/agents/AgentChat";
import { PageFrame } from "@/components/os/PageFrame";
import { AI_TEAM_HREF, aiTeamServes } from "@/components/os/aiteam/access";
import { workspaceChatSlug } from "@/components/os/department/channel";
import { resolveOsViewer } from "@/components/os/department/viewer";
import { CATEGORY_LABELS } from "@/lib/agents/library";
import { getAgentBySlug } from "@/lib/agents/loader";
import { requireSystemSurface } from "@/lib/role-surfaces-session";

export const dynamic = "force-dynamic";

export default async function TeammateChatPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await requireSystemSurface();
  const viewer = await resolveOsViewer();
  if (!viewer.ok) {
    if (viewer.reason === "signed_out") notFound();
    return (
      <PageFrame title="AI teammate" subtitle="We could not confirm which workspace you are in.">
        <Card>
          <EmptyState message="Refresh to try again. No teammate was guessed in the meantime." />
        </Card>
      </PageFrame>
    );
  }
  if (!aiTeamServes(viewer)) notFound();

  const tenantId = viewer.surface.tenantId;
  const [agent, chatSlug] = await Promise.all([
    getAgentBySlug(slug.trim().toLowerCase(), tenantId),
    workspaceChatSlug(tenantId),
  ]);
  if (!agent || agent.is_oasis_managed || agent.tenant_id !== tenantId) notFound();

  // This workspace's own manifest says what it calls the teammate and whether
  // it is switched on (the roster's On / Off).
  const binding = (viewer.manifest.agents ?? []).find((a) => a.slug.toLowerCase() === agent.slug.toLowerCase());
  const name = binding?.display_name || agent.name;
  const subtitle = CATEGORY_LABELS[agent.category] ?? "Custom";
  const owner = viewer.surface.persona === "founder";

  const actions = (
    <>
      {chatSlug && (
        <Link
          href={`/t/${chatSlug}/marketplace/${encodeURIComponent(agent.slug)}`}
          prefetch={false}
          className="btn-secondary inline-flex items-center gap-1.5"
        >
          <Settings className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
          Configure
        </Link>
      )}
      <Link href={AI_TEAM_HREF} prefetch={false} className="btn-secondary inline-flex items-center gap-1.5">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
        AI team
      </Link>
    </>
  );

  return (
    <PageFrame title={name} subtitle={subtitle} actions={actions} className="space-y-4">
      {!chatSlug ? (
        <Card>
          <EmptyState message="This workspace's agent settings are not set up yet, so this teammate cannot answer." />
        </Card>
      ) : (
        <>
          {!binding?.enabled && (
            <Card>
              <p className="text-sm leading-[1.55] text-fg-muted">
                {name} is off in this workspace. You can still chat with it to see how it answers;{" "}
                {owner ? "turn it on from Configure." : "an owner or admin can turn it on."}
              </p>
            </Card>
          )}
          <AgentChat
            agentSlug={agent.slug}
            agentName={name}
            agentSubtitle={subtitle}
            greeting={agent.short_description}
            canManageAi={owner}
          />
        </>
      )}
    </PageFrame>
  );
}
