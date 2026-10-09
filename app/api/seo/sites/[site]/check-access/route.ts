// POST /api/seo/sites/:site/check-access: ask Google whether our service account can read the site.
import { checkAccessAction } from "@/lib/seo/actions";
import { seoClient, seoOwnerEmail } from "@/lib/seo/occ";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return checkAccessAction(req, site, { operatorEmail: seoOwnerEmail, client: seoClient });
}
