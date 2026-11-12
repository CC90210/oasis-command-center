import type { Metadata } from "next";
import { Reveal } from "@/components/marketing/Reveal";
import { Eyebrow, Section } from "@/components/marketing/Section";
import { ScanApp } from "@/components/scan/ScanApp";
import { resolveConsentIdentity } from "@/lib/consent/ledger-identity";
import { AUDIT_FUNNEL, BOOKING_URL } from "@/lib/marketing/routes";
import { proofCounts } from "@/lib/site-scan/proof";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Free AI scan of your business website",
  description: "Paste your website. In about a minute, watch an AI read it, score it, work out who buys from you, find businesses like your buyers, and write the first email.",
  alternates: { canonical: "/scan" },
};

const STEPS = [
  ["Reads the site", "Every public page a visitor would, plus the parts Google reads: speed, structure, trust signals."],
  ["Learns what you sell", "What the site says, in its own words, and the businesses competing for the same searches."],
  ["Finds who buys it", "Buyer segments scored for fit, with sample businesses from our own Canadian directory when it has a close match. If that part is still running, your report link fills in when it finishes."],
  ["Writes the first move", "When a sample business is found, an email to it, built from your site's own offer. Always, the three fixes worth the most."],
] as const;

export default async function ScanPage() {
  const consentIdentity = resolveConsentIdentity({ tenantSlug: AUDIT_FUNNEL.tenantSlug }).identity;
  const proof = await proofCounts();
  return (
    <>
      <section className="m-edge m-hero relative overflow-hidden">
        <div className="mx-auto w-full max-w-6xl px-5 pb-14 pt-20 sm:px-8 sm:pb-20 sm:pt-28">
          <Reveal>
            <div className="mx-auto max-w-3xl text-center">
              <Eyebrow>Free AI scan</Eyebrow>
              <h1 className="mt-6 font-display text-[clamp(2.4rem,7vw,4.8rem)] font-bold leading-[0.98] tracking-[-0.035em] text-fg">
                Paste your website. Watch the diagnosis build.
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-[18px] leading-relaxed text-fg-muted">
                An AI reads your site like a buyer and like Google, scores it, and works out who buys from you. Where our directory has a match, it finds businesses like them and writes the first email. Live, in about a minute.
              </p>
            </div>
          </Reveal>
          <Reveal delay={120}>
            <div className="mt-10">
              <ScanApp initialScanId={null} consentIdentity={consentIdentity} bookingUrl={BOOKING_URL || null} proof={proof} />
            </div>
          </Reveal>
        </div>
      </section>
      <Section>
        <div className="grid gap-px overflow-hidden border border-ops-line bg-ops-line md:grid-cols-4">
          {STEPS.map(([title, body], index) => (
            <Reveal key={title} delay={index * 70}>
              <article className="h-full bg-ops-panel p-7">
                <span className="block h-1 w-8 bg-signal" aria-hidden="true" />
                <p className="mt-6 font-data text-[10px] uppercase tracking-[0.22em] text-fg-dim">Step {index + 1}</p>
                <h2 className="mt-3 font-display text-xl font-semibold text-fg">{title}</h2>
                <p className="mt-3 leading-relaxed text-fg-muted">{body}</p>
              </article>
            </Reveal>
          ))}
        </div>
        <p className="mx-auto mt-8 max-w-3xl text-center text-sm leading-relaxed text-fg-dim">
          Every line of the report traces to something read from your site, measured by Google PageSpeed, or matched in OASIS&rsquo;s own business directory. Nothing is invented to fill a box.
        </p>
      </Section>
    </>
  );
}
