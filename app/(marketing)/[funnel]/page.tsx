import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AuditForm } from "@/components/marketing/AuditForm";
import { CtaLink } from "@/components/marketing/Cta";
import { PricingCheckout } from "@/components/marketing/PricingCheckout";
import { PurchaseConversion } from "@/components/marketing/PurchaseConversion";
import { Reveal } from "@/components/marketing/Reveal";
import { Eyebrow, Section, SectionHead } from "@/components/marketing/Section";
import { CHECKOUT_OFFERS, resolveCheckoutOffer } from "@/lib/checkout/catalog";
import { verifyOfferCheckout } from "@/lib/checkout/stripe";
import { resolveConsentIdentity } from "@/lib/consent/ledger-identity";
import { AUDIT_FUNNEL, BOOKING_URL } from "@/lib/marketing/routes";
import { googleAdsPurchaseDestination } from "@/lib/marketing/google-ads";
import { getSessionUser } from "@/lib/supabase-server";

const FUNNEL_METADATA = {
  audit: {
    title: "Free business AI audit",
    description: "A practical three-step intake that finds where AI can remove delay, recover leads, and create measurable capacity in your business.",
  },
  "command-center": {
    title: "AI command center",
    description: "See the operating layer OASIS uses to coordinate agents, approvals, workflows, and business outcomes in one place.",
  },
  pricing: {
    title: "Pricing",
    description: "Transparent CAD pricing for an AI conversion audit, autonomous sales setter, or custom enterprise agent fleet.",
  },
  onboarding: {
    title: "7-day turnkey onboarding",
    description: "Apply for OASIS AI's seven-day onboarding: scope, access, build, validation, training, and launch.",
  },
  "checkout-success": {
    title: "Payment received",
    description: "Your OASIS AI checkout confirmation.",
    robots: { index: false, follow: false },
  },
} as const;

type FunnelRoute = keyof typeof FUNNEL_METADATA;

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ funnel: string }> }): Promise<Metadata> {
  const route = (await params).funnel;
  const meta = FUNNEL_METADATA[route as FunnelRoute];
  if (!meta) return {};
  if (route === "checkout-success") return meta;
  return { ...meta, alternates: { canonical: `/${route}` } };
}

const AUDIT_STEPS = [
  { title: "Name the bottleneck", body: "Show us where leads wait, work repeats, or decisions pile up." },
  { title: "Map the handoffs", body: "We trace the systems and people the fix has to connect without breaking." },
  { title: "Rank the return", body: "You get the first build worth doing, the expected operational lift, and the next step." },
];

function AuditPage() {
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
              {BOOKING_URL ? <div className="mt-8"><CtaLink href={BOOKING_URL} external>Book a strategy call</CtaLink></div> : null}
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
          {AUDIT_STEPS.map(({ title, body }, index) => (
            <Reveal key={title} delay={index * 80}>
              <article className="h-full bg-ops-panel p-7">
                <span className="block h-1 w-8 bg-signal" aria-hidden="true" />
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

const COMMAND_MODULES = [
  { title: "One roster", body: "Every agent has a role, tools, memory, and a visible owner." },
  { title: "One operating queue", body: "Leads, projects, approvals, and follow-up move through the same system." },
  { title: "Human control where it matters", body: "Money, outbound sends, and destructive actions stop for approval." },
  { title: "Measured outcomes", body: "The dashboard shows what ran, what changed, and what needs attention." },
];

function CommandCenterPage() {
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
          {COMMAND_MODULES.map(({ title, body }, index) => (
            <Reveal key={title} delay={index * 70}>
              <article className="h-full bg-ops-panel p-7 sm:p-9">
                <span className="block h-2 w-2 bg-signal" aria-hidden="true" />
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
              <div className="flex items-center gap-3 text-status-engaged"><span className="h-2 w-2 bg-status-engaged" aria-hidden="true" /><span className="font-data text-xs uppercase tracking-[0.2em]">Built in production</span></div>
              <h2 className="mt-4 font-display text-3xl font-bold text-fg">A working system, configured around your business.</h2>
              <ul className="mt-6 grid gap-3 text-fg-muted sm:grid-cols-2">
                {["Agent activity and approvals", "Lead and client workflows", "Shared business memory", "Health and performance signals"].map((item) => <li key={item} className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 shrink-0 bg-status-engaged" aria-hidden="true" />{item}</li>)}
              </ul>
            </div>
            <CtaLink href="/pricing" variant="secondary">View build tiers</CtaLink>
          </div>
        </Reveal>
      </Section>
    </>
  );
}

function PricingPage() {
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
                  {offer.includes.map((item) => <li key={item} className="flex gap-2.5"><span className="mt-2 h-1.5 w-1.5 shrink-0 bg-status-engaged" aria-hidden="true" />{item}</li>)}
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

const ONBOARDING_DAYS = [
  ["Day 1", "Outcome map", "Confirm the business result, owner, guardrails, and launch metric."],
  ["Day 2", "Access and data", "Connect only the systems the build needs, with least-privilege access."],
  ["Days 3-4", "Build", "Configure the workflows, agent role, memory, and approval points."],
  ["Day 5", "Production-shaped test", "Run real scenarios safely and verify every handoff and fallback."],
  ["Day 6", "Team handoff", "Train the people who approve, review, and improve the system."],
  ["Day 7", "Launch", "Turn on the measured workflow with monitoring and a tuning cadence."],
] as const;

async function OnboardingPage() {
  const user = await getSessionUser().catch((error) => {
    console.error("[onboarding.public.session]", error);
    return null;
  });
  if (user) redirect("/onboarding/wizard");

  return (
    <>
      <section className="m-edge relative overflow-hidden">
        <div className="mx-auto w-full max-w-6xl px-5 pb-16 pt-20 sm:px-8 sm:pb-20 sm:pt-28">
          <Reveal><Eyebrow>7-day turnkey onboarding</Eyebrow></Reveal>
          <Reveal delay={80}>
            <h1 className="mt-6 max-w-4xl font-display text-[clamp(2.5rem,7vw,5rem)] font-bold leading-[0.96] tracking-[-0.04em] text-fg">
              From approved scope to a working system in one focused week.
            </h1>
            <p className="mt-7 max-w-2xl text-[18px] leading-relaxed text-fg-muted">
              The timeline stays short because the decisions are explicit: one outcome, named owners, controlled access, and a production test before launch.
            </p>
            <div className="mt-9"><CtaLink href="/audit#apply">Apply now</CtaLink></div>
          </Reveal>
        </div>
      </section>
      <Section>
        <div className="mx-auto max-w-3xl">
          {ONBOARDING_DAYS.map(([day, title, body], index) => (
            <Reveal key={day} delay={index * 55}>
              <article className="relative grid gap-4 border-x border-t border-ops-line bg-ops-panel/90 p-6 last:border-b sm:grid-cols-[7rem_1fr] sm:p-8">
                <p className="font-data text-xs uppercase tracking-[0.2em] text-signal">{day}</p>
                <div>
                  <h2 className="font-display text-2xl font-semibold text-fg">{title}</h2>
                  <p className="mt-2 leading-relaxed text-fg-muted">{body}</p>
                </div>
                {index < ONBOARDING_DAYS.length - 1 ? <span className="absolute -bottom-3 left-1/2 z-10 h-6 w-px bg-signal" aria-hidden="true" /> : null}
              </article>
            </Reveal>
          ))}
        </div>
      </Section>
      <Section className="m-edge">
        <Reveal>
          <div className="mx-auto max-w-3xl border border-status-engaged/30 bg-ops-panel p-7 sm:p-10">
            <div className="flex items-center gap-3 text-status-engaged"><span className="h-2 w-2 bg-status-engaged" aria-hidden="true" /><span className="font-data text-xs uppercase tracking-[0.2em]">Launch-ready handoff</span></div>
            <h2 className="mt-5 font-display text-3xl font-bold text-fg">You leave with ownership, evidence, and a next-30-day plan.</h2>
            <p className="mt-4 leading-relaxed text-fg-muted">No mystery black box. Your team knows what the system does, where it stops, how results are measured, and who to call when reality changes.</p>
            <div className="mt-8"><CtaLink href="/audit#apply">Apply now</CtaLink></div>
          </div>
        </Reveal>
      </Section>
    </>
  );
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function CheckoutSuccessPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = (await searchParams).session_id;
  const checkoutSessionId = typeof raw === "string" ? raw : "";
  const secretKey = (process.env.STRIPE_SECRET_KEY ?? "").trim();
  const conversionDestination = googleAdsPurchaseDestination(
    process.env.GOOGLE_ADS_PURCHASE_CONVERSION_DESTINATION,
  );

  try {
    if (!secretKey) throw new Error("stripe_not_connected");
    const receipt = await verifyOfferCheckout({ secretKey, checkoutSessionId, resolveOffer: resolveCheckoutOffer });
    if (!conversionDestination) {
      console.error("[public-checkout.success] Google Ads purchase conversion destination is not configured");
    }
    return (
      <section className="relative overflow-hidden px-5 py-24 sm:px-8 sm:py-32">
        <Reveal>
          <div className="mx-auto max-w-2xl border border-status-engaged/40 bg-ops-panel/90 p-7 text-center backdrop-blur sm:p-12">
            <span className="mx-auto block h-10 w-10 rounded-full border-2 border-status-engaged" aria-hidden="true" />
            <p className="mt-6 font-data text-[10px] uppercase tracking-[0.26em] text-status-engaged">Payment verified</p>
            <h1 className="mt-4 font-display text-[clamp(2rem,6vw,3.4rem)] font-bold tracking-tight text-fg">You&rsquo;re in.</h1>
            <p className="mx-auto mt-5 max-w-xl text-[17px] leading-relaxed text-fg-muted">
              We received your {receipt.optionLabel.toLowerCase()} {receipt.offerName} payment. The OASIS team will email the kickoff details and next steps.
            </p>
            <dl className="mx-auto mt-8 grid max-w-lg gap-3 border-y border-ops-line py-5 text-left text-sm sm:grid-cols-2">
              <div><dt className="text-fg-dim">Amount</dt><dd className="mt-1 font-semibold text-fg">${receipt.valueCad.toLocaleString("en-CA")} CAD</dd></div>
              <div><dt className="text-fg-dim">Transaction</dt><dd className="mt-1 break-all font-data text-xs text-fg">{receipt.transactionId}</dd></div>
            </dl>
            <div className="mt-8"><CtaLink href="/onboarding">View the 7-day onboarding plan</CtaLink></div>
          </div>
        </Reveal>
        {conversionDestination ? (
          <PurchaseConversion valueCad={receipt.valueCad} transactionId={receipt.transactionId} sendTo={conversionDestination} />
        ) : null}
      </section>
    );
  } catch (error) {
    console.error("[public-checkout.success]", error);
    return (
      <section className="px-5 py-24 sm:px-8 sm:py-32">
        <div className="mx-auto max-w-xl border border-ops-edge bg-ops-panel p-7 text-center sm:p-10">
          <span className="mx-auto block h-10 w-10 rounded-full border-2 border-status-warm" aria-hidden="true" />
          <h1 className="mt-5 font-display text-3xl font-bold text-fg">We couldn&rsquo;t verify this receipt.</h1>
          <p className="mt-4 leading-relaxed text-fg-muted">
            No conversion was recorded. If Stripe confirmed your payment, contact OASIS and include the checkout reference from your receipt.
          </p>
          <div className="mt-7"><CtaLink href="/contact" variant="secondary">Contact OASIS</CtaLink></div>
        </div>
      </section>
    );
  }
}

export default async function FunnelPage({
  params,
  searchParams,
}: {
  params: Promise<{ funnel: string }>;
  searchParams: SearchParams;
}) {
  const route = (await params).funnel;
  switch (route as FunnelRoute) {
    case "audit": return <AuditPage />;
    case "command-center": return <CommandCenterPage />;
    case "pricing": return <PricingPage />;
    case "onboarding": return <OnboardingPage />;
    case "checkout-success": return <CheckoutSuccessPage searchParams={searchParams} />;
    default: notFound();
  }
}
