/**
 * components/tools/ToolsSection.tsx - the Tools section for one workspace: the
 * server reads which tools it can use (lib/tools/catalog.ts) and hands them to
 * the client grid. A server component, so a page mounts it in one line:
 *
 *   <ToolsSection tenantId={founder.tenantId} showCodes />
 *
 * It keeps its own space below it (mb-8), so whatever the page puts next (the
 * Content Tools page's whiteboard) does not touch it.
 *
 * The caller has already passed its own gate (the Content > Tools page:
 * resolveFounder); the tools routes check lib/tools/access.ts again on every
 * request. A catalog that could not be read says so; it is never shown as
 * "not set up" or as an empty grid.
 */
import { ToolGrid } from "@/components/tools/ToolGrid";
import { getToolCatalog } from "@/lib/tools/catalog";
import type { ToolCatalog } from "@/lib/tools/types";

export async function ToolsSection({
  tenantId,
  assetHrefPrefix = "/founders/marketing/asset/",
  showCodes = false,
  className = "mb-8",
}: {
  tenantId: string;
  assetHrefPrefix?: string;
  showCodes?: boolean;
  className?: string;
}) {
  let catalog: ToolCatalog | null = null;
  try {
    catalog = await getToolCatalog({ tenantId });
  } catch (err) {
    console.error("[tools.section] could not read the tools", { tenantId, error: err instanceof Error ? err.message : String(err) });
  }
  if (!catalog) {
    return (
      <section aria-labelledby="tools-heading" className={`space-y-3 ${className}`.trim()}>
        <h2 id="tools-heading" className="px-1 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
          Tools
        </h2>
        <p className="px-1 text-sm text-fg-muted">Couldn&apos;t check the tools right now. Try again in a minute.</p>
      </section>
    );
  }
  return <ToolGrid catalog={catalog} assetHrefPrefix={assetHrefPrefix} showCodes={showCodes} className={className} />;
}
