import type { Metadata } from "next";
import { Activity, Bot, CheckCircle2, Gauge, ShieldCheck, Workflow } from "lucide-react";
import { CtaLink } from "@/components/marketing/Cta";
import { Reveal } from "@/components/marketing/Reveal";
import { Eyebrow, Section, SectionHead } from "@/components/marketing/Section";
import { BOOKING_URL } from "@/lib/marketing/routes";

export const metadata: Metadata = {
  title: "AI command center",
  description: "See the operating layer OASIS uses to coordinate agents, approvals, workflows, and business outcomes in one place.",
  alternates: { canonical: "/command-center" },
};

const MODULES = [
  { icon: Bot, title: "One roster", body: "Every agent has a role, tools, memory, and a visible owner." },
  { icon: Workflow, title: "One operating queue", body: "Leads, projects, approvals, and follow-up move through the same system." },
  { icon: ShieldCheck, title: "Human control where it matters", body: "Money, outbound sends, and destructive actions stop for approval." },
  { icon: Gauge, title: "Measured outcomes", body: "The dashboard shows what ran, what changed, and what needs attention." },
];

export default function CommandCenterPage() {
  const demoHref = BOOKING_URL || "/contact";
  return (
    <>
      <section className="m-edge relative overflow-hidden">
        <div className="mx-auto w-full max-w-6xl px-5 pb-16 pt-20 sm:px-8 sm:pb-24 sm:pt-28">
          <Reveal><Eyebrow>OASIS Command Center</Eyebrow></Reveal>
          <Reveal delay={80}>
            <h1 className="mt-6 max-w-4xl font-display text-[clamp(2.5rem,7vw,5rem)] font-bold leading-[0.96] tracking-[-0.04em] text-fg">
              Your AI team needs an operating system, not another chat window.
            </h1>
          </Reveal>
          <Reveal delay={160}>
            <p className="mt-7 max-w-2xl text-[18px] leading-relaxed text-fg-muted">
              The Command Center is where agent work becomes accountable business work: assigned, permissioned, observable, and tied to a real next step.
            </p>
            <div className="mt-9"><CtaLink href={demoHref} external={Boolean(BOOKING_URL)}>See it live</CtaLink></div>
          </Reveal>
        </div>
      </section>
      <Section className="m-edge">
        <Reveal><SectionHead eyebrow="The operating layer" title="Everything your agents need to work as a team." /></Reveal>
        <div className="mt-12 grid gap-px overflow-hidden border border-ops-line bg-ops-line sm:grid-cols-2">
          {MODULES.map(({ icon: Icon, title, body }, index) => (
            <Reveal key={title} delay={index * 70}>
              <article className="h-full bg-ops-panel p-7 sm:p-9">
                <Icon className="h-7 w-7 text-signal" aria-hidden="true" />
                <h2 className="mt-6 font-display text-2xl font-semibold text-fg">{title}</h2>
                <p className="mt-3 leading-relaxed text-fg-muted">{body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </Section>
      <Section>
        <Reveal>
          <div className="grid gap-8 border border-ops-edge bg-ops-panel/90 p-7 sm:p-10 lg:grid-cols-[1fr_auto] lg:items-center">
            <div>
              <div className="flex items-center gap-3 text-status-engaged"><Activity className="h-5 w-5" aria-hidden="true" /><span className="font-data text-xs uppercase tracking-[0.2em]">Built in production</span></div>
              <h2 className="mt-4 font-display text-3xl font-bold text-fg">A working system, configured around your business.</h2>
              <ul className="mt-6 grid gap-3 text-fg-muted sm:grid-cols-2">
                {["Agent activity and approvals", "Lead and client workflows", "Shared business memory", "Health and performance signals"].map((item) => <li key={item} className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-status-engaged" aria-hidden="true" />{item}</li>)}
              </ul>
            </div>
            <CtaLink href="/pricing" variant="secondary">View build tiers</CtaLink>
          </div>
        </Reveal>
      </Section>
    </>
  );
}
