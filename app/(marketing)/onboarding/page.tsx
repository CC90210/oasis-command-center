import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ArrowDown, CheckCircle2 } from "lucide-react";
import { CtaLink } from "@/components/marketing/Cta";
import { Reveal } from "@/components/marketing/Reveal";
import { Eyebrow, Section } from "@/components/marketing/Section";
import { getSessionUser } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "7-day turnkey onboarding",
  description: "Apply for OASIS AI's seven-day onboarding: scope, access, build, validation, training, and launch.",
  alternates: { canonical: "/onboarding" },
};

const DAYS = [
  ["Day 1", "Outcome map", "Confirm the business result, owner, guardrails, and launch metric."],
  ["Day 2", "Access and data", "Connect only the systems the build needs, with least-privilege access."],
  ["Days 3-4", "Build", "Configure the workflows, agent role, memory, and approval points."],
  ["Day 5", "Production-shaped test", "Run real scenarios safely and verify every handoff and fallback."],
  ["Day 6", "Team handoff", "Train the people who approve, review, and improve the system."],
  ["Day 7", "Launch", "Turn on the measured workflow with monitoring and a tuning cadence."],
] as const;

export default async function OnboardingPage() {
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
          {DAYS.map(([day, title, body], index) => (
            <Reveal key={day} delay={index * 55}>
              <article className="relative grid gap-4 border-x border-t border-ops-line bg-ops-panel/90 p-6 last:border-b sm:grid-cols-[7rem_1fr] sm:p-8">
                <p className="font-data text-xs uppercase tracking-[0.2em] text-signal">{day}</p>
                <div>
                  <h2 className="font-display text-2xl font-semibold text-fg">{title}</h2>
                  <p className="mt-2 leading-relaxed text-fg-muted">{body}</p>
                </div>
                {index < DAYS.length - 1 ? <ArrowDown className="absolute -bottom-3 left-1/2 z-10 h-6 w-6 -translate-x-1/2 rounded-full bg-ops-void p-1 text-signal" aria-hidden="true" /> : null}
              </article>
            </Reveal>
          ))}
        </div>
      </Section>
      <Section className="m-edge">
        <Reveal>
          <div className="mx-auto max-w-3xl border border-status-engaged/30 bg-ops-panel p-7 sm:p-10">
            <div className="flex items-center gap-3 text-status-engaged"><CheckCircle2 className="h-5 w-5" aria-hidden="true" /><span className="font-data text-xs uppercase tracking-[0.2em]">Launch-ready handoff</span></div>
            <h2 className="mt-5 font-display text-3xl font-bold text-fg">You leave with ownership, evidence, and a next-30-day plan.</h2>
            <p className="mt-4 leading-relaxed text-fg-muted">No mystery black box. Your team knows what the system does, where it stops, how results are measured, and who to call when reality changes.</p>
            <div className="mt-8"><CtaLink href="/audit#apply">Apply now</CtaLink></div>
          </div>
        </Reveal>
      </Section>
    </>
  );
}
