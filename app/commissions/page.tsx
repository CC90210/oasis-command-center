import { PageHeader } from "@/components/Card";
import { requireOsRoute } from "@/components/os/landings/page-gate";
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
 */
export default async function CommissionsPage() {
  await requireOsRoute("/commissions");
  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Commission Portal"
        subtitle="Every accrued payout traces to a fully paid Won client, verified collection, credited role, and frozen rate."
      />
      <CommissionPortal />
    </div>
  );
}
