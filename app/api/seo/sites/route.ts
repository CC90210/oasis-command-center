// POST /api/seo/sites: add a site. All rules live in lib/seo/actions.ts (tested).
import { addSiteAction } from "@/lib/seo/actions";
import { seoClient, seoOwnerEmail } from "@/lib/seo/occ";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return addSiteAction(req, { operatorEmail: seoOwnerEmail, client: seoClient });
}
