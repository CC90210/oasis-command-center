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
 * resolveFounder; Admin > Agent training: requireOperator) - the tools routes
 * check lib/tools/access.ts again on every request, and an operatorOnly tool
 * (lib/tools/registry.ts) is refused a second time, independently, in
 * lib/tools/session-handlers.ts. A catalog that could not be read says so; it
 * is never shown as "not set up" or as an empty grid.
 *
 * `fieldDefaults` starts a field on a value the page knows (Admin > Agent training starts "Which agent
 * learns this?" on the agent being looked at); a value a select does not offer is ignored.
 *
 * `audience` picks which tools getToolCatalog hands the grid: "client"
 * (default) is every tool except an operatorOnly one, "operator" is only the
 * operatorOnly ones (Admin > Agent training). `showHeading=false` drops the
 * grid's own "Tools" heading for a caller that already supplies one, such as
 * the Content Tools page's collapsible disclosure around this section.
 */
import { ToolGrid } from "@/components/tools/ToolGrid";
import { getToolCatalog, type CatalogOptions } from "@/lib/tools/catalog";
import type { ToolCatalog } from "@/lib/tools/types";

export async function ToolsSection({
  tenantId,
  assetHrefPrefix = "/founders/marketing/asset/",
  showCodes = false,
  className = "mb-8",
  audience = "client",
  showHeading = true,
  fieldDefaults,
}: {
  tenantId: string;
  assetHrefPrefix?: string;
  showCodes?: boolean;
  className?: string;
  audience?: CatalogOptions["audience"];
  showHeading?: boolean;
  /** Tool key -> field name -> the value that field starts on. */
  fieldDefaults?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}) {
  let catalog: ToolCatalog | null = null;
  try {
    catalog = await getToolCatalog({ tenantId }, {}, { audience });
  } catch (err) {
    console.error("[tools.section] could not read the tools", { tenantId, error: err instanceof Error ? err.message : String(err) });
  }
  if (!catalog) {
    return (
      <section aria-labelledby={showHeading ? "tools-heading" : undefined} aria-label={showHeading ? undefined : "Tools"} className={`space-y-3 ${className}`.trim()}>
        {showHeading && (
          <h2 id="tools-heading" className="px-1 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
            Tools
          </h2>
        )}
        <p className="px-1 text-sm text-fg-muted">Couldn&apos;t check the tools right now. Try again in a minute.</p>
      </section>
    );
  }
  return <ToolGrid catalog={withFieldDefaults(catalog, fieldDefaults)} assetHrefPrefix={assetHrefPrefix} showCodes={showCodes} className={className} showHeading={showHeading} />;
}

/** The catalog with some fields starting on a value the page chose. A value a select does not offer is ignored. */
export function withFieldDefaults(catalog: ToolCatalog, defaults: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined): ToolCatalog {
  if (!defaults || !catalog.installed) return catalog;
  return {
    ...catalog,
    tools: catalog.tools.map((tool) => {
      const own = defaults[tool.key];
      if (!own) return tool;
      return {
        ...tool,
        fields: tool.fields.map((f) => {
          const value = own[f.name];
          if (value === undefined) return f;
          if (f.kind === "select" && !(f.options ?? []).some((o) => o.value === value)) return f;
          return { ...f, defaultValue: value };
        }),
      };
    }),
  };
}
