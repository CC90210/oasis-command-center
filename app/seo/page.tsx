import { requireOperator } from "@/lib/role-surfaces-session";
import { settle } from "@/lib/seo/client";
import { seoClient } from "@/lib/seo/occ";
import { PageFrame } from "@/components/os/PageFrame";
import { SitesView } from "@/components/seo/SitesView";
import { SitesActions } from "@/components/seo/SitesActions";

export const dynamic = "force-dynamic";

export default async function SeoSitesPage({ searchParams }: { searchParams: Promise<{ test?: string }> }) {
  // GATE: requireOperator() as the FIRST statement. The data is never fetched for anyone else.
  await requireOperator();
  const includeTest = (await searchParams).test === "1";
  const loaded = await settle(async () => (await seoClient()).listSites({ includeTest }));
  return (
    <PageFrame
      title="SEO"
      subtitle="Google Search, last 28 settled days against the 28 before. Needs attention first."
      actions={<SitesActions includeTest={includeTest} />}
    >
      <SitesView loaded={loaded} />
    </PageFrame>
  );
}
