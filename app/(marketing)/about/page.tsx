import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CtaLink, CTA_INLINE } from "@/components/marketing/Cta";
import { ConsoleField } from "@/components/marketing/ConsoleField";
import { Reveal } from "@/components/marketing/Reveal";
import { Section, SectionHead, Eyebrow } from "@/components/marketing/Section";
import { LEGAL_ENTITY } from "@/lib/legal/constants";

/**
 * /about — who this is and how they work.
 *
 * Entity name and location come from lib/legal/constants.ts. Do not retype
 * them: this page and /privacy making different claims about where the
 * company is based is exactly the kind of drift that legal file exists to
 * prevent.
 */

export const metadata: Metadata = {
  title: "About",
  description:
    "OASIS AI Solutions — Operational Agentic Systems Increasing Scalability. We build AI agents and the systems they run on, for clients internationally. How we work and what we won't do.",
  alternates: { canonical: "/about" },
};

const PRINCIPLES = [
  {
    title: "Leverage over effort",
    body: "The measure is not how hard the system works, it's how much of your week comes back. If a build doesn't return time or revenue you can point at, it wasn't worth doing.",
  },
  {
    title: "Proof over claims",
    body: "Nothing ships on 'should work'. It ships with the test output, the live check, or the row in the database that proves it. This applies to what we tell you as much as to the code.",
  },
  {
    title: "You keep the keys",
    body: "Your data stays in your infrastructure, under your account, with row-level access control. If you ever fire us you keep the system, because it was always yours.",
  },
  {
    title: "We'll tell you not to buy it",
    body: "Some jobs shouldn't be automated yet, and some businesses aren't ready. Saying so costs one sale and saves a bad one, and we'd rather have the reputation than the invoice.",
  },
];

export default function AboutPage() {
  return (
    <>
      <section className="m-edge relative overflow-hidden">
        <ConsoleField />
        <div className="relative mx-auto w-full max-w-6xl px-5 pb-16 pt-20 sm:px-8 sm:pb-20 sm:pt-28">
          <Reveal>
            <Eyebrow>About</Eyebrow>
          </Reveal>
          <Reveal delay={90}>
            <h1 className="mt-6 max-w-3xl font-display text-[clamp(2.2rem,6vw,3.8rem)] font-bold leading-[1.04] tracking-[-0.02em] text-fg">
              We run our own company on this.
            </h1>
          </Reveal>
          <Reveal delay={180}>
            <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-fg-muted">
              {LEGAL_ENTITY} — Operational Agentic Systems Increasing
              Scalability — builds AI agents and the systems they run on, for
              clients wherever they are. The agents on this site aren&rsquo;t
              a product roadmap; they&rsquo;re the staff that runs the studio,
              which is the only honest reason to sell them to anyone else.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── The story ────────────────────────────────────────────────── */}
      <Section className="m-edge">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16">
          <Reveal>
            <SectionHead eyebrow="Why this exists" title="Small teams got priced out of good systems." />
          </Reveal>
          <Reveal delay={120}>
            <div className="space-y-5 text-[16px] leading-relaxed text-fg-muted sm:text-[17px]">
              <p>
                The tooling that makes a large company efficient — the internal
                portal, the pipeline that never drops a lead, the reporting
                that arrives without anyone building it — has always existed.
                It was just priced for companies with a department to run it.
              </p>
              <p>
                What changed is that a competent agent can now hold the seat
                that department used to fill. A five-person business can run on
                infrastructure that used to need fifty, and the gap between
                what a small team can do and what a large one can do collapses.
              </p>
              <p>
                We build that infrastructure, and we test it on ourselves
                first. Every agent on this site was built because we needed it
                to run this business, not because it looked good on a page.
              </p>
              <p className="text-fg">
                That&rsquo;s also the honest limit of what we&rsquo;ll claim:
                we&rsquo;ll tell you what these systems do because we watch them
                do it every day.
              </p>
            </div>
          </Reveal>
        </div>
      </Section>

      {/* ── Principles ───────────────────────────────────────────────── */}
      <Section className="m-edge">
        <Reveal>
          <SectionHead
            eyebrow="How we work"
            title="Four commitments, and what they cost us."
          />
        </Reveal>

        <div className="mt-12 grid gap-px border border-ops-line bg-ops-line sm:grid-cols-2">
          {PRINCIPLES.map((p, i) => (
            <Reveal key={p.title} delay={i * 80}>
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

      {/* ── Where we are ─────────────────────────────────────────────── */}
      <Section className="m-edge">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
          <Reveal>
            <SectionHead
              eyebrow="Where we are"
              title="Wherever you are."
              lede="Clients are on whichever continent they happen to be on. The work happens over video, shared systems, and the portal we hand you — being in the same city has never once been the thing that made a build succeed."
            />
          </Reveal>
          <Reveal delay={120}>
            <div className="space-y-5 text-[16px] leading-relaxed text-fg-muted sm:text-[17px]">
              <p>
                We&rsquo;re registered in Canada, which is mostly relevant for
                one reason: Canadian and Quebec privacy law is strict, and
                building to it as the floor means the handling standard
                travels with you rather than being retrofitted the first time
                a client&rsquo;s counsel asks a hard question.
              </p>
              <p>
                What we publish about data handling is on the record: which
                third parties process what, how long it&rsquo;s kept, and where
                the gaps still are. It&rsquo;s generated from what the software
                actually does rather than written by a template.
              </p>
              <Link
                href="/privacy"
                className={CTA_INLINE}
              >
                Read the data policy
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
          </Reveal>
        </div>
      </Section>

      {/* ── CTA ──────────────────────────────────────────────────────── */}
      <Section>
        <Reveal>
          <div className="border border-ops-line bg-ops-panel p-8 sm:p-12">
            <Eyebrow>Talk to us</Eyebrow>
            <h2 className="mt-5 max-w-2xl font-display text-[clamp(1.7rem,3.4vw,2.5rem)] font-bold leading-[1.1] tracking-tight text-fg">
              Start with the problem, not the product.
            </h2>
            <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-fg-muted">
              Tell us what your week actually looks like. We&rsquo;ll tell you
              which part of it a machine should be doing.
            </p>
            <CtaLink href="/contact" className="mt-8">
              Start the audit
            </CtaLink>
          </div>
        </Reveal>
      </Section>
    </>
  );
}
