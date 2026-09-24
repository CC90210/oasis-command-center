/**
 * Which book you are looking at. Server component: plain links, so the
 * choice lives in the URL (?entity=) and every page reads it server-side.
 * Only the books the viewer may see are passed in — the other founder's
 * personal book is never listed, not even disabled.
 */

import Link from "next/link";

export function EntitySwitcher({
  entities,
  current,
  basePath,
}: {
  entities: Array<{ slug: string; name: string; kind: string }>;
  current: string;
  basePath: string;
}) {
  return (
    <div className="inline-flex rounded-lg border border-bg-border bg-bg-panel p-0.5" role="tablist" aria-label="Book">
      {entities.map((e) => {
        const active = e.slug === current;
        return (
          <Link
            key={e.slug}
            href={`${basePath}?entity=${e.slug}`}
            role="tab"
            aria-selected={active}
            className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
              active ? "bg-bg-elev text-fg" : "text-fg-muted hover:text-fg"
            }`}
          >
            {e.name}
            {e.kind === "personal" && <span className="ml-1.5 text-[10px] font-normal text-fg-dim">private</span>}
          </Link>
        );
      })}
    </div>
  );
}
