/**
 * OfferPage - the public offer page: a full landing page in front of a form
 * (design section 2.3). Desktop and phone, the OASIS look: the ops-void
 * canvas, the marketing faces, the eyebrow device, and the offer's accent as
 * the CSS variable --accent (signal cyan unless the offer sets one).
 *
 *   sticky header   mark, pinned sections, Book
 *   hero            eyebrow, headline, subheadline, the VSL (a facade), Book
 *   body sections   only those holding real content, in the owner's order;
 *                   results, bonuses and the guarantee end with the Book button
 *   #book           the form, always last, on ONE card (the form draws no card
 *                   of its own inside it: FormPublicClient chrome="embedded")
 *   footer          the workspace's name (and OASIS's legal links on OASIS's own)
 *   phones          a Book bar pinned to the bottom after the hero
 *
 * Presentation only: everything it draws was decided and resolved by
 * lib/offer-pages/render.ts. Server HTML holds no <video src>, no <iframe> and
 * no third-party script; the only script is the one-line `js` class switch the
 * marketing site uses, so reveals never hide content from a visitor without JS.
 */
import "@/app/(marketing)/marketing.css";
import { ArrowRight } from "lucide-react";
import { offerFontVariables } from "@/app/fonts/offer-fonts";
import { Section, Eyebrow } from "@/components/marketing/Section";
import { CTA_PRIMARY, CTA_INLINE } from "@/components/marketing/Cta";
import type { PreparedOffer } from "@/lib/offer-pages/render";
import type { BodyKey } from "@/lib/offer-pages/types";
import { OfferNav } from "./OfferNav";
import { OfferSection, OfferHead, OfferFacade } from "./sections";
import { OfferBook, type EmbeddedFormProps } from "./OfferBook";
import { StickyBookBar } from "./StickyBookBar";

/** Same switch as app/(marketing)/layout.tsx: reveals animate only once JS can undo them. */
const JS_FLAG = `document.documentElement.classList.add('js')`;

/** The sections a visitor decides on (proof, value, risk): each ends with the booking button. */
const ASK_AGAIN_AFTER: ReadonlySet<BodyKey> = new Set<BodyKey>(["results", "bonuses", "guarantee"]);

export function OfferPage({
  prepared,
  workspaceName,
  logoUrl,
  legalLinks,
  form,
  bookingUrl,
  contactEmail = null,
  preview,
}: {
  prepared: PreparedOffer;
  workspaceName: string;
  logoUrl: string | null;
  /** OASIS's own workspaces link OASIS's /privacy and /terms; nobody else's page does. */
  legalLinks: boolean;
  /** The page's own form, or null in a preview (never a live form there). */
  form: EmbeddedFormProps | null;
  bookingUrl: string | null;
  /** The workspace's own contact address, for "two times that suit you" when there is no booking link. */
  contactEmail?: string | null;
  /** Set for the owner's signed-in preview: a banner, and step titles instead of the form. */
  preview?: { steps: string[] } | null;
}) {
  const { page, ctaLabel } = prepared;
  const hero = page.hero;
  const heroMedia = hero.video ? prepared.media[hero.video.ref] : undefined;
  const bookTitle = page.book.title || ctaLabel;
  const year = new Date().getFullYear();

  const heroCta = (
    <a href="#book" className={CTA_PRIMARY} data-section="hero">
      {hero.ctaLabel || ctaLabel}
      <ArrowRight className="h-4 w-4" aria-hidden="true" />
    </a>
  );

  return (
    <div
      className={`marketing ${offerFontVariables} min-h-screen bg-ops-void font-body text-fg antialiased`}
      style={{ ["--accent" as string]: prepared.accent } as React.CSSProperties}
      data-offer-page=""
    >
      <script dangerouslySetInnerHTML={{ __html: JS_FLAG }} />
      <div>
        {preview ? (
          <div className="border-b border-status-warm/40 bg-status-warm/10 px-5 py-2 text-center text-[13px] text-status-warm">
            Preview of your unpublished page. Only signed-in owners see this; the public link still shows what is live.
          </div>
        ) : null}
        <OfferNav nav={page.nav} name={workspaceName} logoUrl={logoUrl} ctaLabel={ctaLabel} />

        <main id="top">
          {/* -- Hero -----------------------------------------------------
              The marketing home hero's treatment: the solid ops-void canvas
              with no backdrop, one hairline accent rule, and the type doing
              the rest (display headline, muted lede, the accent button). The
              rule is the eyebrow device (.m-eyebrow in marketing.css): with an
              eyebrow it is the eyebrow's own rule; without one it is drawn
              bare, so every hero opens on the same mark and never on two. */}
          <section className="m-edge relative overflow-hidden">
            <div className="mx-auto w-full max-w-6xl px-5 pb-16 pt-14 sm:px-8 sm:pb-24 sm:pt-20">
              <div className={heroMedia ? "grid items-center gap-10 lg:grid-cols-[1.02fr_1fr] lg:gap-14" : "max-w-3xl"}>
                {/* No Reveal in the hero: it is the first paint (LCP), so it never
                    waits for JavaScript to fade it in. Sections below the fold do. */}
                <div>
                  {hero.eyebrow ? (
                    <Eyebrow>{hero.eyebrow}</Eyebrow>
                  ) : (
                    <span aria-hidden="true" className="block h-px w-8 bg-[linear-gradient(to_right,var(--accent,#00D4FF),transparent)]" />
                  )}
                  <h1
                    className="mt-6 font-display text-[clamp(2.3rem,5.4vw,4rem)] font-bold leading-[1.03] tracking-[-0.025em] text-fg"
                  >
                    {hero.headline}
                  </h1>
                  {hero.subheadline ? (
                    <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-fg-muted sm:text-[18px]">{hero.subheadline}</p>
                  ) : null}
                  {/* Desktop: the button under the words. Phones draw it after the video. */}
                  <div className={`mt-9 ${heroMedia ? "hidden lg:flex" : "flex"}`}>{heroCta}</div>
                </div>
                {heroMedia ? (
                  <div>
                    <OfferFacade media={heroMedia} label={hero.headline} priority />
                    {hero.transcript ? (
                      <details className="mt-4">
                        <summary className={`${CTA_INLINE} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
                          Read the script
                        </summary>
                        <div className="mt-4 max-h-[50vh] overflow-y-auto whitespace-pre-line rounded-lg border border-ops-line bg-ops-panel p-5 text-[15px] leading-relaxed text-fg-muted">
                          {hero.transcript}
                        </div>
                      </details>
                    ) : null}
                    <div className="mt-8 flex lg:hidden">{heroCta}</div>
                  </div>
                ) : null}
              </div>
            </div>
            <span id="offer-hero-end" aria-hidden="true" className="block h-px" />
          </section>

          {page.sections.map((s) => (
            <OfferSection key={s.key} s={s} prepared={prepared} cta={ASK_AGAIN_AFTER.has(s.key) ? ctaLabel : null} />
          ))}

          {/* -- Book: always last ---------------------------------------- */}
          <Section id="book">
            <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
              <div>
                <OfferHead head={{ eyebrow: page.book.eyebrow, title: page.book.title, lede: page.book.lede }} fallbackTitle={bookTitle} />
              </div>
              <div className="rounded-2xl border border-ops-line bg-ops-panel/70 p-5 shadow-raised sm:p-8">
                <OfferBook
                  form={form}
                  mode={page.book.mode}
                  bookingUrl={bookingUrl}
                  contactEmail={contactEmail}
                  previewSteps={preview?.steps}
                />
              </div>
            </div>
          </Section>
        </main>

        <footer className="border-t border-ops-line">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-5 py-10 pb-28 text-[14px] text-fg-dim sm:flex-row sm:items-center sm:justify-between sm:px-8 md:pb-10">
            <p>
              &copy; {year} {workspaceName}
            </p>
            {legalLinks ? (
              <nav aria-label="Legal" className="flex gap-6">
                {/* Plain anchors, a full load: /f/ is a shell boundary (lib/os/full-bleed.ts). */}
                <a href="/privacy" className="transition-colors hover:text-fg">
                  Privacy
                </a>
                <a href="/terms" className="transition-colors hover:text-fg">
                  Terms
                </a>
              </nav>
            ) : null}
          </div>
        </footer>

        <StickyBookBar label={ctaLabel} />
      </div>
    </div>
  );
}
