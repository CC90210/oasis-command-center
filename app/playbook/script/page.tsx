"use client";
import { useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Card, PageHeader, Tag } from "@/components/Card";

const TRACKS = {
  trades: ["mobile click-to-call", "service-area trust", "quote follow-up"],
  professional: ["authority and credibility", "clear service paths", "intake friction"],
  wellness: ["mobile booking", "reviews", "no-show recovery"],
  home_services: ["before/after proof", "local SEO", "estimate requests"],
} as const;
const OBJECTIONS = [
  ["Send me information", "I will. Should I focus on the mobile issue, lead capture, or both? Then let's put 15 minutes on the calendar so it is actually relevant."],
  ["We have a website person", "Good. Are they measured on maintenance, or on calls and bookings? We can complement them if the conversion gap remains."],
  ["Too expensive", "I have not priced your scope. The starting point is $2,000; CC or Adon recommends it only if the business case supports it."],
  ["Bad timing", "What would need to change for this to become timely, and when should we revisit it?"],
  ["We do not need a website", "When a referral checks you online before calling, what do they see? The website owns that trust step."],
];

export default function ScriptPage() {
  const [track, setTrack] = useState<keyof typeof TRACKS>("trades");
  return <div className="space-y-6 animate-fade-in">
    <Link href="/playbook" className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-accent"><ArrowLeft size={14}/> Playbook</Link>
    <PageHeader title="Website Cold Call + Founder Close" subtitle="Observe. Diagnose. Qualify. Book. Reps never negotiate or promise custom scope." action={<Tag tone="accent">V4</Tag>}/>
    <Card title="Choose the prospect track"><div className="flex flex-wrap gap-2">{Object.keys(TRACKS).map((key) => <button key={key} onClick={() => setTrack(key as keyof typeof TRACKS)} className={`px-3 py-2 rounded-md text-sm ${track === key ? "bg-accent text-bg" : "bg-bg-elev border border-bg-border text-fg-muted"}`}>{key.replace("_", " ")}</button>)}</div><p className="text-xs text-fg-muted mt-3">Listen for: {TRACKS[track].join(" · ")}</p></Card>
    <Card title="Rep sequence" subtitle="The target is a qualified Google Meet with CC or Adon.">
      <ScriptStep n="01" title="Observed opener">Hey [Name], it&apos;s [Rep] with OASIS. We haven&apos;t spoken before—this is a cold call. I noticed [specific website issue] on [Company]. Can I take 30 seconds to explain why I called?</ScriptStep>
      <ScriptStep n="02" title="Business consequence">When someone checks you out on their phone, [issue] makes it harder to [call/book/request a quote]. How much new business is supposed to come through the website today?</ScriptStep>
      <ScriptStep n="03" title="Qualify">Confirm the decision-maker, one real website/conversion problem, timing, and openness to a minimum $2,000 investment.</ScriptStep>
      <ScriptStep n="04" title="Automation segue">Only after a leak appears: “What happens after [form/missed call/quote]? Who owns follow-up?” Match it to one approved automation.</ScriptStep>
      <ScriptStep n="05" title="Book and hand off">I can put you with [CC/Adon] on [option A] or [option B]. Which works? Record the audit finding and promised demo.</ScriptStep>
    </Card>
    <Card title="Gatekeeper and voicemail"><p className="text-sm text-fg"><b>Gatekeeper:</b> I&apos;m calling about a specific issue on the company website that may be costing inquiries. Who owns the website and new-customer flow?</p><p className="text-sm text-fg mt-3"><b>Voicemail:</b> Hi [Name], [Rep] from OASIS. I noticed [issue] on [Company]&apos;s site that affects [calls/bookings]. I&apos;ll send a short note so you can see exactly what I mean.</p></Card>
    <Card title="Objections"><div className="space-y-3">{OBJECTIONS.map(([trigger,response]) => <div key={trigger} className="rounded-lg border border-bg-border p-3"><div className="font-bold text-sm text-fg">“{trigger}”</div><div className="text-sm text-fg-muted mt-1">{response}</div></div>)}</div></Card>
    <Card title="Founder close — 30 minutes"><ol className="space-y-2 text-sm text-fg-muted"><li>1. Confirm rep notes and desired outcome.</li><li>2. Quantify trust, conversion, and follow-up gaps.</li><li>3. Show the tailored audit/demo.</li><li>4. Anchor Authority → Growth → Essential and recommend one.</li><li>5. Prescribe only automations tied to admitted leaks.</li><li>6. Confirm scope and request the 50% setup deposit.</li></ol><blockquote className="mt-4 border-l-2 border-accent pl-4 text-sm text-fg">Based on what you showed me, [package] is the right fit at [setup] and [monthly], with [automation]. We start with 50% today and the balance before launch. Is anything stopping us from scheduling onboarding?</blockquote></Card>
  </div>;
}

function ScriptStep({n,title,children}:{n:string;title:string;children:React.ReactNode}) { return <div className="grid grid-cols-[2rem_1fr] gap-3 py-3 border-b border-bg-border last:border-0"><div className="text-accent font-mono font-bold">{n}</div><div><div className="font-bold text-fg">{title}</div><div className="text-sm text-fg-muted mt-1 leading-relaxed">{children}</div></div></div>; }
