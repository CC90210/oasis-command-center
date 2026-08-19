"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Copy, Phone, ShieldCheck } from "lucide-react";
import { Card, PageHeader, Tag } from "@/components/Card";

const TRACKS = {
  trades: { label: "Trades", problem: "people cannot quickly call or request a quote on mobile", result: "more calls and quote requests" },
  professional: { label: "Professional services", problem: "the site does not build trust or make the next step obvious", result: "more qualified inquiries" },
  wellness: { label: "Wellness & beauty", problem: "booking and reviews are hard to find on a phone", result: "more bookings" },
  home_services: { label: "Home services", problem: "the site does not show enough proof or make estimates easy", result: "more estimate requests" },
} as const;

const OBJECTIONS = [
  ["Send me something", "Absolutely. What would be most useful: the website issue I noticed, or a couple of ideas to improve it? Great — I’ll note that for CC or Adon. Let’s also grab 15 minutes so they can show you instead of sending another generic PDF."],
  ["We already have a website person", "That makes sense. I’m not asking you to replace them today. I only noticed [issue]. Is that already being fixed, or has it been sitting there?"],
  ["How much is it?", "Projects start around $2,000, but I don’t scope or price them. My job is to see if the problem is real. CC or Adon can show you the right option on the Meet."],
  ["I’m busy", "No problem. Is later today better, or should I call tomorrow?"],
  ["Not interested", "Totally fair. Before I go — is that because the website is already working well, or because improving it is not a priority right now?"],
  ["We get business from referrals", "That’s a good position to be in. When those referrals look you up before calling, does the website help confirm the recommendation?"],
] as const;

export default function ScriptPage() {
  const [track, setTrack] = useState<keyof typeof TRACKS>("trades");
  const selected = TRACKS[track];
  const opener = `Hey [Name], it’s [Your name] from OASIS. This is a cold call — I’ll be quick. I was looking at [Company] and noticed [one real website problem]. Can I explain what I saw in 20 seconds?`;

  return <div className="space-y-5 animate-fade-in pb-12">
    <Link href="/playbook" className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-accent"><ArrowLeft size={14}/> Playbook</Link>
    <PageHeader title="The Easy Website Call Guide" subtitle="Your job is not to close. Find a real problem, have a normal conversation, and book a Google Meet with CC or Adon." action={<Tag tone="accent">Agent guide</Tag>}/>

    <div className="rounded-lg border border-accent/35 bg-accent/5 p-4">
      <div className="flex gap-3"><ShieldCheck className="h-5 w-5 shrink-0 text-accent"/><div><div className="font-bold text-fg">Remember this</div><p className="mt-1 text-sm leading-relaxed text-fg-muted">You do not need to sound like an expert. Be curious, speak slowly, and use the words on this page. A good call ends with a booked meeting or a clear next step — not a sale.</p></div></div>
    </div>

    <Card title="1. Take 60 seconds before you call" subtitle="Never call without one real observation.">
      <div className="grid gap-2 md:grid-cols-2">{["Open their website on your phone.", "Pick one obvious problem — not five.", "Know the owner’s name and business type.", "Have the Pipeline lead open so you can record the result."].map((item) => <div key={item} className="flex gap-2 rounded-md border border-bg-border bg-bg-elev/30 p-3 text-sm text-fg-muted"><Check className="mt-0.5 h-4 w-4 shrink-0 text-status-engaged"/>{item}</div>)}</div>
      <div className="mt-4 flex flex-wrap gap-2">{Object.entries(TRACKS).map(([key,value]) => <button key={key} onClick={() => setTrack(key as keyof typeof TRACKS)} className={`rounded-md px-3 py-2 text-sm font-semibold ${track === key ? "bg-accent text-bg-deep" : "border border-bg-border bg-bg-elev text-fg-muted hover:text-fg"}`}>{value.label}</button>)}</div>
      <p className="mt-3 text-sm text-fg-muted"><b className="text-fg">Look for:</b> {selected.problem}. <b className="text-fg">The outcome:</b> {selected.result}.</p>
    </Card>

    <Card title="2. Say this" subtitle="Do not memorize it perfectly. Keep the structure and sound like yourself." action={<CopyLine text={opener}/> }>
      <Talk label="Open honestly">{opener}</Talk>
      <Talk label="Explain why it matters">“The reason I called is that when someone checks you out on their phone, [problem] can make it harder for them to [call / book / request a quote]. Is the website bringing you many leads right now?”</Talk>
      <Talk label="Ask, then listen">“If you could improve one thing about the website or how new leads come in, what would it be?”</Talk>
      <Talk label="Check who decides">“Would you be the person who decides whether to improve it?”</Talk>
      <Talk label="Check timing and budget">“Is this something you would want to improve in the next few months?” Then: “If the right solution started around $2,000, would it be worth seeing what that could look like?”</Talk>
      <Talk label="Book the Meet">“That sounds worth a proper look. CC and Adon handle the audit and options. I can book you a quick Google Meet so they can show you exactly what they would change. Is [time A] or [time B] better?”</Talk>
    </Card>

    <Card title="3. If the conversation gets awkward" subtitle="Pause. Pick the closest answer. Do not argue.">
      <div className="space-y-3">{OBJECTIONS.map(([objection,response]) => <details key={objection} className="group rounded-lg border border-bg-border bg-bg-elev/25"><summary className="cursor-pointer list-none px-4 py-3 text-sm font-bold text-fg">“{objection}” <span className="float-right text-accent group-open:rotate-45">+</span></summary><div className="border-t border-bg-border px-4 py-3 text-sm leading-relaxed text-fg-muted">{response}</div></details>)}</div>
    </Card>

    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Gatekeeper"><p className="text-sm leading-relaxed text-fg">“Hey, I’m trying to reach whoever looks after the website and new customer inquiries. I noticed something specific on the site — who would be best to speak with?”</p></Card>
      <Card title="Voicemail"><p className="text-sm leading-relaxed text-fg">“Hi [Name], it’s [Your name] from OASIS. I noticed [specific issue] on [Company]’s website that may be making it harder for people to [call / book / request a quote]. I’ll try you again [day/time].”</p><p className="mt-2 text-xs text-fg-muted">In Pipeline: choose <b>Voicemail left</b> and set the exact callback time.</p></Card>
    </div>

    <Card title="4. Finish the handoff" subtitle="The meeting is only useful if CC or Adon knows what was promised.">
      <ol className="grid gap-2 text-sm text-fg-muted md:grid-cols-2"><li className="rounded-md border border-bg-border p-3"><b className="text-fg">1.</b> Confirm all four qualification boxes.</li><li className="rounded-md border border-bg-border p-3"><b className="text-fg">2.</b> Open the Google Meet calendar from the lead.</li><li className="rounded-md border border-bg-border p-3"><b className="text-fg">3.</b> Select CC or Adon and save the meeting time.</li><li className="rounded-md border border-bg-border p-3"><b className="text-fg">4.</b> Write one sentence: “Show them how we would fix ___ so they get more ___.”</li></ol>
      <div className="mt-4 rounded-md border border-status-warm/30 bg-status-warm/5 p-3 text-sm text-fg-muted"><b className="text-fg">Never promise:</b> a discount, exact delivery date, custom feature, automation feasibility, or guaranteed results. Say: “CC or Adon will confirm that on the Meet.”</div>
    </Card>

    <Card title="What good sounds like" subtitle="Calm, short, and specific."><div className="flex gap-3"><Phone className="h-5 w-5 shrink-0 text-status-engaged"/><p className="text-sm leading-relaxed text-fg-muted">You noticed one real issue. The owner agreed it matters. You confirmed they can decide, have reasonable timing, and would consider the starting investment. Then you booked the Meet and wrote a clean handoff. That is a successful call.</p></div></Card>
  </div>;
}

function Talk({label,children}:{label:string;children:React.ReactNode}) { return <div className="grid gap-1 border-b border-bg-border py-4 last:border-0 md:grid-cols-[10rem_1fr]"><div className="text-xs font-bold uppercase tracking-wider text-accent">{label}</div><div className="text-[15px] leading-7 text-fg">{children}</div></div>; }
function CopyLine({text}:{text:string}) { const [copied,setCopied] = useState(false); return <button onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false),1500); }} className="inline-flex items-center gap-1.5 rounded-md border border-bg-border px-2.5 py-1.5 text-xs text-fg-muted hover:text-fg"><Copy size={13}/>{copied ? "Copied" : "Copy opener"}</button>; }
