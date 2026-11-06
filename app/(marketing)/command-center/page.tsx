import type { Metadata } from "next";
import { CtaLink } from "@/components/marketing/Cta";
import { Reveal } from "@/components/marketing/Reveal";
import { Section, SectionHead, Eyebrow } from "@/components/marketing/Section";

export const metadata: Metadata = {
  title: "AI Command Center",
  description:
    "The operating system for your AI agents. Pipeline, records, documents, roles, permissions, and the daily ops plan — all in one place. See it live.",
  alternates: { canonical: "/command-center" },
};

const FEATURES = [
  {
    name: "Pipeline & records",
    body: "Every lead, client, and deal in one pipeline. Each record carries its full history — emails, calls, documents, notes — so nobody has to reconstruct what happened from memory.",
  },
  {
    name: "Documents & extraction",
    body: "Statements, applications, contracts, and purchase orders read, extracted, checked, and filed. The part of the job that is currently a person and a highlighter.",
  },
  {
    name: "Roles & permissions",
    body: "Owners, admins, operators, and viewers. Each sees exactly what they need and nothing more. Enforced in code, not in a prompt.",
  },
  {
    name: "Daily ops plan",
    body: "Every morning, the system tells each seat what to do. Not a static checklist — a live plan built from what actually happened yesterday and what's due today.",
  },
  {
    name: "Comms & inbox",
    body: "Email that gets read, classified, and drafted against your actual history. Escalation rules so the things that matter reach you and the rest doesn't.",
  },
  {
    name: "Reporting & metrics",
    body: "Conversion rates, response times, pipeline value, agent activity. The numbers that tell you whether the system is earning its keep, in real time.",
  },
];

export default function CommandCenterPage() {
  return (
    <>
      <section className="m-edge relative overflow-hidden">
        <div className="relative mx-auto w-full max-w-6xl px-5 pb-16 pt-20 sm:px-8 sm:pb-20 sm:pt-28">
          <Reveal>
            <Eyebrow>Command Center</Eyebrow>
          </Reveal>
          <Reveal delay={90}>
            <h1 className="mt-6 max-w-3xl font-display text-[clamp(2.2rem,6vw,3.8rem)] font-bold leading-[1.04] tracking-[-0.02em] text-fg">
              The system your agents live in.
            </h1>
          </Reveal>
          <Reveal delay={180}>
            <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-fg-muted">
              Agents are only as good as the system around them. The Command
              Center is the operating system — pipeline, records, documents,
              roles, and the daily plan — that turns a demo into a deployment.
            </p>
          </Reveal>
          <Reveal delay={270}>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <CtaLink href="/login">See it live</CtaLink>
              <CtaLink href="/contact" variant="secondary" arrow={false}>
                Book a demo
              </CtaLink>
            </div>
          </Reveal>
        </div>
      </section>

      <Section className="m-edge">
        <Reveal>
          <SectionHead
            eyebrow="What's inside"
            title="Six systems, one command center."
            lede="Most tools do one of these well. The Command Center wires them together so the whole operation runs from a single screen."
          />
        </Reveal>

        <div className="mt-12 grid gap-px border border-ops-line bg-ops-line sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <Reveal key={f.name} delay={(i % 3) * 80}>
              <article className="h-full bg-ops-void p-7">
                <h3 className="font-display text-base font-bold tracking-tight text-fg">
                  {f.name}
                </h3>
                <p className="mt-3 text-[15px] leading-relaxed text-fg-muted">
                  {f.body}
                </p>
              </article>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section>
        <Reveal>
          <div className="border border-ops-line bg-ops-panel p-8 sm:p-12">
            <Eyebrow>Live demo</Eyebrow>
            <h2 className="mt-5 max-w-2xl font-display text-[clamp(1.7rem,3.4vw,2.5rem)] font-bold leading-[1.1] tracking-tight text-fg">
              Sign in and see your own workspace.
            </h2>
            <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-fg-muted">
              The demo workspace is pre-loaded with sample data — pipeline,
              records, documents, and agent activity. Explore it the way you
              would your own.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <CtaLink href="/login">Open the demo</CtaLink>
              <CtaLink href="/work" variant="secondary" arrow={false}>
                See what we build
              </CtaLink>
            </div>
          </div>
        </Reveal>
      </Section>
    </>
  );
}
