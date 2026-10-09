import { notFound } from "next/navigation";
import { settle } from "@/lib/seo/client";
import { parseRange } from "@/lib/seo/format";
import { requireSeoOwner, seoClient } from "@/lib/seo/occ";
import { PageFrame } from "@/components/os/PageFrame";
import { RangeTabs, SiteSubtitle, SiteTitle, SiteView } from "@/components/seo/SiteView";

export const dynamic = "force-dynamic";

export default async function SeoSitePage({ params, searchParams }: {
  params: Promise<{ site: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  // GATE: requireSeoOwner() as the FIRST statement (CC and Adon only). The data is never fetched for anyone else.
  await requireSeoOwner();
  const { site } = await params;
  const range = parseRange((await searchParams).range);
  // include_test: an owner opening a site by its id sees it, test or not. The list still hides test sites.
  const loaded = await settle(async () => {
    const c = await seoClient();
    const [summary, queries, pages] = await Promise.all([
      c.summary(site, range, { includeTest: true }),
      c.queries(site, range, { includeTest: true }),
      c.pages(site, range, { includeTest: true }),
    ]);
    return { summary, queries, pages };
  });
  if (loaded.state === "not_found") notFound();
  return (
    <PageFrame
      title={<SiteTitle loaded={loaded} siteId={site} />}
      subtitle={<SiteSubtitle loaded={loaded} />}
      actions={<RangeTabs siteId={site} range={range} />}
    >
      <SiteView loaded={loaded} siteId={site} range={range} />
    </PageFrame>
  );
}
