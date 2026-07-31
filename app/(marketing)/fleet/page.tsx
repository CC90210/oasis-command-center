import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ConsoleField } from "@/components/marketing/ConsoleField";
import { FleetRoster } from "@/components/marketing/FleetRoster";
import { Reveal } from "@/components/marketing/Reveal";
import { Section, SectionHead, Eyebrow } from "@/components/marketing/Section";

/**
 * /fleet — the agent roster in full.
 *
 * NOT /agents. That path is an auth-gated operator dashboard page and has
 * been since long before this site existed.
 */

export const metadata: Metadata = {
  title: "The fleet",
  description:
    "The AI agents OASIS runs — operations, marketing, finance, legal, voice, and deployed client seats. What each one owns and what it produces.",
  alternates: { canonical: "/fleet" },
};

const GUARDRAILS = [
  {
    title: "Nothing destructive runs unattended",
    body: "Commands that could drop data, force-push, or wipe a directory are blocked at the layer beneath the agent. It cannot talk its way past them, because the check does not ask the agent's opinion.",
  },
  {
    title: "Credentials are not readable by the model",
    body: "Keys live in an environment the agent can use but never read. It calls a wrapper that returns a result; the secret itself never enters the context window.",
  },
  {
    title: "Money and outbound sends need a human",
    body: "Anything that spends, sends, or signs stops for approval. Autonomy is scoped per action, not granted once and forgotten.",
  },
  {
    title: "Inbound content is data, never instruction",
    body: "An email, a scraped page, or a form fill that contains 'ignore previous instructions' is processed as text to be read. Agents act on your intent, not on whatever a stranger typed into a field.",
  },
];

export default function FleetPage() {
  return (
    <>
      <section className="m-edge relative overflow-hidden">
        <ConsoleField />
        <div className="relative mx-auto w-full max-w-6xl px-5 pb-16 pt-20 sm:px-8 sm:pb-20 sm:pt-28">
          <Reveal>
            <Eyebrow>Roster</Eyebrow>
          </Reveal>
          <Reveal delay={90}>
            <h1 className="mt-6 max-w-3xl font-display text-[clamp(2.2rem,6vw,3.8rem)] font-bold leading-[1.04] tracking-[-0.02em] text-fg">
              The staff you can&rsquo;t afford to hire.
            </h1>
          </Reveal>
          <Reveal delay={180}>
            <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-fg-muted">
              Every agent below runs today. We use them to run OASIS, which is
              the only reason we&rsquo;re willing to describe them this
              specifically.
            </p>
          </Reveal>
        </div>
      </section>

      <Section className="m-edge">
        <FleetRoster />
      </Section>

      {/* ── Guardrails ───────────────────────────────────────────────── */}
      <Section className="m-edge">
        <Reveal>
          <SectionHead
            eyebrow="Guardrails"
            title="The interesting question isn't what it can do. It's what it can't."
            lede="Autonomy without limits is not a feature, it's an incident waiting for a date. These constraints are enforced below the agent, where it has no ability to override them."
          />
        </Reveal>

        <div className="mt-12 grid gap-px border border-ops-line bg-ops-line sm:grid-cols-2">
          {GUARDRAILS.map((g, i) => (
            <Reveal key={g.title} delay={i * 80}>
              <article className="h-full bg-ops-void p-7">
                <h3 className="font-display text-base font-bold leading-snug tracking-tight text-fg">
                  {g.title}
                </h3>
                <p className="mt-3 text-[15px] leading-relaxed text-fg-muted">
                  {g.body}
                </p>
              </article>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* ── Custom seats ─────────────────────────────────────────────── */}
      <Section>
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
          <Reveal>
            <SectionHead
              eyebrow="Custom seats"
              title="Or a seat that only exists in your business."
              lede="The roster is what we needed. Most of what we build is what a client needed and nobody sells — a desk job that is specific enough that no product will ever cover it."
            />
          </Reveal>
          <Reveal delay={120}>
            <div className="space-y-5 text-[16px] leading-relaxed text-fg-muted sm:text-[17px]">
              <p>
                A wholesale distributor needed purchase orders read out of
                PDFs, spreadsheets, and EDI and typed into a desktop ERP from
                1998. There is no SaaS for that. There is now an agent for it.
              </p>
              <p>
                If the job can be described, has inputs you can point at, and
                someone is currently doing it by hand, it is a candidate. If it
                needs judgement nobody can articulate, it isn&rsquo;t — and
                we&rsquo;ll say so on the first call rather than after the
                invoice.
              </p>
              <Link
                href="/contact"
                className="inline-flex items-center gap-1.5 text-[15px] font-medium text-signal transition-colors hover:text-fg"
              >
                Describe the job
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
          </Reveal>
        </div>
      </Section>
    </>
  );
}
