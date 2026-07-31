import type { Metadata } from "next";
import { Calendar, Mail, ShieldCheck } from "lucide-react";
import { ConsoleField } from "@/components/marketing/ConsoleField";
import { Reveal } from "@/components/marketing/Reveal";
import { Section, Eyebrow } from "@/components/marketing/Section";
import { AuditForm } from "@/components/marketing/AuditForm";
import { BOOKING_URL, CONTACT_EMAIL } from "@/lib/marketing/routes";

/**
 * /contact — the conversion page.
 *
 * The form is the primary path: it creates a real lead on submit and hands
 * the visitor into the rest of the qualification funnel. Booking and email
 * are alternates for people who would rather not fill anything in, and are
 * deliberately less prominent rather than hidden.
 */

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Tell OASIS AI what's eating your week. Four questions, two minutes, and an honest answer about where an AI agent would pay for itself first.",
  alternates: { canonical: "/contact" },
};

const ALTERNATES = [
  {
    icon: Calendar,
    label: "Book a call",
    body: "Thirty minutes. We map what to automate first. No pitch deck.",
    href: BOOKING_URL,
    action: "Pick a time",
    external: true,
  },
  {
    icon: Mail,
    label: "Just email",
    body: "If you'd rather write a paragraph than fill in a form, that works too.",
    href: `mailto:${CONTACT_EMAIL}`,
    action: CONTACT_EMAIL,
    external: false,
  },
];

export default function ContactPage() {
  return (
    <>
      <section className="m-edge relative overflow-hidden">
        <ConsoleField />
        <div className="relative mx-auto w-full max-w-6xl px-5 pb-16 pt-20 sm:px-8 sm:pb-20 sm:pt-28">
          <Reveal>
            <Eyebrow>Start here</Eyebrow>
          </Reveal>
          <Reveal delay={90}>
            <h1 className="mt-6 max-w-3xl font-display text-[clamp(2.2rem,6vw,3.8rem)] font-bold leading-[1.04] tracking-[-0.02em] text-fg">
              Tell us what&rsquo;s eating your week.
            </h1>
          </Reveal>
          <Reveal delay={180}>
            <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-fg-muted">
              Four questions about how your business actually runs. We read
              every one and come back with where an agent would pay for itself
              first — including when the honest answer is &ldquo;not
              yet&rdquo;.
            </p>
          </Reveal>
        </div>
      </section>

      <Section className="m-edge">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-16">
          <Reveal>
            <div className="border border-ops-line bg-ops-panel p-6 sm:p-8">
              <h2 className="mb-7 font-data text-[11px] uppercase tracking-[0.22em] text-signal-dim">
                Step 1 of 4
              </h2>
              <AuditForm />
            </div>
          </Reveal>

          <Reveal delay={120}>
            <div>
              <h2 className="font-display text-lg font-bold tracking-tight text-fg">
                What happens next
              </h2>
              <ol className="mt-5 space-y-4">
                {[
                  "You answer three more short screens — what to automate, your scale, your timeline. Two minutes, and you can stop at any point; we'll still have your details.",
                  "It lands in our pipeline immediately and gets read by a person, not filed into an autoresponder.",
                  "You get back a specific answer about your business: what to automate first, roughly what it costs, and what to leave alone for now.",
                ].map((t, i) => (
                  <li key={i} className="flex gap-4">
                    <span className="mt-0.5 font-data text-[11px] tracking-[0.16em] text-signal-dim">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="text-[15px] leading-relaxed text-fg-muted">
                      {t}
                    </span>
                  </li>
                ))}
              </ol>

              <div className="mt-8 flex gap-3 border-t border-ops-line pt-6">
                <ShieldCheck
                  className="mt-0.5 h-4 w-4 shrink-0 text-signal-dim"
                  aria-hidden="true"
                />
                <p className="text-[13px] leading-relaxed text-fg-dim">
                  Your details go into our own system and are used to answer
                  you. We don&rsquo;t sell lists and there is no third-party
                  tracking on this site.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </Section>

      {/* ── Alternates ───────────────────────────────────────────────── */}
      <Section>
        <Reveal>
          <h2 className="font-data text-[10px] uppercase tracking-[0.24em] text-fg-dim">
            Or, if you&rsquo;d rather not
          </h2>
        </Reveal>

        <div className="mt-6 grid gap-px border border-ops-line bg-ops-line sm:grid-cols-2">
          {ALTERNATES.map((a, i) => {
            const Icon = a.icon;
            return (
              <Reveal key={a.label} delay={i * 90}>
                <article className="h-full bg-ops-void p-7">
                  <Icon className="h-5 w-5 text-signal-dim" aria-hidden="true" />
                  <h3 className="mt-4 font-display text-base font-bold tracking-tight text-fg">
                    {a.label}
                  </h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-fg-muted">
                    {a.body}
                  </p>
                  <a
                    href={a.href}
                    {...(a.external
                      ? { target: "_blank", rel: "noopener noreferrer" }
                      : {})}
                    className="mt-5 inline-block text-[15px] font-medium text-signal transition-colors hover:text-fg"
                  >
                    {a.action}
                  </a>
                </article>
              </Reveal>
            );
          })}
        </div>
      </Section>
    </>
  );
}
