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
      {/* text-white + a hover that darkens: text-fg on bg-accent-muted is ~4.42:1 (under the 4.5:1
         AA floor) and hover:bg-accent lightens to ~3.15:1. White on accent-muted is ~5.17:1; the
         hover goes to rgb(29 78 216) (the same shade .btn-primary in app/globals.css hovers to),
         white on which is ~6.70:1. Arbitrary value: no accent-* token is that shade. */}
      <Link prefetch={false} href={`${base}/add`} className="rounded-md bg-accent-muted px-3 py-1.5 text-sm font-medium text-white hover:bg-[rgb(29_78_216)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        Add a site
      </Link>
    </>
  );
}
