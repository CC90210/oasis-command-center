import Link from "next/link";
import { ArrowLeft, Check } from "lucide-react";
import { Card, PageHeader, Tag } from "@/components/Card";
import { AUTOMATION_ADD_ONS, COMMISSION_MODEL, WEBSITE_PACKAGES } from "@/lib/website-sales";

export const dynamic = "force-dynamic";

// Every rate + dollar figure on this page is computed from
// lib/website-sales.ts (COMMISSION_MODEL + package setup floors) —
// change the model there and this page follows. No hardcoded comp math.
const pct = (rate: number) => `${Math.round(rate * 1000) / 10}%`;
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export default function DealArchitecturePage() {
  const packages = Object.values(WEBSITE_PACKAGES);
  return <div className="space-y-6 animate-fade-in">
    <Link href="/playbook" className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-accent"><ArrowLeft size={14}/> Playbook</Link>
    <PageHeader title="Website Sales Engine — V5" subtitle="Websites open the door. Focused automations expand the outcome." action={<Tag tone="accent">canonical</Tag>}/>
    <Card title="Operating rule" subtitle="Reps qualify and book; founders scope, price, and close.">
      <p className="text-sm leading-relaxed text-fg">Lead with one visible website problem and its cost in trust, calls, or bookings. Use an automation only when discovery exposes a matching leak. CC or Adon owns every quote, discount, custom promise, and close.</p>
    </Card>
    <Card title="The pipeline — who does what" subtitle="Every stage has one owner, one required action, and one completion rule.">
      <div className="space-y-3">
        <PipelineStep stage="Research" owner="APEX → Oasis Webdev" action="APEX scrapes and enriches the lead for the Oasis Webdev tenant. Promotion captures contact details, URL, website condition, audit finding, ICP track, and sales_program=website_sales_v1." done="The lead is deduplicated, has one useful call angle, and is ready for assignment. Import never triggers an automatic send." />
        <PipelineStep stage="Assigned" owner="Admin" action="Choose one Agent. Assignment uses the rep's account UUID and the lead shows their name." done="The lead appears in that Agent's queue and nobody else's." />
        <PipelineStep stage="Attempting" owner="Agent" action="Call the lead. Record No answer or Voicemail and schedule the next touch; never leave a lead without a next action." done="A disposition and follow-up time are saved, or the lead advances." />
        <PipelineStep stage="Connected" owner="Agent" action="Diagnose the visible website problem, its business consequence, authority, timing, and minimum $2,000 willingness." done="All four qualification gates are confirmed or the lead is marked Lost." />
        <PipelineStep stage="Qualified" owner="Agent" action="Open the OASIS Google Meet calendar, select CC or Adon, schedule the meeting, and record the promised audit/demo angle. Marking Qualified also emails the lead the booking link automatically." done="Send to founder pipeline freezes rep attribution. Setters hand off here; closer-track reps carry their own deal through the founder meeting." />
        <PipelineStep stage="Founder Meeting → Won/Lost" owner="CC or Adon" action="Review the handoff, run the audit/demo, select scope and package, send proposal, and collect the standard 50% setup deposit." done="Outcome, quote, closer, collected amount, and loss reason are recorded." />
        <PipelineStep stage="Onboarding → In Build → Client Review → Launched" owner="OASIS delivery" action="Collect assets and access, build from the website checklist, complete responsive/accessibility/SEO/forms QA, obtain approval, launch DNS and analytics." done="The live website, maintenance owner, backups, and monthly service start are verified." />
      </div>
    </Card>
    <Card title="Agent screen rules" subtitle="The five-stage view keeps the sales job narrow and prevents data leakage.">
      <ul className="list-disc pl-5 space-y-2 text-sm text-fg-muted"><li>Agents see only Assigned, Attempting Contact, Connected, Qualified, and Founder Meeting.</li><li>Agents see only records assigned to their own account.</li><li>Voicemail is a disposition inside Attempting Contact, not a stage.</li><li>Agents cannot discount, promise delivery dates, confirm custom automation feasibility, or move delivery stages. Closer-track Agents may send a proposal and close at listed floors on their own leads; below-floor pricing and scope changes stay with CC or Adon.</li><li>Every commission accrues only — a founder approves each payout. No rep can approve their own.</li><li>Admins and members operating internally retain the complete tenant pipeline; only admins assign leads and control sensitive fulfilment actions.</li></ul>
    </Card>
    <Card title="Role growth path" subtitle="Launch V1 stays simple without boxing the company in.">
      <p className="text-sm leading-relaxed text-fg-muted">Every new sales hire starts as an <b className="text-fg">Agent appointment setter</b> earning {pct(COMMISSION_MODEL.opener)}. Their scorecard is conversations, qualified meetings booked, show rate, and handoff quality. A proven Agent is then granted the <b className="text-fg">closer track</b>: they run the demo, proposal, and close on their own leads and earn {pct(COMMISSION_MODEL.openerCloser)} instead. The track is granted per rep by CC or Adon and is never implied by tenure — but it is open to anyone who books consistently, and it is the single biggest raise available here.</p>
    </Card>
    <div className="grid lg:grid-cols-3 gap-4">
      {packages.map((offer) => <Card key={offer.id}>
        <div className="flex items-start justify-between gap-3"><div><div className="text-lg font-bold text-fg">{offer.name}</div><div className="text-xs uppercase tracking-wider text-fg-muted mt-1">{offer.includedAutomationCount} automation{offer.includedAutomationCount === 1 ? "" : "s"} included</div></div><div className="text-right text-status-engaged font-bold"><div>${offer.setupFloor.toLocaleString()}+</div><div className="text-xs">${offer.monthlyFloor}+/mo</div></div></div>
        <div className="mt-4 space-y-2">{offer.features.map((feature) => <div key={feature} className="flex gap-2 text-sm text-fg-muted"><Check className="w-4 h-4 text-accent shrink-0 mt-0.5"/>{feature}</div>)}</div>
      </Card>)}
    </div>
    <Card title="Approved automation menu" subtitle="Ask the question first. Sell only what the answer exposes — and only what is listed here.">
      <p className="text-sm text-fg-muted mb-3">Everything on this menu is text and email, running on OASIS infrastructure — we own the sending address and the credentials, so the client never has to hand over passwords. <b className="text-fg">OASIS does not sell AI voice agents.</b> Missed-call recovery is an SMS text-back; no automation on this list answers a phone. If a prospect asks for something not listed, that is a custom scope conversation for CC or Adon, never a rep quote.</p>
      <div className="grid md:grid-cols-2 gap-2">{AUTOMATION_ADD_ONS.map((item) => <div key={item.id} className="rounded-lg border border-bg-border bg-bg-elev/40 p-3">
        <div className="font-semibold text-sm text-fg">{item.name}</div>
        <div className="text-xs text-accent mt-1.5 italic">&ldquo;{item.diagnostic}&rdquo;</div>
        <div className="text-xs text-fg-muted mt-2 leading-relaxed">{item.delivers}</div>
      </div>)}</div>
    </Card>
    <Card title="Rep compensation" subtitle={`Percent of collected setup revenue · ${usd(COMMISSION_MODEL.floorSetup)} minimum deal · no recurring share in V1.`}>
      <div className="grid sm:grid-cols-2 gap-3">
        <RateCard role="You book it" rate={pct(COMMISSION_MODEL.opener)} detail="Open it: source and work the lead, qualify it, and put the founder meeting on the calendar. CC or Adon runs the close."/>
        <RateCard role="You close it" rate={pct(COMMISSION_MODEL.openerCloser)} detail="Open and close it: run the demo, the proposal, and the close yourself. Founder approval on the payout."/>
      </div>
      <div className="mt-4 rounded-lg border border-bg-border bg-bg-elev/40 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-fg-muted border-b border-bg-border">
              <th className="text-left font-semibold px-4 py-2.5">Collected setup</th>
              <th className="text-right font-semibold px-4 py-2.5">You book it ({pct(COMMISSION_MODEL.opener)})</th>
              <th className="text-right font-semibold px-4 py-2.5">You close it ({pct(COMMISSION_MODEL.openerCloser)})</th>
            </tr>
          </thead>
          <tbody>
            {packages.map((offer) => <tr key={offer.id} className="border-b border-bg-border last:border-0">
              <td className="px-4 py-2.5 text-fg-muted">{usd(offer.setupFloor)} <span className="text-fg-dim">({offer.name})</span></td>
              <td className="px-4 py-2.5 text-right font-semibold text-fg">{usd(offer.setupFloor * COMMISSION_MODEL.opener)}</td>
              <td className="px-4 py-2.5 text-right font-bold text-status-engaged">{usd(offer.setupFloor * COMMISSION_MODEL.openerCloser)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <p className="text-sm leading-relaxed text-fg mt-4">The math rewards the rep who doesn&apos;t quit: twenty real conversations a week turns into booked meetings, and one closed {WEBSITE_PACKAGES.growth.name} build pays {usd(WEBSITE_PACKAGES.growth.setupFloor * COMMISSION_MODEL.openerCloser)} when you run the close yourself. Most reps give up two conversations before the yes — these leads arrive researched and pre-qualified, so the only variable left is your volume. The rate is fixed; how often you collect it is up to you.</p>
      <p className="text-xs text-fg-muted mt-3">Attribution freezes to the assigned rep when the founder meeting is booked. Cleared payment creates one accrual; refunds create an offset instead of erasing history.</p>
    </Card>
  </div>;
}

function RateCard({role, rate, detail}:{role:string;rate:string;detail:string}) {
  return <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-4">
    <div className="flex items-baseline justify-between gap-3"><div className="text-sm font-bold text-fg">{role}</div><div className="text-2xl font-bold text-accent">{rate}</div></div>
    <p className="text-xs text-fg-muted mt-2 leading-relaxed">{detail}</p>
  </div>;
}
function PipelineStep({stage,owner,action,done}:{stage:string;owner:string;action:string;done:string}) { return <div className="grid md:grid-cols-[12rem_1fr] gap-2 rounded-lg border border-bg-border bg-bg-elev/30 p-3"><div><div className="font-bold text-fg">{stage}</div><div className="text-[11px] uppercase tracking-wider text-accent mt-1">{owner}</div></div><div className="text-sm text-fg-muted"><div>{action}</div><div className="mt-1 text-fg"><b>Advance when:</b> {done}</div></div></div>; }
