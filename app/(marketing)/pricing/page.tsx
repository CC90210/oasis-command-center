import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CtaLink, CTA_INLINE } from "@/components/marketing/Cta";
import { Reveal } from "@/components/marketing/Reveal";
import { Section, SectionHead, Eyebrow } from "@/components/marketing/Section";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Transparent engagement tiers. Fixed pricing before anything is committed. Running costs quoted separately so you can see what the system costs to own.",
  alternates: { canonical: "/pricing" },
};

const TIERS = [
  {
    name: "Conversion Audit & Optimization Sprint",
    price: "$1,500 – $2,500",
    body: "A focused two-week sprint to find and fix the leaks in your current funnel. We audit your existing tools, identify the highest-impact fixes, and implement them with you.",
    detail: [
      "Full funnel audit (capture → nurture → close)",
      "Speed-to-lead and response-time optimization",
      "Conversion rate diagnosis and fix implementation",
      "Prioritized roadmap for further optimization",
      "Fixed price, defined scope, two-week delivery",
    ],
  },
  {
    name: "Autonomous AI Sales Setter & Speed-to-Lead System",
    price: "$3,500 – $5,000",
    body: "A custom agent that captures, qualifies, and follows up with leads 24/7. Integrated with your existing CRM, email, and calendar. Responses in under 60 seconds.",
    detail: [
      "Custom AI sales setter agent",
      "CRM and calendar integration",
      "Lead qualification and scoring",
      "Automated follow-up sequences",
      "Performance dashboard and reporting",
      "Guardrails scoped with you",
    ],
    featured: true,
  },
  {
    name: "Custom Enterprise AI Operating System / Agent Fleet",
    price: "$7,500 – $15,000+",
    body: "A full multi-agent operation with shared state, reporting, and coordination. Several seats working together, each owning a function, with the systems underneath making it survive contact with your business.",
    detail: [
      "Multi-agent fleet (3+ seats)",
      "Custom command center build",
      "Shared state and coordination layer",
      "Full integration with your existing tools",
      "Roles, permissions, and guardrails",
      "Staged rollout, function by function",
      "Ongoing tuning against real usage",
    ],
  },
];

const PRINCIPLES = [
  {
    title: "Fixed price before commitment",
    body: "You get a fixed number before anything is committed, and it doesn't move afterwards. No hourly billing, no scope creep.",
  },
  {
    title: "Running costs quoted separately",
    body: "Hosting, model usage, and maintenance are quoted separately and monthly, so you can see what the system costs to own rather than only what it cost to build.",
  },
  {
    title: "No lock-in",
    body: "The system you build is yours. The code, the data, the configurations — if we ever part ways, you keep all of it.",
  },
];

export default function PricingPage() {
  return (
    <>
      <section className="m-edge relative overflow-hidden">
        <div className="relative mx-auto w-full max-w-6xl px-5 pb-16 pt-20 sm:px-8 sm:pb-20 sm:pt-28">
          <Reveal>
            <Eyebrow>Pricing</Eyebrow>
          </Reveal>
          <Reveal delay={90}>
            <h1 className="mt-6 max-w-3xl font-display text-[clamp(2.2rem,6vw,3.8rem)] font-bold leading-[1.04] tracking-[-0.02em] text-fg">
              Transparent tiers. Fixed pricing.
            </h1>
          </Reveal>
          <Reveal delay={180}>
            <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-fg-muted">
              Scope decides price. These are starting points, not packages.
              You&rsquo;ll get a fixed number before anything is committed, and
              it won&rsquo;t move afterwards.
            </p>
          </Reveal>
        </div>
      </section>

      <Section className="m-edge">
        <Reveal>
          <SectionHead
            eyebrow="Engagement tiers"
            title="Three ways in."
            lede="Every engagement starts with a free audit. The right tier depends on what you need automated and how fast you need it running."
          />
        </Reveal>

        <div className="mt-12 grid gap-px border border-ops-line bg-ops-line lg:grid-cols-3">
          {TIERS.map((tier, i) => (
            <Reveal key={tier.name} delay={i * 90}>
              <article
                className={`flex h-full flex-col p-7 ${
                  tier.featured ? "bg-ops-panel" : "bg-ops-void"
                }`}
              >
                {tier.featured ? (
                  <span className="mb-4 inline-block w-fit border border-signal/40 bg-signal-wash px-2.5 py-1 font-data text-[9px] uppercase tracking-[0.2em] text-signal">
                    Most popular
                  </span>
                ) : null}
                <h3 className="font-display text-lg font-bold tracking-tight text-fg">
                  {tier.name}
                </h3>
                <p className="mt-2 font-display text-2xl font-bold tracking-tight text-signal">
                  {tier.price}
                </p>
                <p className="mt-4 text-[15px] leading-relaxed text-fg-muted">
                  {tier.body}
                </p>
                <ul className="mt-6 flex-1 space-y-2.5">
                  {tier.detail.map((d) => (
                    <li
                      key={d}
                      className="flex gap-3 text-[14px] leading-relaxed text-fg-muted"
                    >
                      <span
                        aria-hidden="true"
                        className="mt-[0.55rem] h-px w-3 shrink-0 bg-signal-dim"
                      />
                      <span>{d}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  href="/contact"
                  className={`mt-7 ${CTA_INLINE}`}
                >
                  Get started
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </article>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section className="m-edge">
        <Reveal>
          <SectionHead
            eyebrow="How we price"
            title="Three principles."
            lede="No hourly billing. No surprise fees. No lock-in."
          />
        </Reveal>

        <div className="mt-12 grid gap-px border border-ops-line bg-ops-line md:grid-cols-3">
          {PRINCIPLES.map((p, i) => (
            <Reveal key={p.title} delay={i * 90}>
              <article className="h-full bg-ops-void p-7">
                <h3 className="font-display text-base font-bold tracking-tight text-fg">
                  {p.title}
                </h3>
                <p className="mt-3 text-[15px] leading-relaxed text-fg-muted">
                  {p.body}
                </p>
              </article>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section>
        <Reveal>
          <div className="border border-ops-line bg-ops-panel p-8 sm:p-12">
            <Eyebrow>Next step</Eyebrow>
            <h2 className="mt-5 max-w-2xl font-display text-[clamp(1.7rem,3.4vw,2.5rem)] font-bold leading-[1.1] tracking-tight text-fg">
              Start with the free audit.
            </h2>
            <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-fg-muted">
              Four questions about how your business runs. We come back with
              where an agent pays for itself first, and a fixed number for
              the build.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <CtaLink href="/audit">Start the audit</CtaLink>
              <CtaLink href="/contact" variant="secondary" arrow={false}>
                Book a call
              </CtaLink>
            </div>
          </div>
        </Reveal>
      </Section>
    </>
  );
}
