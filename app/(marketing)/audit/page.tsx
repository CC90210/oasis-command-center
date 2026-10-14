import type { Metadata } from "next";
import { BarChart3, Clock3, Route } from "lucide-react";
import { AuditForm } from "@/components/marketing/AuditForm";
import { CtaLink } from "@/components/marketing/Cta";
import { Reveal } from "@/components/marketing/Reveal";
import { Eyebrow, Section } from "@/components/marketing/Section";
import { resolveConsentIdentity } from "@/lib/consent/ledger-identity";
import { AUDIT_FUNNEL, BOOKING_URL } from "@/lib/marketing/routes";

export const metadata: Metadata = {
  title: "Free business AI audit",
  description: "A practical three-step intake that finds where AI can remove delay, recover leads, and create measurable capacity in your business.",
  alternates: { canonical: "/audit" },
};

const STEPS = [
  { icon: Clock3, title: "Name the bottleneck", body: "Show us where leads wait, work repeats, or decisions pile up." },
  { icon: Route, title: "Map the handoffs", body: "We trace the systems and people the fix has to connect without breaking." },
  { icon: BarChart3, title: "Rank the return", body: "You get the first build worth doing, the expected operational lift, and the next step." },
];

export default function AuditPage() {
  const consentIdentity = resolveConsentIdentity({ tenantSlug: AUDIT_FUNNEL.tenantSlug }).identity;
  return (
    <>
      <section className="m-edge relative overflow-hidden">
        <div className="mx-auto grid w-full max-w-6xl gap-12 px-5 pb-16 pt-20 sm:px-8 sm:pb-20 sm:pt-28 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
          <Reveal>
            <div>
              <Eyebrow>Free business AI audit</Eyebrow>
              <h1 className="mt-6 font-display text-[clamp(2.4rem,7vw,4.6rem)] font-bold leading-[0.98] tracking-[-0.035em] text-fg">
                Find the work your next agent should own.
              </h1>
              <p className="mt-6 max-w-xl text-[18px] leading-relaxed text-fg-muted">
                A short intake, an honest diagnosis, and a build recommendation tied to time, revenue, or response speed. No generic AI wish list.
              </p>
              {BOOKING_URL ? (
                <div className="mt-8"><CtaLink href={BOOKING_URL} external>Book a strategy call</CtaLink></div>
              ) : null}
            </div>
          </Reveal>
          <Reveal delay={100}>
            <div id="apply" className="scroll-mt-24 border border-ops-edge bg-ops-panel/90 p-6 backdrop-blur sm:p-8">
              <p className="mb-6 font-data text-[10px] uppercase tracking-[0.24em] text-signal">Start the three-step audit</p>
              <AuditForm consentIdentity={consentIdentity} />
            </div>
          </Reveal>
        </div>
      </section>
      <Section>
        <div className="grid gap-px overflow-hidden border border-ops-line bg-ops-line md:grid-cols-3">
          {STEPS.map(({ icon: Icon, title, body }, index) => (
            <Reveal key={title} delay={index * 80}>
              <article className="h-full bg-ops-panel p-7">
                <Icon className="h-6 w-6 text-signal" aria-hidden="true" />
                <p className="mt-6 font-data text-[10px] uppercase tracking-[0.22em] text-fg-dim">Step {index + 1}</p>
                <h2 className="mt-3 font-display text-xl font-semibold text-fg">{title}</h2>
                <p className="mt-3 leading-relaxed text-fg-muted">{body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </Section>
    </>
  );
}
