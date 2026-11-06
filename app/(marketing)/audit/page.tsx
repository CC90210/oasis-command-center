import type { Metadata } from "next";
import { CtaLink } from "@/components/marketing/Cta";
import { Reveal } from "@/components/marketing/Reveal";
import { Section, SectionHead, Eyebrow } from "@/components/marketing/Section";
import { AuditForm } from "@/components/marketing/AuditForm";

export const metadata: Metadata = {
  title: "Free Business AI Audit",
  description:
    "Four questions about how your business runs. We come back with where an agent pays for itself first, and where it doesn't. Takes about two minutes.",
  alternates: { canonical: "/audit" },
};

const WHAT_YOU_GET = [
  {
    title: "Where an agent pays for itself first",
    body: "The one job that costs more in people-hours than it would in build time. Not a generic list — the specific function in your business that is the best first seat.",
  },
  {
    title: "What to leave alone",
    body: "Some work needs judgement that can't be delegated, or the risk isn't worth the automation. We tell you that on the first call, not after the invoice.",
  },
  {
    title: "A fixed number",
    body: "You get a fixed price before anything is committed, and it doesn't move afterwards. No hourly billing, no scope creep, no surprise maintenance fees.",
  },
  {
    title: "The honest answer",
    body: "If your business isn't a good fit for automation yet, we'll say so. The audit is free because it's the right first step for both of us — not a lead-in to a pitch.",
  },
];

export default function AuditPage() {
  return (
    <>
      <section className="m-edge relative overflow-hidden">
        <div className="relative mx-auto w-full max-w-6xl px-5 pb-16 pt-20 sm:px-8 sm:pb-20 sm:pt-28">
          <Reveal>
            <Eyebrow>Free audit</Eyebrow>
          </Reveal>
          <Reveal delay={90}>
            <h1 className="mt-6 max-w-3xl font-display text-[clamp(2.2rem,6vw,3.8rem)] font-bold leading-[1.04] tracking-[-0.02em] text-fg">
              What&rsquo;s worth automating in your business?
            </h1>
          </Reveal>
          <Reveal delay={180}>
            <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-fg-muted">
              Four questions about how your work actually moves. We read every
              response and come back with where an agent would pay for itself
              first — including if the answer is &ldquo;nowhere yet.&rdquo;
            </p>
          </Reveal>
        </div>
      </section>

      <Section className="m-edge">
        <Reveal>
          <SectionHead
            eyebrow="What you get"
            title="A real answer, not a sales deck."
            lede="The audit is free because it's the right first step for both of us. Here's what comes back."
          />
        </Reveal>

        <div className="mt-12 grid gap-px border border-ops-line bg-ops-line sm:grid-cols-2">
          {WHAT_YOU_GET.map((item, i) => (
            <Reveal key={item.title} delay={(i % 2) * 80}>
              <article className="h-full bg-ops-void p-7">
                <h3 className="font-display text-base font-bold leading-snug tracking-tight text-fg">
                  {item.title}
                </h3>
                <p className="mt-3 text-[15px] leading-relaxed text-fg-muted">
                  {item.body}
                </p>
              </article>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section>
        <Reveal>
          <div className="border border-ops-edge bg-ops-panel/80 p-6 backdrop-blur-sm sm:p-8">
            <Eyebrow>Start here</Eyebrow>
            <h2 className="mt-5 font-display text-[clamp(1.5rem,3vw,2rem)] font-bold leading-[1.1] tracking-tight text-fg">
              Tell us what&rsquo;s eating your week.
            </h2>
            <p className="mt-4 max-w-md text-[15px] leading-relaxed text-fg-muted">
              Three more screens after this. Takes about two minutes.
            </p>
            <div className="mt-8">
              <AuditForm />
            </div>
            <p className="mt-6 flex items-center gap-2 text-[14px] text-fg-dim">
              Prefer to talk? <CtaLink href="/contact" variant="secondary" arrow={false}>Book a call</CtaLink>
            </p>
          </div>
        </Reveal>
      </Section>
    </>
  );
}
