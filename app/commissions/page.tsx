import { PageHeader } from "@/components/Card";
import { requireOsRoute } from "@/components/os/landings/page-gate";
import { resolveSessionContext } from "@/lib/api-auth";
import {
  loadCommissionPortal,
  type CommissionPortalPayload,
} from "@/lib/website-sales-commission-portal";
import { CommissionPortal } from "./CommissionPortal";

export const dynamic = "force-dynamic";

/**
 * /commissions - OASIS's commission portal.
 *
 * GATE (2026-09-30). The page asks the rail the same question the Commissions
 * row does: requireOsRoute("/commissions"), as its first statement. That row
 * needs the `commissions` module (OASIS's own workspace only, lib/os/modules.ts)
 * AND a persona that may see a commission surface. The page used to check only
 * the persona, so a client workspace's owner (a founder persona) could open
 * OASIS's commission portal by URL. OASIS's closers and founders keep it.
 *
 * FIRST PAINT (2026-10-02). The numbers are read here, on the server, and the
 * portal starts with them: no loading card, and no second request from the
 * browser after it loads. The gate above already resolved this request's
 * session; the reads behind resolveSessionContext are cached per request, so
 * asking again costs nothing. app/commissions/loading.tsx is what shows while
 * this renders.
 */
export default async function CommissionsPage() {
  const viewer = await requireOsRoute("/commissions");
  const session = await resolveSessionContext();
  const initial: CommissionPortalPayload = session.ok
    ? (await loadCommissionPortal(session, viewer.surface.persona)).body
    : { ok: false, error: "unauthorized" };
  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Commissions"
        subtitle="What each client's setup payment has earned, and where every payout stands."
      />
      <CommissionPortal initial={initial} />
    </div>
  );
}
