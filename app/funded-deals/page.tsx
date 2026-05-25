import { ComingSoon } from "@/components/sunbiz/ComingSoon";
import { BadgeDollarSign } from "lucide-react";

export const dynamic = "force-dynamic";

export default function FundedDealsPage() {
  return (
    <ComingSoon
      title="Funded Deals"
      subtitle="Closed funding deals and renewal opportunities"
      icon={BadgeDollarSign}
      phase2Bullets={[
        "Closed deals will show merchant, lender, amount, rate, funding date, next renewal window, and estimated commission.",
        "Filter by lender, funding band, month-to-date, and year-to-date.",
        "Each deal gets a timeline: application, offer, funded, renewal.",
        "New funded deals will automatically feed renewals and commissions.",
        "Renewal opportunities surface automatically as deals progress through their term.",
      ]}
      related={[
        { href: "/renewals", label: "Renewals" },
        { href: "/commissions", label: "Commissions" },
      ]}
    />
  );
}
