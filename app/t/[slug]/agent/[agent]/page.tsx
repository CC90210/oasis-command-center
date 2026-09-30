import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Settings } from "lucide-react";
import { Card, PageHeader, Tag } from "@/components/Card";
import { AgentChat } from "@/components/agents/AgentChat";
import { getAgentBySlug } from "@/lib/agents/loader";
import { CATEGORY_LABELS } from "@/lib/agents/library";
import { getManifest, manifestExists } from "@/lib/manifest/loader";
import { ownsSlug } from "@/lib/manifest/tenant-scope";
import { resolveSessionContext, type SessionContext } from "@/lib/api-auth";
import { resolvePersona } from "@/lib/role-surfaces";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function TenantAgentChatPage({
  params,
}: {
  params: Promise<{ slug: string; agent: string }>;
}) {
  const { slug, agent } = await params;
  const normalised = slug.toLowerCase();
  if (!(await manifestExists(normalised))) notFound();

  // The viewer's ACTIVE workspace, through the session context the /team pages
  // use: a `.maybeSingle()` over user_profiles errors for anyone seated in two
  // workspaces and read them as having none. A profile read that FAILED throws
  // there; it is not "signed in somewhere else", so say we could not tell.
  let session: SessionContext;
  try {
    session = await resolveSessionContext();
  } catch (err) {
    console.error("[t.agent.session]", err);
    return (
      <div className="space-y-6 animate-fade-in">
        <PageHeader title="Chat unavailable" subtitle="We could not confirm which workspace you are in." />
        <Card>
          <div className="text-sm text-fg-muted leading-relaxed">Refresh to try again.</div>
        </Card>
      </div>
    );
  }
  const tenantId = session.ok ? session.tenantId : null;
  // Owners and admins may open AI settings, so a failure carries the fix link
  // (the same persona rule a department channel uses).
  const canManageAi =
    session.ok &&
    resolvePersona({
      teamRole: session.teamRole,
      isTrueAdmin: session.isTrueAdmin,
      adminAccess: session.adminAccess,
    }) === "founder";
  // /api/agents/chat answers only in a workspace the caller owns (403
  // otherwise), so a chat box over someone else's workspace would fail on
  // its first message. Say so instead of rendering it.
  const owned = await ownsSlug(normalised, tenantId);

  const agentDef = await getAgentBySlug(agent, tenantId);
  if (!agentDef) notFound();
  if (!agentDef.is_public && agentDef.tenant_id !== tenantId) notFound();

  const manifest = await getManifest(normalised);
  const binding = manifest.agents.find((a) => a.slug === agentDef.slug);
  const displayName = binding?.display_name || agentDef.name;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title={displayName}
        subtitle={CATEGORY_LABELS[agentDef.category]}
        action={
          <div className="flex items-center gap-2">
            {binding?.enabled ? (
              binding.primary ? (
                <Tag tone="engaged">primary</Tag>
              ) : (
                <Tag tone="engaged">enabled</Tag>
              )
            ) : (
              <Tag tone="warm">not subscribed</Tag>
            )}
            <Link
              href={`/t/${normalised}/marketplace/${agentDef.slug}`}
              className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs"
            >
              <Settings className="h-3.5 w-3.5" />
              Configure
            </Link>
            <Link
              href={`/t/${normalised}`}
              className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Tenant
            </Link>
          </div>
        }
      />

      {owned && !binding?.enabled && (
        <Card>
          <div className="text-sm text-fg-muted leading-relaxed">
            This agent isn&apos;t enabled on {manifest.brand.name} yet. You can chat with it right
            now to see how it sounds — but for it to show in the sidebar and remember preferences,{" "}
            <Link
              href={`/t/${normalised}/marketplace/${agentDef.slug}`}
              className="text-accent hover:underline"
            >
              enable it in the marketplace
            </Link>
            .
          </div>
        </Card>
      )}

      {owned ? (
        <AgentChat
          tenantSlug={normalised}
          agentSlug={agentDef.slug}
          agentName={displayName}
          agentSubtitle={CATEGORY_LABELS[agentDef.category]}
          greeting={agentDef.short_description}
          canManageAi={canManageAi}
        />
      ) : (
        <Card>
          <div className="text-sm text-fg-muted leading-relaxed">This chat belongs to another workspace.</div>
        </Card>
      )}
    </div>
  );
}
