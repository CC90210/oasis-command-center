import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CtaLink } from "@/components/marketing/Cta";
import { ConsoleField } from "@/components/marketing/ConsoleField";
import { FleetRoster } from "@/components/marketing/FleetRoster";
import { Reveal } from "@/components/marketing/Reveal";
import { Section, SectionHead, Eyebrow } from "@/components/marketing/Section";
import { AuditForm } from "@/components/marketing/AuditForm";
import { CLIENT_BUILDS } from "@/lib/marketing/fleet";

/**
 * The marketing home page.
 *
 * Served at "/" via a middleware rewrite, NOT at /home — see
 * lib/marketing/routes.ts. Two consequences worth remembering before
 * editing this file:
 *   - canonical is "/", not "/home"
 *   - it must never carry a noindex, or the homepage leaves the index
 */

export const metadata: Metadata = {
  // `absolute` bypasses the layout's "%s · OASIS AI" template — the brand
  // is already the first two words of this title, and the template would
  // render "OASIS AI — Operational agentic systems · OASIS AI".
  title: { absolute: "OASIS AI — Operational agentic systems" },
  description:
    "OASIS builds AI agents that hold a seat in your business — operations, marketing, finance, legal — and the systems they run on. Montreal, Quebec.",
  alternates: { canonical: "/" },
  // No openGraph override here on purpose. Next merges metadata shallowly:
  // a page-level openGraph object REPLACES the layout's, and that includes
  // dropping the file-based opengraph-image.tsx the route group provides.
  // The previous version of this file set url/title/description here and
  // silently shipped the homepage — the single most-shared URL on the site
  // — with no share image at all, while every other marketing page had one.
  // Verified by diffing the rendered og: tags on / against /fleet.
  // og:title and og:description are derived from the fields above anyway.
};

const STEPS = [
  {
    label: "Discovery",
    when: "Day one",
    body: "We map how the work actually moves through your business — not how the org chart says it does. You leave the call knowing what to automate first and what to leave alone.",
  },
  {
    label: "Build",
    when: "Weeks one to two",
    body: "We design and build the system around your real data and your real tools. Custom, not a template with your logo dropped into it.",
  },
  {
    label: "Deploy",
    when: "Week three",
    body: "The agents go in behind guardrails: what they may do on their own, what needs your approval, and what they can never touch. You decide where those lines sit.",
  },
  {
    label: "Run",
    when: "Ongoing",
    body: "It keeps running, and we keep tuning it against what it actually does in production. Systems that are not maintained stop being assets.",
  },
];

export default function MarketingHome() {
  return (
    <>
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b border-ops-line">
        <ConsoleField />

        <div className="relative mx-auto w-full max-w-6xl px-5 pb-24 pt-24 sm:px-8 sm:pb-32 sm:pt-32">
          <Reveal>
            <Eyebrow>Operational agentic systems</Eyebrow>
          </Reveal>

          <Reveal delay={90}>
            <h1 className="mt-6 max-w-4xl font-display text-[clamp(2.4rem,7vw,4.6rem)] font-bold leading-[1.02] tracking-[-0.02em] text-fg">
              You don&rsquo;t hire a tool.
              <br />
              <span className="text-signal">You staff a company.</span>
            </h1>
          </Reveal>

          <Reveal delay={180}>
            <p className="mt-7 max-w-xl text-[17px] leading-relaxed text-fg-muted sm:text-lg">
              OASIS builds AI agents that hold a seat in your business —
              operations, marketing, finance, legal — and the systems they run
              on. Each one owns a function, works from your real data, and
              reports back in plain English.
            </p>
          </Reveal>

          <Reveal delay={270}>
            <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center">
              <CtaLink href="/contact">Start the audit</CtaLink>
              <CtaLink href="/fleet" variant="secondary" arrow={false}>
                Meet the fleet
              </CtaLink>
            </div>
          </Reveal>

          <Reveal delay={360}>
            <p className="mt-14 max-w-2xl border-l border-ops-line pl-4 font-data text-[11px] leading-relaxed tracking-[0.08em] text-fg-dim">
              Montreal, Quebec. Systems running in production for lending,
              property management, wholesale distribution, and consumer health.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── Thesis ───────────────────────────────────────────────────── */}
      <Section className="border-b border-ops-line">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
          <Reveal>
            <h2 className="font-display text-[clamp(1.9rem,4vw,2.9rem)] font-bold leading-[1.08] tracking-tight text-fg">
              Software waits to be used.
              <br />
              A seat doesn&rsquo;t.
            </h2>
          </Reveal>
          <Reveal delay={120}>
            <div className="space-y-5 text-[16px] leading-relaxed text-fg-muted sm:text-[17px]">
              <p>
                Most AI you can buy is a feature. It sits there until someone
                opens it, prompts it, copies the output somewhere useful, and
                remembers to do it again tomorrow. That someone is still you.
              </p>
              <p>
                An agent is different in one specific way: it owns an outcome
                rather than a screen. It knows what happened last week, it has
                access to the systems the work lives in, and it comes back to
                you with the answer instead of waiting to be asked.
              </p>
              <p className="text-fg">
                That difference is the entire product. Everything below is how
                we make it hold up in a real business.
              </p>
            </div>
          </Reveal>
        </div>
      </Section>

      {/* ── The fleet ────────────────────────────────────────────────── */}
      <Section id="fleet" className="border-b border-ops-line">
        <Reveal>
          <SectionHead
            eyebrow="The fleet"
            title="Seven seats. Pick the ones you're missing."
            lede="These are the agents we run our own company on. You get the same ones, scoped to your business — or a custom seat built for a job only you have."
          />
        </Reveal>

        <div className="mt-12">
          <FleetRoster />
        </div>

        <Reveal>
          <Link
            href="/fleet"
            className="mt-10 inline-flex items-center gap-2 font-data text-[12px] uppercase tracking-[0.16em] text-signal transition-opacity hover:opacity-80"
          >
            Full fleet detail
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </Reveal>
      </Section>

      {/* ── What we build ────────────────────────────────────────────── */}
      <Section className="border-b border-ops-line">
        <Reveal>
          <SectionHead
            eyebrow="In production"
            title="Not demos. Systems people run their business on."
            lede="Three builds currently live, described by what they do rather than who bought them."
          />
        </Reveal>

        <div className="mt-12 grid gap-px border border-ops-line bg-ops-line md:grid-cols-3">
          {CLIENT_BUILDS.map((b, i) => (
            <Reveal key={b.name} delay={i * 90}>
              <article className="h-full bg-ops-void p-7">
                <h3 className="font-display text-lg font-bold tracking-tight text-fg">
                  {b.name}
                </h3>
                <p className="mt-4 text-[15px] leading-relaxed text-fg-muted">
                  {b.summary}
                </p>
                <p className="mt-5 border-t border-ops-line pt-4 font-data text-[11px] leading-relaxed tracking-[0.06em] text-fg-dim">
                  {b.proof}
                </p>
              </article>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* ── How it works. Numbered because it genuinely is a sequence —
             the only place on the site that uses ordinals. ───────────── */}
      <Section className="border-b border-ops-line">
        <Reveal>
          <SectionHead
            eyebrow="How it goes"
            title="Three weeks from first call to something running."
          />
        </Reveal>

        <ol className="mt-12 border-t border-ops-line">
          {STEPS.map((s, i) => (
            <Reveal as="li" key={s.label} delay={i * 80}>
              <div className="grid gap-3 border-b border-ops-line py-7 sm:grid-cols-[4rem_1fr_9rem] sm:gap-8">
                <span className="font-data text-[11px] tracking-[0.16em] text-signal-dim">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <h3 className="font-display text-lg font-bold tracking-tight text-fg">
                    {s.label}
                  </h3>
                  <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-fg-muted">
                    {s.body}
                  </p>
                </div>
                <span className="font-data text-[11px] uppercase tracking-[0.16em] text-fg-dim sm:text-right">
                  {s.when}
                </span>
              </div>
            </Reveal>
          ))}
        </ol>
      </Section>

      {/* ── CTA ──────────────────────────────────────────────────────── */}
      <Section id="start">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-20">
          <Reveal>
            <div>
              <Eyebrow>Start here</Eyebrow>
              <h2 className="mt-5 font-display text-[clamp(1.9rem,4vw,2.9rem)] font-bold leading-[1.08] tracking-tight text-fg">
                Tell us what&rsquo;s eating your week.
              </h2>
              <p className="mt-5 max-w-md text-[16px] leading-relaxed text-fg-muted sm:text-[17px]">
                Four questions about how your business actually runs. We read
                every one and come back with where an agent would pay for
                itself first — and where it wouldn&rsquo;t.
              </p>
              <p className="mt-6 font-data text-[11px] leading-relaxed tracking-[0.08em] text-fg-dim">
                No call required to get the answer.
              </p>
            </div>
          </Reveal>

          <Reveal delay={120}>
            <div className="border border-ops-line bg-ops-panel p-6 sm:p-8">
              <AuditForm />
            </div>
          </Reveal>
        </div>
      </Section>
    </>
  );
}
