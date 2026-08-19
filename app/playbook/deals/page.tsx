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
    <Card title="The pipeline — who does what" subtitle="Every stage has one owner, one required action, and one completion rule.">
      <div className="space-y-3">
        <PipelineStep stage="Research" owner="APEX → Oasis Webdev" action="APEX scrapes and enriches the lead for the Oasis Webdev tenant. Promotion captures contact details, URL, website condition, audit finding, ICP track, and sales_program=website_sales_v1." done="The lead is deduplicated, has one useful call angle, and is ready for assignment. Import never triggers an automatic send." />
        <PipelineStep stage="Assigned" owner="Admin" action="Choose one Agent. Assignment uses the rep's account UUID and the lead shows their name." done="The lead appears in that Agent's queue and nobody else's." />
        <PipelineStep stage="Attempting" owner="Agent" action="Call the lead. Record No answer or Voicemail and schedule the next touch; never leave a lead without a next action." done="A disposition and follow-up time are saved, or the lead advances." />
        <PipelineStep stage="Connected" owner="Agent" action="Diagnose the visible website problem, its business consequence, authority, timing, and minimum $2,000 willingness." done="All four qualification gates are confirmed or the lead is marked Lost." />
        <PipelineStep stage="Qualified" owner="Agent (appointment setter)" action="Open the OASIS Google Meet calendar, select CC or Adon, schedule the meeting, and record the promised audit/demo angle." done="Send to founder pipeline freezes rep attribution and completes the Agent's launch-V1 job. Agents do not close or negotiate." />
        <PipelineStep stage="Founder Meeting → Won/Lost" owner="CC or Adon" action="Review the handoff, run the audit/demo, select scope and package, send proposal, and collect the standard 50% setup deposit." done="Outcome, quote, closer, collected amount, and loss reason are recorded." />
        <PipelineStep stage="Onboarding → In Build → Client Review → Launched" owner="OASIS delivery" action="Collect assets and access, build from the website checklist, complete responsive/accessibility/SEO/forms QA, obtain approval, launch DNS and analytics." done="The live website, maintenance owner, backups, and monthly service start are verified." />
      </div>
    </Card>
    <Card title="Agent screen rules" subtitle="The five-stage view keeps the sales job narrow and prevents data leakage.">
      <ul className="list-disc pl-5 space-y-2 text-sm text-fg-muted"><li>Agents see only Assigned, Attempting Contact, Connected, Qualified, and Founder Meeting.</li><li>Agents see only records assigned to their own account.</li><li>Voicemail is a disposition inside Attempting Contact, not a stage.</li><li>Agents cannot quote, discount, promise delivery dates, confirm custom automation feasibility, mark payment, or move delivery stages.</li><li>Admins and members operating internally retain the complete tenant pipeline; only admins assign leads and control sensitive close/fulfilment actions.</li></ul>
    </Card>
    <Card title="Role growth path" subtitle="Launch V1 stays simple without boxing the company in.">
      <p className="text-sm leading-relaxed text-fg-muted">Every new sales hire starts as an <b className="text-fg">Agent appointment setter</b>. Their scorecard is conversations, qualified meetings booked, show rate, and handoff quality. Later, a proven Agent may be promoted into a founder-approved closer track with separate permissions, training, compensation, and close controls. No one receives closing authority merely by working leads longer.</p>
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
function PipelineStep({stage,owner,action,done}:{stage:string;owner:string;action:string;done:string}) { return <div className="grid md:grid-cols-[12rem_1fr] gap-2 rounded-lg border border-bg-border bg-bg-elev/30 p-3"><div><div className="font-bold text-fg">{stage}</div><div className="text-[11px] uppercase tracking-wider text-accent mt-1">{owner}</div></div><div className="text-sm text-fg-muted"><div>{action}</div><div className="mt-1 text-fg"><b>Advance when:</b> {done}</div></div></div>; }
