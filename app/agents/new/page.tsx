/**
 * /agents/new - build a custom teammate (AI team > New teammate), inside the
 * OS shell (W1a, U1-04).
 *
 * It was /t/<slug>/marketplace/new, which switched the rail off for the legacy
 * manifest sidebar. That page moves the viewers this page serves here, with
 * the query (lib/os/redirects.ts OS_VIEWER_MOVES). This page reads only the
 * SESSION's workspace: there is no workspace in the URL, so it can never act
 * on another one.
 *
 * GATES, before any read, are the AI team page's own (app/agents/page.tsx):
 * requireSystemSurface, then a provisioned workspace and the rail's "/agents"
 * row (components/os/aiteam/access.ts aiTeamServes, the answer the old page
 * moves on). Building is for owners and admins (persona founder), the rule the
 * roster's New teammate button uses; POST /api/agents refuses anyone else on
 * its own.
 *
 * `?edit=<slug>` edits one of this workspace's own custom teammates (the
 * teammate's Configure panel links here). `?template=<key>` is carried from a
 * template tile; the builder does not read it yet, which the tile says
 * (components/os/aiteam/TemplatePicker.tsx). A save opens the teammate's chat
 * here (/agents/<slug>) and a delete returns to the AI team, never the
 * marketplace (the builder's `home`).
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Card, EmptyState } from "@/components/Card";
import { CustomAgentBuilder } from "@/components/marketplace/CustomAgentBuilder";
import { PageFrame } from "@/components/os/PageFrame";
import { AI_TEAM_HREF, aiTeamServes } from "@/components/os/aiteam/access";
import { workspaceChatSlug } from "@/components/os/department/channel";
import { resolveOsViewer } from "@/components/os/department/viewer";
import { getAgentBySlug } from "@/lib/agents/loader";
import { requireSystemSurface } from "@/lib/role-surfaces-session";

export const dynamic = "force-dynamic";

const TITLE = "New teammate";

function BackToTeam() {
  return (
    <Link href={AI_TEAM_HREF} prefetch={false} className="btn-secondary inline-flex items-center gap-1.5">
      <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
      AI team
    </Link>
  );
}

export default async function NewTeammatePage({
  searchParams,
}: {
  searchParams?: Promise<{ edit?: string | string[] }>;
}) {
  await requireSystemSurface();
  const viewer = await resolveOsViewer();
  if (!viewer.ok) {
    if (viewer.reason === "signed_out") notFound();
    return (
      <PageFrame title={TITLE} subtitle="We could not confirm which workspace you are in.">
        <Card>
          <EmptyState message="Refresh to try again. Nothing was built in the meantime." />
        </Card>
      </PageFrame>
    );
  }
  if (!aiTeamServes(viewer)) notFound();

  if (viewer.surface.persona !== "founder") {
    return (
      <PageFrame title={TITLE} subtitle="Owners and admins add teammates to this workspace." actions={<BackToTeam />}>
        <Card>
          <EmptyState message="Ask an owner or admin of this workspace to add the teammate you need." />
        </Card>
      </PageFrame>
    );
  }

  const tenantId = viewer.surface.tenantId;
  // The slug the builder's own links and the records API accept for THIS
  // workspace (the roster asks the same question before it offers the button).
  const [slug, sp] = await Promise.all([workspaceChatSlug(tenantId), searchParams]);
  if (!slug) {
    return (
      <PageFrame title={TITLE} actions={<BackToTeam />}>
        <Card>
          <EmptyState message="This workspace's agent settings are not set up yet, so a teammate cannot be added." />
        </Card>
      </PageFrame>
    );
  }

  // Editing: only a custom teammate this workspace built, never a platform
  // agent or another workspace's (getAgentBySlug also returns public ones).
  const editParam = sp?.edit;
  const editSlug = (typeof editParam === "string" ? editParam : "").trim().toLowerCase();
  const found = editSlug ? await getAgentBySlug(editSlug, tenantId) : null;
  const editing = found && !found.is_oasis_managed && found.tenant_id === tenantId ? found : null;

  return (
    <PageFrame
      title={editing ? `Edit ${editing.name}` : TITLE}
      subtitle={
        editing
          ? "Update this teammate's definition. How this workspace names it and switches it on is kept separately."
          : "Describe what the teammate should do. The AI drafts its instructions, suggested tools and a model, and you review everything before saving."
      }
      actions={<BackToTeam />}
    >
      <CustomAgentBuilder
        tenantSlug={slug}
        home="ai-team"
        editing={
          editing
            ? {
                slug: editing.slug,
                name: editing.name,
                category: editing.category,
                short_description: editing.short_description,
                description: editing.description || "",
                base_prompt: editing.base_prompt,
                required_tools: editing.required_tools,
                suggested_model: editing.suggested_model || "",
                is_public: editing.is_public,
              }
            : null
        }
      />
    </PageFrame>
  );
}
