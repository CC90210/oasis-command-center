import { Suspense } from "react";
import { WebLeadsBrowser } from "@/components/web-leads/WebLeadsBrowser";
import { WebLeadsSkeleton } from "@/components/web-leads/WebLeadsSkeleton";
import { resolveSessionContext } from "@/lib/api-auth";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/tenant";
import { mayWorkWebsiteSalesLifecycle } from "@/lib/website-sales-workflow";

export const dynamic = "force-dynamic";

export default async function WebLeadsPage() {
  const session = await resolveSessionContext();
  const canMutate =
    session.ok &&
    session.tenantId === WEBDEV_TENANT_ID &&
    mayWorkWebsiteSalesLifecycle(session.teamRole, session.isAdmin);
  return (
    <Suspense fallback={<WebLeadsSkeleton />}>
      <WebLeadsBrowser canMutate={canMutate} />
    </Suspense>
  );
}
