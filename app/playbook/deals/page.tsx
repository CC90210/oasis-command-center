import Link from "next/link";
import { ArrowLeft, Check } from "lucide-react";
import { Card, PageHeader, Tag } from "@/components/Card";
import { AUTOMATION_ADD_ONS, WEBSITE_PACKAGES } from "@/lib/website-sales";
// Rates come from the payout engine and are never retyped here. This page
// is the comp plan as a rep understands it, so a number on it that the
// engine does not pay is a promise the company breaks to someone it
// recruited on that promise.
import {
  COMPANY_TRACK_BPS,
  SELF_TRACK_BPS,
  PRICE_BOOK,
  UPSELL_SHARE_BPS,
  MAX_HUMAN_PAYOUT_BPS,
  SPECIALIST_SPLIT_FLOOR_CENTS,
} from "@/lib/website-sales-comp";

export const dynamic = "force-dynamic";

// Every rate + dollar figure on this page is computed from
// lib/website-sales-comp.ts (rates + price book) and lib/website-sales.ts (packages) —
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
        <PipelineStep stage="Lead claimed" owner="Agent" action="Claim one cold prospect from Leads. The complete contact, company, location, website, and audit context moves into Pipeline without creating a second lead." done="The lead is assigned to that Agent, enters Assigned, and the claim is recorded as its first Pipeline touch." />
        <PipelineStep stage="Assigned" owner="Agent" action="Open the lead profile, review the website and call angle, then start outreach." done="Start outreach moves the lead to Attempting Contact and records the acting rep and time." />
        <PipelineStep stage="Attempting" owner="Agent" action="Call the lead. Record No answer or Voicemail and schedule the next touch; never leave a lead without a next action." done="A disposition and follow-up time are saved, or the lead advances." />
        <PipelineStep stage="Connected" owner="Agent" action="Diagnose the visible website problem, its business consequence, authority, timing, and minimum $2,000 willingness." done="All four qualification gates are confirmed or the lead is marked Lost." />
        <PipelineStep stage="Qualified" owner="Agent" action="Choose the founder or closer, exact requested time, and promised audit angle. Open the prefilled 15-minute Google Calendar event, save it, then confirm the handoff." done="The saved-event confirmation freezes opener credit, records the host and time, and transfers ownership to the selected closer." />
        <PipelineStep stage="Founder Meeting → Proposal" owner="Founder or closer" action="Review the opener handoff, hold the audit, and capture the complete builder brief from the conversation before pricing. Record held, no-show, reschedule, follow-up, or lost honestly." done="The scope is builder-ready, the full quote and exact amount due now are frozen, and the lead-bound live payment link can be sent." />
        <PipelineStep stage="Paid → Onboarding" owner="Founder or closer" action="Verify the exact live Stripe Checkout collection, or have a founder attest to cleared manual funds, and select the assigned builder." done="Commission accrues only on the verified collected amount; the paid client and complete brief transfer to the assigned builder." />
        <PipelineStep stage="Onboarding → In Build → Client Review → Launched" owner="Assigned builder" action="Work from the captured brief, preserve delivery updates, and move the client through build, review, and launch." done="Each delivery move is recorded as a touch and only the assigned builder or an admin can advance it." />
      </div>
    </Card>
    <Card title="Agent screen rules" subtitle="Actionable work follows ownership; completed handoffs remain visible as read-only credited deals.">
      <ul className="list-disc pl-5 space-y-2 text-sm text-fg-muted"><li>Openers work Assigned, Attempting Contact, Connected, and Qualified, then hand the booked meeting to the selected closer.</li><li>Closers work only their assigned founder meetings, briefs, proposals, and collections.</li><li>Voicemail is a disposition inside Attempting Contact, not a stage.</li><li>Agents cannot discount, promise delivery dates, confirm custom automation feasibility, or move delivery stages. Closer-track Agents may quote at listed floors on their own leads; below-floor pricing and scope changes stay with CC or Adon.</li><li>Every commission accrues only after collected cash is verified. A founder approves each payout; no rep can approve their own.</li><li>Builders can open and advance only clients explicitly assigned to them.</li></ul>
    </Card>
    <Card title="Role growth path" subtitle="Launch V1 stays simple without boxing the company in.">
      <p className="text-sm leading-relaxed text-fg-muted">Every new sales hire starts as an <b className="text-fg">opener</b>, earning {pct(COMPANY_TRACK_BPS.opener / 10000)} on company-sourced leads. Their scorecard is conversations, qualified meetings booked, show rate, and handoff quality. A proven Agent is then granted the <b className="text-fg">closer track</b>: they run the demo, proposal, and close on their own leads and earn {pct(COMPANY_TRACK_BPS.closer / 10000)} — or {pct(SELF_TRACK_BPS.open_close / 10000)} on a client they sourced themselves. The track is granted per rep by CC or Adon and is never implied by tenure — but it is open to anyone who books consistently, and it is the single biggest raise available here.</p>
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
    <Card title="Rep compensation" subtitle="Percent of collected setup revenue · paid on cash collected · no recurring share in V1.">
      <p className="text-sm leading-relaxed text-fg-muted mb-4">Your rate depends on <b className="text-fg">who sourced the lead</b> and <b className="text-fg">how much of the deal you owned</b>. Self-sourced work pays more, because you supplied what the company otherwise pays to generate. These are the same numbers as in your agreement and the same numbers the payout runs on — all three read from one place.</p>
      <div className="grid sm:grid-cols-2 gap-3">
        <RateCard role="You book it" rate={pct(COMPANY_TRACK_BPS.opener / 10000)} detail="Open a company-sourced lead: work it, qualify it, put the founder meeting on the calendar. Someone else closes."/>
        <RateCard role="You close it" rate={pct(COMPANY_TRACK_BPS.closer / 10000)} detail="Close a company-sourced lead that someone else opened. Founder approval on the payout."/>
        <RateCard role="You found it AND closed it" rate={pct(SELF_TRACK_BPS.open_close / 10000)} detail="You sourced the client yourself and ran the close. The single biggest raise available here."/>
        <RateCard role="You did all of it" rate={pct(SELF_TRACK_BPS.full_stack / 10000)} detail="Sourced it, closed it, and built it. OASIS keeps the remainder for the tooling."/>
      </div>
      <div className="mt-4 rounded-lg border border-bg-border bg-bg-elev/40 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-fg-muted border-b border-bg-border">
              <th className="text-left font-semibold px-4 py-2.5">Package (at book price)</th>
              <th className="text-right font-semibold px-4 py-2.5">You book it ({pct(COMPANY_TRACK_BPS.opener / 10000)})</th>
              <th className="text-right font-semibold px-4 py-2.5">You close it ({pct(COMPANY_TRACK_BPS.closer / 10000)})</th>
              <th className="text-right font-semibold px-4 py-2.5">Found + closed ({pct(SELF_TRACK_BPS.open_close / 10000)})</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(PRICE_BOOK).map(([id, tier]) => <tr key={id} className="border-b border-bg-border last:border-0">
              <td className="px-4 py-2.5 text-fg-muted">{usd(tier.bookCents / 100)} <span className="text-fg-dim">({id})</span></td>
              <td className="px-4 py-2.5 text-right font-semibold text-fg">{usd((tier.bookCents / 100) * COMPANY_TRACK_BPS.opener / 10000)}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-fg">{usd((tier.bookCents / 100) * COMPANY_TRACK_BPS.closer / 10000)}</td>
              <td className="px-4 py-2.5 text-right font-bold text-status-engaged">{usd((tier.bookCents / 100) * SELF_TRACK_BPS.open_close / 10000)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <p className="text-sm leading-relaxed text-fg mt-4">Sell <b className="text-fg">above book price</b> and you keep {pct(UPSELL_SHARE_BPS / 10000)} of the difference on top of your rate. Sell below book and the rate steps down — discounting is allowed, it is simply not free.</p>
      <p className="text-sm leading-relaxed text-fg-muted mt-3">Deals under {usd(SPECIALIST_SPLIT_FLOOR_CENTS / 100)} are worked by one person end to end rather than split between an opener and a closer — a split that size pays neither party properly. They still pay in full; they are not excluded.</p>
      <p className="text-xs text-fg-muted mt-3">Opener attribution freezes when the founder meeting is confirmed. Exact cleared payment creates one accrual per credited person on the deal, and every payout still requires founder approval. Across everyone on a deal, payouts never exceed {pct(MAX_HUMAN_PAYOUT_BPS / 10000)} of what was collected.</p>
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
