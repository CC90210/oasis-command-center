import Link from "next/link";
import { ArrowLeft, Check } from "lucide-react";
import { Card, PageHeader, Tag } from "@/components/Card";
import { AUTOMATION_ADD_ONS, WEBSITE_PACKAGES } from "@/lib/website-sales";

export const dynamic = "force-dynamic";

export default function DealArchitecturePage() {
  const packages = Object.values(WEBSITE_PACKAGES);
  return <div className="space-y-6 animate-fade-in">
    <Link href="/playbook" className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-accent"><ArrowLeft size={14}/> Playbook</Link>
    <PageHeader title="Website Sales Engine — V4" subtitle="Websites open the door. Focused automations expand the outcome." action={<Tag tone="accent">canonical</Tag>}/>
    <Card title="Operating rule" subtitle="Reps qualify and book; founders scope, price, and close.">
      <p className="text-sm leading-relaxed text-fg">Lead with one visible website problem and its cost in trust, calls, or bookings. Use an automation only when discovery exposes a matching leak. CC or Adon owns every quote, discount, custom promise, and close.</p>
    </Card>
    <div className="grid lg:grid-cols-3 gap-4">
      {packages.map((offer) => <Card key={offer.id}>
        <div className="flex items-start justify-between gap-3"><div><div className="text-lg font-bold text-fg">{offer.name}</div><div className="text-xs uppercase tracking-wider text-fg-muted mt-1">{offer.includedAutomationCount} automation{offer.includedAutomationCount === 1 ? "" : "s"} included</div></div><div className="text-right text-status-engaged font-bold"><div>${offer.setupFloor.toLocaleString()}+</div><div className="text-xs">${offer.monthlyFloor}+/mo</div></div></div>
        <div className="mt-4 space-y-2">{offer.features.map((feature) => <div key={feature} className="flex gap-2 text-sm text-fg-muted"><Check className="w-4 h-4 text-accent shrink-0 mt-0.5"/>{feature}</div>)}</div>
      </Card>)}
    </div>
    <Card title="Approved automation menu" subtitle="Diagnose first. Never improvise custom feasibility or price.">
      <div className="grid md:grid-cols-2 gap-2">{AUTOMATION_ADD_ONS.map((item) => <div key={item.id} className="rounded-lg border border-bg-border bg-bg-elev/40 p-3"><div className="font-semibold text-sm text-fg">{item.name}</div><div className="text-xs text-fg-muted mt-1">{item.diagnostic}</div></div>)}</div>
    </Card>
    <Card title="Rep compensation" subtitle="Collected setup revenue only; no recurring share in V1.">
      <div className="grid sm:grid-cols-3 gap-3 text-center"><Rate band="$2,000–$3,499" rate="10%"/><Rate band="$3,500–$4,999" rate="12.5%"/><Rate band="$5,000+" rate="15%"/></div>
      <p className="text-xs text-fg-muted mt-4">Attribution freezes to the assigned rep when the founder meeting is booked. Cleared payment creates one accrual; refunds create an offset instead of erasing history.</p>
    </Card>
  </div>;
}

function Rate({band, rate}:{band:string;rate:string}) { return <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-4"><div className="text-xl font-bold text-accent">{rate}</div><div className="text-xs text-fg-muted mt-1">{band} collected</div></div>; }
