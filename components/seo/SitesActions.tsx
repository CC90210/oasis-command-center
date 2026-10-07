import Link from "next/link";

/**
 * The /seo page's title-row actions: the test-sites toggle and "Add a site".
 * Split out of SitesView so app/seo/page.tsx can pass it to PageFrame's
 * `actions` prop (PageFrame ruling, Adon 2026-10-07) instead of SitesView
 * drawing its own header.
 */
export function SitesActions({ includeTest, base = "/seo" }: { includeTest: boolean; base?: string }) {
  return (
    <>
      <Link prefetch={false} href={includeTest ? base : `${base}?test=1`} className="text-sm text-fg-muted hover:text-fg hover:underline">
        {includeTest ? "Hide test sites" : "Show test sites"}
      </Link>
      <Link prefetch={false} href={`${base}/add`} className="rounded-md bg-accent-muted px-3 py-1.5 text-sm font-medium text-fg hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        Add a site
      </Link>
    </>
  );
}
