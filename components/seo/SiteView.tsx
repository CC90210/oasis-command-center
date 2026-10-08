import Link from "next/link";
import type { Loaded } from "@/lib/seo/client";
import { SEO_RANGES, type SeoRange, type SiteSummary, type TopRows } from "@/lib/seo/types";
import { RANGE_LABEL } from "@/lib/seo/format";
import { StatusBadge, UnavailableBanner } from "./Bits";
import { SiteKpis } from "./SiteKpis";
import { TopTable } from "./TopTable";
import { FreshnessPanel } from "./FreshnessPanel";
import { TrendChart } from "./TrendChart";

export type SiteData = { summary: SiteSummary; queries: TopRows; pages: TopRows };

/**
 * The date-range tabs. Rendered as PageFrame's `actions` by app/seo/[site]/page.tsx
 * (PageFrame ruling, Adon 2026-10-07) — SiteView itself no longer draws a header.
 */
export function RangeTabs({ siteId, range, base = "/seo" }: { siteId: string; range: SeoRange; base?: string }) {
  return (
    <nav aria-label="Date range" className="flex gap-1">
      {SEO_RANGES.map((r) => (
        <Link
          key={r} prefetch={false} href={`${base}/${siteId}?range=${r}`} aria-current={r === range ? "page" : undefined}
          className={`rounded-md px-2.5 py-1 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${r === range ? "bg-bg-elev text-fg" : "text-fg-muted hover:text-fg"}`}
        >
          {RANGE_LABEL[r]}
        </Link>
      ))}
    </nav>
  );
}

function siteOf(loaded: Loaded<SiteData>): SiteSummary | null {
  return loaded.state === "ok" ? loaded.data.summary : null;
}

/**
 * The page title's contents (name + status + test marker), without the <h1> itself.
 * app/seo/[site]/page.tsx passes this as PageFrame's `title` prop.
 */
export function SiteTitle({ loaded, siteId }: { loaded: Loaded<SiteData>; siteId: string }) {
  const s = siteOf(loaded);
  const name = s?.site.domain ?? s?.site.display_name ?? siteId;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <span className="truncate">{name}</span>
      {s && <StatusBadge status={s.site.status} />}
      {s?.site.is_test && <span className="text-xs font-normal text-fg-dim">test site</span>}
    </span>
  );
}

/**
 * The "All sites" link plus the status_detail note. app/seo/[site]/page.tsx passes
 * this as PageFrame's `subtitle` prop.
 */
export function SiteSubtitle({ loaded, base = "/seo" }: { loaded: Loaded<SiteData>; base?: string }) {
  const s = siteOf(loaded);
  return (
    <>
      <Link prefetch={false} href={base} className="text-xs text-fg-muted hover:text-fg hover:underline">All sites</Link>
      {s?.site.status_detail && <p className="mt-1 text-sm text-fg-muted">{s.site.status_detail}</p>}
    </>
  );
}

/**
 * The body only: no header, no outer width/padding wrapper. app/seo/[site]/page.tsx
 * renders this as PageFrame's children, with SiteTitle/SiteSubtitle/RangeTabs drawn
 * via PageFrame's title/subtitle/actions props instead (PageFrame ruling, Adon
 * 2026-10-07; same split as components/seo/SitesView.tsx + SitesActions.tsx).
 */
export function SiteView({ loaded, range }: { loaded: Loaded<SiteData>; siteId: string; range: SeoRange; base?: string }) {
  const data = loaded.state === "ok" ? loaded.data : null;
  const s = data?.summary ?? null;
  return (
    <div className="space-y-5">
      {!data || !s ? (
        <>
          <UnavailableBanner />
          <SiteKpis summary={null} range={range} error />
        </>
      ) : s.rollups_pending ? (
        <p className="rounded-lg border border-hairline bg-bg-panel px-4 py-3 text-sm text-fg-muted">
          Monthly totals are being rebuilt. The 16-month view fills in once the rebuild runs; 28 days and 3 months are complete.
        </p>
      ) : !s.current ? (
        <p className="rounded-lg border border-hairline bg-bg-panel px-4 py-3 text-sm text-fg-muted">
          No data collected yet. Figures appear after the first pull once Google confirms access.
        </p>
      ) : (
        <>
          <SiteKpis summary={s} range={range} error={false} />
          <TrendChart points={s.trend} grain={s.grain ?? "day"} />
        </>
      )}

      {data && s && (
        <>
          <div className="grid gap-5 lg:grid-cols-2">
            <TopTable title="Top searches" dim="query" data={data.queries} />
            <TopTable title="Top pages" dim="page" data={data.pages} />
          </div>
          <FreshnessPanel f={s.freshness} />
        </>
      )}
    </div>
  );
}
