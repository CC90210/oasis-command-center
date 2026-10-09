import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader, Tag } from "@/components/Card";
import { ManifestEditorChat } from "@/components/manifest/ManifestEditorChat";
import { getManifest, manifestExists } from "@/lib/manifest/loader";
import { getManifestRow } from "@/lib/manifest/persistence";
import { requireOwnedTenantSlug } from "@/lib/tenant-access";
import { viewerReadsInternalAgentNames } from "@/lib/os/agent-names-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Manifest editor page — `/t/<slug>/editor`.
 *
 * Auth + admin authorisation are enforced by the underlying API routes
 * (`/api/manifest/chat` and `/api/manifest/<slug>`); a non-admin sitting on
 * this page can read the manifest snapshot but every write attempt comes
 * back 403. The page itself is auth-gated by middleware.
 */
export default async function ManifestEditorPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const normalised = slug.toLowerCase();
  if (!(await manifestExists(normalised))) notFound();
  // The whole manifest goes to the browser below, so only this workspace's
  // own members or a verified operator may open it; anyone else 404s.
  await requireOwnedTenantSlug(normalised);

  const manifest = await getManifest(normalised);
  const row = await getManifestRow(normalised).catch(() => null);
  const version = row?.version ?? 0;
  // How the editor names this workspace's agents (lib/os/agent-names.ts).
  const internalNames = await viewerReadsInternalAgentNames();

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Manifest Editor"
        subtitle={`Talk to your editor agent to shape ${manifest.brand.name}. Changes preview before they persist.`}
        action={
          <div className="flex items-center gap-2">
            <Tag tone="accent">v{version}</Tag>
            <Link
              href={`/t/${normalised}`}
              className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to tenant
            </Link>
          </div>
        }
      />

      <ManifestEditorChat
        slug={normalised}
        initialManifest={manifest}
        initialVersion={version}
        internalNames={internalNames}
      />
    </div>
  );
}
