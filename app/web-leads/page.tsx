import { Suspense } from "react";
import { redirect } from "next/navigation";
import { WebLeadsBrowser } from "@/components/web-leads/WebLeadsBrowser";
import { WebLeadsSkeleton } from "@/components/web-leads/WebLeadsSkeleton";
import { resolveSessionContext } from "@/lib/api-auth";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/tenant";
import { mayWorkWebsiteSalesLifecycle } from "@/lib/website-sales-workflow";

export const dynamic = "force-dynamic";

export default async function WebLeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [session, rawParams] = await Promise.all([resolveSessionContext(), searchParams]);
  const canMutate =
    session.ok &&
    session.tenantId === WEBDEV_TENANT_ID &&
    mayWorkWebsiteSalesLifecycle(session.teamRole, session.isAdmin);
  const teamView =
    session.ok &&
    session.tenantId === WEBDEV_TENANT_ID &&
    !session.isAdmin &&
    session.teamRole.trim().toLowerCase() === "manager";
  // A manager comes here to coach the roster, so land on that small, read-only
  // assigned book by default instead of the 31K shared prospect pool. An
  // explicit view=pool remains available when they intend to claim leads.
  if (teamView && !rawParams.view) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(rawParams)) {
      if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
      else if (value) params.set(key, value);
    }
    params.set("view", "mine");
    redirect(`/web-leads?${params.toString()}`);
  }
  return (
    <Suspense fallback={<WebLeadsSkeleton />}>
      <WebLeadsBrowser canMutate={canMutate} teamView={teamView} />
    </Suspense>
  );
}
