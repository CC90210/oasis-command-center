import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Sparkles } from "lucide-react";
import { Card, PageHeader, Tag } from "@/components/Card";
import { ManifestTable } from "@/components/manifest/ManifestTable";
import { ManifestKanban } from "@/components/manifest/ManifestKanban";
import { ManifestMarkdown } from "@/components/manifest/ManifestMarkdown";
import { ManifestDashboard } from "@/components/manifest/ManifestDashboard";
import { TenantLeadDrawerMount } from "@/components/leads/TenantLeadDrawerMount";
import { BoardLiveRefresh } from "@/components/leads/BoardLiveRefresh";
import { parseTenantDrawerIds } from "@/lib/tenant-drawer-params";
import { getManifest, manifestExists } from "@/lib/manifest/loader";
import { resolveDataTenant } from "@/lib/manifest/tenant-scope";
import { resolveAssignedScope, leadScopingEnabled, isAdminProfile } from "@/lib/lead-scope";
import { CATEGORY_LABELS } from "@/lib/agents/library";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { requireTenantPreviewAccess } from "@/lib/tenant-access";

export const dynamic = "force-dynamic";

/**
 * Tenant root at `/t/<slug>/`.
 *
 * Phase 5: if the manifest declares a page at path "" or "/", we render
 * THAT page via the same primitive dispatcher the catch-all uses — so
 * a tenant can have "Dashboard" as their home view. If no root page is
 * declared, falls back to the generic manifest-summary card.
 */
export default async function TenantLandingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ lead?: string; application?: string }>;
}) {
  const { slug } = await params;
  const sp = (await searchParams) || {};
  const normalised = slug.toLowerCase();
  if (!(await manifestExists(normalised))) notFound();

  // Tenant-preview gate: only the empire operator or someone whose tenant
  // matches the slug may render this shell. Without it, /t/sun was
  // hijacking the OASIS operator into the SunBiz Command Center on login.
  await requireTenantPreviewAccess(normalised);

  // SunBiz lead-drawer triggers — the SAME ?lead=/?application= mechanism the
  // catch-all (/t/[slug]/[...path]) uses. Without this, the bare tenant root
  // (where the dashboard renders) ignored ?lead= entirely, so the dashboard's
  // "most urgent leads" rows — which link to /t/<slug>?lead=<id> — were dead
  // clicks. Parse + gate are shared so both surfaces stay consistent.
  const { drawerLeadId, drawerAppId } = parseTenantDrawerIds(sp);

  const manifest = await getManifest(normalised);
  const rootPage =
    manifest.pages?.find((p) => p.path === "" || p.path === "/") ||
    null;

  if (rootPage) {
    return (
      <RootPageRenderer
        slug={normalised}
        page={rootPage}
        manifest={manifest}
        drawerLeadId={drawerLeadId}
        drawerAppId={drawerAppId}
      />
    );
  }

  return <GenericSummary slug={normalised} manifest={manifest} />;
}

async function RootPageRenderer({
  slug,
  page,
  manifest,
  drawerLeadId,
  drawerAppId,
}: {
  slug: string;
  page: NonNullable<Awaited<ReturnType<typeof getManifest>>["pages"]>[number];
  manifest: Awaited<ReturnType<typeof getManifest>>;
  drawerLeadId: string | null;
  drawerAppId: string | null;
}) {
  const user = await getSessionUser();
  const service = getServiceSupabase();
  const profileRes = user
    ? await service
        .from("user_profiles")
        .select("tenant_id, team_role, is_owner")
        .eq("auth_user_id", user.id)
        .maybeSingle()
    : { data: null };
  const profile = profileRes.data as
    | { tenant_id: string | null; team_role: string | null; is_owner: boolean | null }
    | null;
  const userTenantId = profile?.tenant_id ?? null;
  const dataTenantId = await resolveDataTenant(slug, userTenantId);
  const isPreview = !!userTenantId && dataTenantId === null;

  // Per-agent scope for the dashboard board (Adon Batch 2 / 2026-06-22): admins
  // (owner / Jordan / Matt) see all; agents see their own + collaborated. Same
  // resolution as the catch-all pipeline page, threaded into the scoped surfaces.
  const viewer = {
    isAdmin: isAdminProfile(profile),
    userId: user?.id ?? null,
  };
  const assignedScope = resolveAssignedScope(viewer, {}, leadScopingEnabled());

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title={page.label || manifest.brand.name}
        subtitle={manifest.brand.subtitle}
        action={isPreview ? <Tag tone="warm">preview</Tag> : null}
      />
      {isPreview && (
        <div className="rounded-2xl border border-amber-300/25 bg-amber-300/10 p-4 text-sm leading-relaxed text-amber-100">
          Preview mode — your tenant doesn&apos;t own this slug, so no live records render here.
          The manifest structure, navigation, and entity schemas are exactly what a real{" "}
          <span className="font-mono">/t/{slug}</span> tenant would see.
        </div>
      )}
      {page.kind === "markdown" && <ManifestMarkdown page={page} />}
      {page.kind === "dashboard" && (
        <ManifestDashboard manifest={manifest} tenantId={dataTenantId} assignedScope={assignedScope} />
      )}
      {(page.kind === "table" || page.kind === "form") && (() => {
        const entity = (manifest.data_model || []).find((e) => e.name === page.entity);
        if (!entity) return <UnknownEntity name={page.entity} />;
        return <ManifestTable tenantSlug={slug} tenantId={dataTenantId} entity={entity} page={page} canCreate assignedScope={assignedScope} />;
      })()}
      {page.kind === "kanban" && (() => {
        const entity = (manifest.data_model || []).find((e) => e.name === page.entity);
        if (!entity) return <UnknownEntity name={page.entity} />;
        return <ManifestKanban tenantSlug={slug} tenantId={dataTenantId} entity={entity} page={page} assignedScope={assignedScope} />;
      })()}

      {/* Lead/application detail drawer over the dashboard — same gated mount
          the catch-all route uses, so the dashboard's "most urgent leads" rows
          open the existing right-side drawer instead of dead-ending. */}
      <TenantLeadDrawerMount
        slug={slug}
        isPreview={isPreview}
        drawerLeadId={drawerLeadId}
        drawerAppId={drawerAppId}
      />
      {/* Live board refresh — reassignment / collaborator changes nudge this
          rep's dashboard to re-render within seconds (no manual reload). */}
      {!isPreview && <BoardLiveRefresh userId={viewer.userId} />}
    </div>
  );
}

function UnknownEntity({ name }: { name?: string }) {
  return (
    <div className="rounded-2xl border border-amber-300/25 bg-amber-300/10 p-5 text-sm text-amber-100 leading-relaxed">
      This page references an entity <span className="font-mono text-fg">{name || "(none)"}</span> that
      isn&apos;t defined in the manifest&apos;s <code>data_model</code>.
    </div>
  );
}

function GenericSummary({
  slug,
  manifest,
}: {
  slug: string;
  manifest: Awaited<ReturnType<typeof getManifest>>;
}) {
  const enabledAgents = manifest.agents.filter((a) => a.enabled);
  const navGroups = Array.from(new Set(manifest.nav.map((n) => n.group)));

  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        title={manifest.brand.name}
        subtitle={manifest.brand.subtitle}
        action={<Tag tone="accent">manifest v{manifest.version}</Tag>}
      />

      <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
        <Card title="Agents" subtitle={`${enabledAgents.length} enabled`}>
          <div className="space-y-2.5">
            {enabledAgents.map((agent) => (
              <div key={agent.slug} className="flex items-center justify-between text-sm">
                <span className="font-medium text-fg">{agent.display_name}</span>
                <span className="text-xs uppercase tracking-wider text-fg-dim">
                  {agent.primary ? "primary" : "enabled"}
                </span>
              </div>
            ))}
            {enabledAgents.length === 0 && (
              <div className="text-sm text-fg-muted">No agents enabled in this manifest yet.</div>
            )}
          </div>
        </Card>

        <Card title="Navigation" subtitle={`${manifest.nav.length} items across ${navGroups.length} groups`}>
          <div className="space-y-1.5">
            {navGroups.map((group) => {
              const items = manifest.nav.filter((n) => n.group === group);
              return (
                <div key={group} className="text-sm">
                  <span className="text-xs uppercase tracking-wider text-fg-dim font-semibold">{group}</span>
                  <span className="ml-2 text-fg-muted">{items.map((i) => i.label).join(", ")}</span>
                </div>
              );
            })}
          </div>
        </Card>

        <Card title="Industry" subtitle={manifest.onboarding_industry || "custom"}>
          <div className="text-sm text-fg-muted leading-relaxed">
            Backed by <span className="font-mono text-fg">{manifest.data_backend || "supabase"}</span> in{" "}
            <span className="font-mono text-fg">{manifest.deployment_mode || "shared"}</span> mode.
            {manifest.permissions && (
              <div className="mt-3 text-xs text-fg-dim">
                Permissions —{" "}
                {[
                  manifest.permissions.local_files && "local files",
                  manifest.permissions.computer_control && "computer control",
                  manifest.permissions.web_access && "web access",
                ]
                  .filter(Boolean)
                  .join(", ") || "none"}
              </div>
            )}
          </div>
        </Card>
      </div>

      <section className="rounded-2xl border border-accent/25 bg-accent/5 p-5">
        <div className="flex items-start gap-3">
          <Sparkles className="mt-1 h-5 w-5 text-accent" />
          <div>
            <div className="font-bold text-fg">No root page defined</div>
            <p className="mt-1 text-sm text-fg-muted leading-relaxed">
              This tenant&apos;s manifest doesn&apos;t declare a page at the root path.
              Open the AI editor and ask it to add a dashboard page at path &quot;/&quot;,
              or browse the existing routes from the sidebar.
            </p>
            <div className="mt-3 flex gap-3">
              <Link
                href={`/t/${slug}/editor`}
                className="inline-flex items-center gap-2 text-sm font-semibold text-accent hover:text-accent/80"
              >
                Open editor <ArrowRight className="h-3.5 w-3.5" />
              </Link>
              <Link
                href={`/t/${slug}/marketplace`}
                className="inline-flex items-center gap-2 text-sm font-semibold text-fg-muted hover:text-fg"
              >
                Marketplace
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// CATEGORY_LABELS is imported above for type-side use, but we don't render
// the agent category label on this page in the new path. Keep the import so
// the markup is consistent with the rest of the manifest pages.
void CATEGORY_LABELS;
