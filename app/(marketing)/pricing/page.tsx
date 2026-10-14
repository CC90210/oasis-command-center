import type { Metadata } from "next";
import { Check } from "lucide-react";
import { PricingCheckout } from "@/components/marketing/PricingCheckout";
import { Reveal } from "@/components/marketing/Reveal";
import { Eyebrow, Section } from "@/components/marketing/Section";
import { CHECKOUT_OFFERS } from "@/lib/checkout/catalog";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Transparent CAD pricing for an AI conversion audit, autonomous sales setter, or custom enterprise agent fleet.",
  alternates: { canonical: "/pricing" },
};

export default function PricingPage() {
  return (
    <>
      <section className="m-edge relative overflow-hidden">
        <div className="mx-auto w-full max-w-6xl px-5 pb-16 pt-20 sm:px-8 sm:pb-20 sm:pt-28">
          <Reveal><Eyebrow>Transparent build tiers</Eyebrow></Reveal>
          <Reveal delay={90}>
            <h1 className="mt-6 max-w-4xl font-display text-[clamp(2.4rem,7vw,4.8rem)] font-bold leading-[0.98] tracking-[-0.035em] text-fg">
              Start with the smallest system that changes the result.
            </h1>
            <p className="mt-6 max-w-2xl text-[18px] leading-relaxed text-fg-muted">
              Pick the scope that matches the job. Every checkout is a one-time CAD payment and every build begins with a confirmed implementation plan.
            </p>
          </Reveal>
        </div>
      </section>
      <Section>
        <div className="grid items-start gap-6 lg:grid-cols-3">
          {CHECKOUT_OFFERS.map((offer, index) => (
            <Reveal key={offer.id} delay={index * 90}>
              <article id={offer.id} className={`scroll-mt-24 border p-6 sm:p-7 ${offer.featured ? "border-signal bg-ops-panel shadow-[0_0_50px_rgba(0,212,255,0.08)]" : "border-ops-edge bg-ops-panel/90"}`}>
                <p className="font-data text-[10px] uppercase tracking-[0.22em] text-signal">{offer.shortName}</p>
                <h2 className="mt-4 font-display text-2xl font-bold leading-tight text-fg">{offer.name}</h2>
                <p className="mt-4 font-display text-2xl font-semibold text-fg">{offer.rangeLabel}</p>
                <p className="mt-4 min-h-24 leading-relaxed text-fg-muted">{offer.summary}</p>
                <ul className="mt-6 space-y-3 border-t border-ops-line pt-6 text-sm text-fg-muted">
                  {offer.includes.map((item) => <li key={item} className="flex gap-2.5"><Check className="mt-0.5 h-4 w-4 shrink-0 text-status-engaged" aria-hidden="true" />{item}</li>)}
                </ul>
                <PricingCheckout offer={offer} />
              </article>
            </Reveal>
          ))}
        </div>
        <p className="mx-auto mt-10 max-w-3xl text-center text-sm leading-relaxed text-fg-dim">
          Enterprise work above $15,000 is scoped by proposal. Taxes, if applicable, are calculated and documented during kickoff.
        </p>
      </Section>
    </>
  );
}
