import { PageHeader } from "@/components/Card";
import { notFound } from "next/navigation";
import { maySeeCommissionSurface } from "@/lib/role-surfaces";
import { resolveViewerSurface } from "@/lib/role-surfaces-session";
import { CommissionPortal } from "./CommissionPortal";

export const dynamic = "force-dynamic";

export default async function CommissionsPage() {
  const surface = await resolveViewerSurface();
  if (!surface.ok || !maySeeCommissionSurface(surface.capabilities)) notFound();
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
