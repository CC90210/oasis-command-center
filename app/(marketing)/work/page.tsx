import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CtaLink, CTA_INLINE } from "@/components/marketing/Cta";
import { Reveal } from "@/components/marketing/Reveal";
import { Section, SectionHead, Eyebrow } from "@/components/marketing/Section";
import { BOOKING_URL } from "@/lib/marketing/routes";

/**
 * /work — what we build, and what it costs to start.
 *
 * PRICING IS PLACEHOLDER. Every figure below is marked TODO(CC) and must
 * be confirmed before launch — the last published price card dates from
 * May 2026 and pricing is Atlas's call, not this file's. Publishing a
 * number here creates a commitment, so the anchors are ranges and every
 * one of them routes to a conversation rather than a checkout.
 */

export const metadata: Metadata = {
  title: "What we build",
  description:
    "Custom AI agents and the systems they run on: operator portals, document pipelines, lead engines, and voice. What OASIS builds and where engagements start.",
  alternates: { canonical: "/work" },
};

const CAPABILITIES = [
  {
    name: "Operator portals",
    body: "The internal system your team actually works in all day. Pipeline, records, documents, roles, and permissions, built around your process instead of bending your process around a product.",
  },
  {
    name: "Document pipelines",
    body: "Statements, applications, purchase orders, and contracts read, extracted, checked, and filed. The part of the job that is currently a person and a highlighter.",
  },
  {
    name: "Lead engines",
    body: "Capture, qualify, score, route, and follow up. Every touch recorded against the record so nobody has to reconstruct what happened from memory.",
  },
  {
    name: "Inbox and comms",
    body: "Email that gets read, classified, and drafted against your actual history. Escalation rules so the things that matter reach you and the rest doesn't.",
  },
  {
    name: "Voice",
    body: "Agents that answer, qualify, and hand off, with hard limits on what they may commit to out loud, because a voice agent that improvises pricing is a liability.",
  },
  {
    name: "Integration and cleanup",
    body: "The unglamorous half: getting your tools talking, migrating the data that matters, and deleting the four spreadsheets that were secretly load-bearing.",
  },
];

/**
 * Engagement shapes. `price` strings are intentionally ranges, and
 * intentionally unconfirmed — see the file header.
 */
const ENGAGEMENTS = [
  {
    name: "Single seat",
    price: "from $797", // TODO(CC): confirm with Atlas before launch
    body: "One agent, one job, deployed into what you already run. The right way to find out whether this works for you without a six-figure act of faith.",
    detail: ["One agent, scoped to a single function", "Runs against your live tools", "Support while it beds in"],
  },
  {
    name: "System build",
    price: "from $2,500", // TODO(CC): confirm with Atlas before launch
    body: "A custom platform plus the agents that operate it. This is the bulk of what we do, the portal, the pipeline, and the automation as one thing rather than three.",
    detail: ["Custom software built for your process", "Multiple agents, coordinated", "Guardrails scoped with you", "Ongoing tuning against real usage"],
    featured: true,
  },
  {
    name: "Full fleet",
    price: "Let's talk", // TODO(CC): confirm with Atlas before launch
    body: "The whole operation: several seats, working together, with the state and reporting layer that lets them hand work to each other.",
    detail: ["Multi-agent operation", "Shared state and reporting", "Staged rollout, function by function"],
  },
];

export default function WorkPage() {
  return (
    <>
      <section className="m-edge relative overflow-hidden">
        <div className="relative mx-auto w-full max-w-6xl px-5 pb-16 pt-20 sm:px-8 sm:pb-20 sm:pt-28">
          <Reveal>
            <Eyebrow>What we build</Eyebrow>
          </Reveal>
          <Reveal delay={90}>
            <h1 className="mt-6 max-w-3xl font-display text-[clamp(2.2rem,6vw,3.8rem)] font-bold leading-[1.04] tracking-[-0.02em] text-fg">
              Custom software, with the staff included.
            </h1>
          </Reveal>
          <Reveal delay={180}>
            <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-fg-muted">
              We don&rsquo;t resell a platform. We build the system your
              business needs and put agents inside it to run the parts that
              shouldn&rsquo;t need a person.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── Capabilities ─────────────────────────────────────────────── */}
      <Section className="m-edge">
        <Reveal>
          <SectionHead
            eyebrow="Capabilities"
            title="Six things, done properly."
            lede="Most engagements are two or three of these wired together. Nobody needs all six on day one, and anyone who sells you all six on day one is selling."
          />
        </Reveal>

        <div className="mt-12 grid gap-px border border-ops-line bg-ops-line sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map((c, i) => (
            <Reveal key={c.name} delay={(i % 3) * 80}>
              <article className="h-full bg-ops-void p-7">
                <h3 className="font-display text-base font-bold tracking-tight text-fg">
                  {c.name}
                </h3>
                <p className="mt-3 text-[15px] leading-relaxed text-fg-muted">
                  {c.body}
                </p>
              </article>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* ── Engagements ──────────────────────────────────────────────── */}
      <Section className="m-edge">
        <Reveal>
          <SectionHead
            eyebrow="Where it starts"
            title="Three ways in."
            lede="Scope decides price, so these are starting points rather than packages. You'll get a fixed number before anything is committed, and it won't move afterwards."
          />
        </Reveal>

        <div className="mt-12 grid gap-px border border-ops-line bg-ops-line lg:grid-cols-3">
          {ENGAGEMENTS.map((e, i) => (
            <Reveal key={e.name} delay={i * 90}>
              <article
                className={`flex h-full flex-col p-7 ${
                  e.featured ? "bg-ops-panel" : "bg-ops-void"
                }`}
              >
                {e.featured ? (
                  <span className="mb-4 inline-block w-fit border border-signal/40 bg-signal-wash px-2.5 py-1 font-data text-[9px] uppercase tracking-[0.2em] text-signal">
                    Most engagements
                  </span>
                ) : null}
                <h3 className="font-display text-lg font-bold tracking-tight text-fg">
                  {e.name}
                </h3>
                <p className="mt-2 font-display text-2xl font-bold tracking-tight text-signal">
                  {e.price}
                </p>
                <p className="mt-4 text-[15px] leading-relaxed text-fg-muted">
                  {e.body}
                </p>
                <ul className="mt-6 flex-1 space-y-2.5">
                  {e.detail.map((d) => (
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
                  Start here
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal>
          <p className="mt-8 max-w-2xl font-data text-[11px] leading-relaxed tracking-[0.06em] text-fg-dim">
            Running costs, hosting, model usage, maintenance, are quoted
            separately and monthly, so you can see what the system costs to
            own rather than only what it cost to build.
          </p>
        </Reveal>
      </Section>

      {/* ── CTA ──────────────────────────────────────────────────────── */}
      <Section>
        <Reveal>
          <div className="border border-ops-line bg-ops-panel p-8 sm:p-12">
            <Eyebrow>Next step</Eyebrow>
            <h2 className="mt-5 max-w-2xl font-display text-[clamp(1.7rem,3.4vw,2.5rem)] font-bold leading-[1.1] tracking-tight text-fg">
              Find out what&rsquo;s worth automating before you spend anything.
            </h2>
            <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-fg-muted">
              Four questions, two minutes. We come back with where an agent
              pays for itself first in your business, including if the answer
              is &ldquo;nowhere yet&rdquo;.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <CtaLink href="/contact">Start the audit</CtaLink>
              <CtaLink href={BOOKING_URL} variant="secondary" external arrow={false}>
                Book a call instead
              </CtaLink>
            </div>
          </div>
        </Reveal>
      </Section>
    </>
  );
}
