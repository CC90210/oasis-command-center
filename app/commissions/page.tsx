import { PageHeader } from "@/components/Card";
import { CommissionPortal } from "./CommissionPortal";

export const dynamic = "force-dynamic";

export default function CommissionsPage() {
  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Commission Portal"
        subtitle="Every payout traces back to the exact client, verified collection, sales role, and frozen rate."
      />
      <CommissionPortal />
    </div>
  );
}
