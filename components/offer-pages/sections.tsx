/**
 * The offer page's body sections (design 2.3), in the marketing site's own
 * language: Section, Reveal and the eyebrow device as they are, the display
 * face for headings, mono numerals and chips, hairline grids. Every colour
 * that is not neutral reads --accent.
 *
 * Each section draws only what lib/offer-pages/visibility.ts kept: an empty
 * section never reaches here, and nothing here fills a gap with a default.
 */
import type { ReactNode } from "react";
import { ArrowRight, Check } from "lucide-react";
import { Section, Eyebrow } from "@/components/marketing/Section";
import { Reveal } from "@/components/marketing/Reveal";
import { CTA_INLINE, CTA_PRIMARY, CTA_SECONDARY } from "@/components/marketing/Cta";
import type { DrawnSection } from "@/lib/offer-pages/visibility";
import { formatMoney } from "@/lib/offer-pages/visibility";
import { BODY_ANCHORS } from "@/lib/offer-pages/types";
import type { FacadeMedia, PreparedOffer } from "@/lib/offer-pages/render";
import { imageKey } from "@/lib/offer-pages/video";
import { VideoFacade, type VideoTracking } from "./VideoFacade";
import { ResultsViewer, type ResultCard } from "./ResultsViewer";
import { ACCENT_BORDER, ACCENT_RULE, ACCENT_TEXT, ACCENT_WASH, DATA_LABEL, H2, LEDE } from "./styles";

const num = (i: number) => String(i + 1).padStart(2, "0");

/** A section's head: each line drawn only when it was written. */
export function OfferHead({ head, fallbackTitle }: { head: { eyebrow?: string; title?: string; lede?: string }; fallbackTitle?: string }) {
  const title = head.title || fallbackTitle;
  if (!head.eyebrow && !title && !head.lede) return null;
  return (
    <Reveal>
      <header className="max-w-2xl">
        {head.eyebrow ? <Eyebrow>{head.eyebrow}</Eyebrow> : null}
        {title ? <h2 className={`${head.eyebrow ? "mt-5" : ""} ${H2}`}>{title}</h2> : null}
        {head.lede ? <p className={`mt-5 ${LEDE}`}>{head.lede}</p> : null}
      </header>
    </Reveal>
  );
}

function Facade({
  media,
  label,
  priority = false,
  tracking = null,
}: {
  media: FacadeMedia | undefined;
  label: string;
  priority?: boolean;
  tracking?: VideoTracking;
}) {
  if (!media) return null;
  return (
    <VideoFacade
      source={media.source}
      posterUrl={media.posterUrl}
      posterWidth={media.posterWidth}
      posterHeight={media.posterHeight}
      aspect={media.aspect}
      label={label}
      duration={media.duration}
      priority={priority}
      tracking={tracking}
    />
  );
}

function WhatYouGet({
  s,
  media,
  tracking,
}: {
  s: Extract<DrawnSection, { key: "what_you_get" }>;
  media: PreparedOffer["media"];
  tracking: VideoTracking;
}) {
  return (
    <>
      <OfferHead head={s.head} />
      <div className="mt-12 grid gap-px border border-ops-line bg-ops-line sm:grid-cols-2">
        {s.items.map((it, i) => (
          <Reveal key={it.index} delay={(i % 2) * 80} className="h-full">
            <article className="flex h-full flex-col gap-4 bg-ops-void p-7 sm:p-9">
              <span className={`${DATA_LABEL} ${ACCENT_TEXT}`}>{num(i)}</span>
              <h3 className="font-display text-xl font-bold leading-snug tracking-tight text-fg">{it.title}</h3>
              {it.body ? <p className="text-[15px] leading-relaxed text-fg-muted">{it.body}</p> : null}
              {it.video ? (
                <div className="mt-2">
                  <Facade media={media[it.video.ref]} label={it.title} tracking={tracking} />
                </div>
              ) : null}
            </article>
          </Reveal>
        ))}
      </div>
    </>
  );
}

function Obstacles({ s }: { s: Extract<DrawnSection, { key: "obstacles" }> }) {
  return (
    <>
      <OfferHead head={s.head} />
      <ol className="mt-12 border-y border-ops-line">
        {s.items.map((it, i) => (
          <Reveal as="li" key={it.index} delay={Math.min(i, 4) * 60} className="border-b border-ops-line last:border-b-0">
            <div className="grid gap-3 py-7 sm:grid-cols-[6rem_1fr] sm:gap-8 sm:py-9">
              <span className={`font-data text-[13px] tracking-[0.2em] ${ACCENT_TEXT}`}>{num(i)}</span>
              <div>
                <h3 className="font-display text-lg font-bold leading-snug tracking-tight text-fg sm:text-xl">{it.title}</h3>
                {it.body ? <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-fg-muted">{it.body}</p> : null}
              </div>
            </div>
          </Reveal>
        ))}
      </ol>
    </>
  );
}

function Work({
  s,
  media,
  tracking,
}: {
  s: Extract<DrawnSection, { key: "work" }>;
  media: PreparedOffer["media"];
  tracking: VideoTracking;
}) {
  // Steps without a video are numbered among themselves (01, 02...), so a
  // "how it works" list reads in order even with a video step between two.
  const stepNumber = new Map<number, number>();
  for (const it of s.items) if (!it.video) stepNumber.set(it.index, stepNumber.size);
  return (
    <>
      <OfferHead head={s.head} />
      <div className="mt-12 grid gap-10 md:grid-cols-2">
        {s.items.map((it, i) => (
          // A step card fills its grid row (h-full) beside a video; a video
          // step's Reveal is exactly what it always was.
          <Reveal key={it.index} delay={(i % 2) * 80} className={it.video ? undefined : "h-full"}>
            {it.video ? (
              <figure className="space-y-4">
                <Facade media={media[it.video.ref]} label={it.title || "Our work"} tracking={tracking} />
                {it.title || it.body ? (
                  <figcaption>
                    {it.title ? <p className="font-display text-lg font-bold tracking-tight text-fg">{it.title}</p> : null}
                    {it.body ? <p className="mt-1.5 text-[15px] leading-relaxed text-fg-muted">{it.body}</p> : null}
                  </figcaption>
                ) : null}
              </figure>
            ) : (
              <article className="flex h-full flex-col gap-4 border border-ops-line bg-ops-panel/40 p-7 sm:p-9">
                <span className={`${DATA_LABEL} ${ACCENT_TEXT}`}>{num(stepNumber.get(it.index) ?? 0)}</span>
                <h3 className="font-display text-xl font-bold leading-snug tracking-tight text-fg">{it.title}</h3>
                {it.body ? <p className="text-[15px] leading-relaxed text-fg-muted">{it.body}</p> : null}
              </article>
            )}
          </Reveal>
        ))}
      </div>
    </>
  );
}

function Results({ s, prepared }: { s: Extract<DrawnSection, { key: "results" }>; prepared: PreparedOffer }) {
  const cards: ResultCard[] = [];
  for (const { item, index } of s.items) {
    const key = `results:${index}`;
    if (item.kind === "screenshot") {
      const img = prepared.images[imageKey(item.image)];
      if (img) cards.push({ kind: "screenshot", key, imageUrl: img.url, width: img.width, height: img.height, alt: item.alt, label: item.label, who: item.who });
    } else if (item.kind === "video") {
      const m = prepared.media[key];
      if (m) cards.push({ kind: "video", key, source: m.source, posterUrl: m.posterUrl, aspect: m.aspect, duration: m.duration, label: item.label, who: item.who });
    } else if (item.kind === "quote") {
      cards.push({ kind: "quote", key, quote: item.quote, who: item.who, role: item.role });
    } else {
      cards.push({ kind: "metric", key, value: item.value, label: item.label, source: item.source });
    }
  }
  return (
    <>
      <OfferHead head={s.head} />
      <ResultsViewer cards={cards} />
    </>
  );
}

function Bonuses({ s }: { s: Extract<DrawnSection, { key: "bonuses" }> }) {
  return (
    <>
      <OfferHead head={s.head} />
      <div className="mt-12 grid gap-px border border-ops-line bg-ops-line sm:grid-cols-2">
        {s.items.map((it, i) => (
          <Reveal key={it.index} delay={(i % 2) * 80} className="h-full">
            <article className="flex h-full flex-col gap-3 bg-ops-void p-7 sm:p-9">
              <div className="flex items-center justify-between gap-4">
                <span className={`${DATA_LABEL} text-fg-dim`}>Bonus {num(i)}</span>
                {it.value ? (
                  <span className={`border ${ACCENT_BORDER} ${ACCENT_WASH} px-2.5 py-1 ${DATA_LABEL} text-[10px] ${ACCENT_TEXT}`}>
                    Value {formatMoney(it.value)}
                  </span>
                ) : null}
              </div>
              <h3 className="font-display text-xl font-bold leading-snug tracking-tight text-fg">{it.title}</h3>
              {it.body ? <p className="text-[15px] leading-relaxed text-fg-muted">{it.body}</p> : null}
            </article>
          </Reveal>
        ))}
      </div>
      {s.total ? (
        <Reveal>
          <p className="mt-8 font-display text-2xl font-bold tracking-tight text-fg">
            Total value <span className={ACCENT_TEXT}>{formatMoney(s.total)}</span>
          </p>
        </Reveal>
      ) : null}
      {s.valueNote ? <p className="mt-3 max-w-2xl font-data text-[11px] leading-relaxed tracking-[0.04em] text-fg-dim">{s.valueNote}</p> : null}
    </>
  );
}

/** The grid per number of cards: literal strings, because Tailwind only generates classes it can read. */
const PRICING_GRID: Readonly<Record<number, string>> = {
  1: "grid max-w-md gap-6",
  2: "grid gap-6 md:grid-cols-2 lg:max-w-4xl",
  3: "grid gap-6 md:grid-cols-2 lg:grid-cols-3",
  4: "grid gap-6 md:grid-cols-2 xl:grid-cols-4",
};

/**
 * Pricing: one card per confirmed price, each ending with the Book button
 * (the section adds no second one: OfferPage ASK_AGAIN_AFTER). The prices are
 * the owner's words exactly as written. The highlighted card is marked with
 * the accent (its border, wash and top rule) and its button is the filled one;
 * with none highlighted, every card's button is.
 */
function Pricing({ s, ctaLabel }: { s: Extract<DrawnSection, { key: "pricing" }>; ctaLabel: string }) {
  const anyHighlighted = s.tiers.some((t) => t.highlighted);
  return (
    <>
      <OfferHead head={s.head} />
      <div className={`mt-12 ${PRICING_GRID[Math.min(s.tiers.length, 4)]}`}>
        {s.tiers.map((t, i) => (
          <Reveal key={t.index} delay={(i % 4) * 80} className="h-full">
            <article
              className={`relative flex h-full flex-col overflow-hidden border p-7 sm:p-8 ${
                t.highlighted ? `${ACCENT_BORDER} ${ACCENT_WASH} shadow-raised` : "border-ops-line bg-ops-panel/40"
              }`}
              {...(t.highlighted ? { "data-highlighted": "" } : {})}
            >
              {t.highlighted ? <span aria-hidden="true" className={`absolute inset-x-0 top-0 h-[3px] ${ACCENT_RULE}`} /> : null}
              <h3 className={`${DATA_LABEL} ${t.highlighted ? ACCENT_TEXT : "text-fg-dim"}`}>{t.name}</h3>
              <p className="mt-5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="break-words font-display text-4xl font-bold tracking-tight text-fg">{t.price}</span>
                {t.cadence ? <span className="text-[15px] text-fg-muted">{t.cadence}</span> : null}
              </p>
              {/* The Canadian price as the owner wrote it; one string, so the
                  server markup carries no text separator inside it. */}
              {t.priceCad ? <p className="mt-1 text-[13px] text-fg-muted" data-price-cad="">{`or ${t.priceCad}`}</p> : null}
              {t.summary ? <p className="mt-4 text-[15px] leading-relaxed text-fg-muted">{t.summary}</p> : null}
              {t.includes.length ? (
                <ul className="mt-6 space-y-2.5 border-t border-ops-line pt-6">
                  {t.includes.map((line, j) => (
                    <li key={j} className="flex gap-3 text-[15px] leading-relaxed text-fg">
                      <Check className={`mt-1 h-4 w-4 shrink-0 ${ACCENT_TEXT}`} aria-hidden="true" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="mt-auto pt-8">
                <a href="#book" className={`${t.highlighted || !anyHighlighted ? CTA_PRIMARY : CTA_SECONDARY} w-full`} data-section="pricing">
                  {ctaLabel}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </a>
              </div>
            </article>
          </Reveal>
        ))}
      </div>
      {s.currencyNote ? <p className="mt-6 max-w-2xl font-data text-[11px] leading-relaxed tracking-[0.04em] text-fg-dim">{s.currencyNote}</p> : null}
    </>
  );
}

function Guarantee({ s }: { s: Extract<DrawnSection, { key: "guarantee" }> }) {
  return (
    <Reveal>
      <div className="relative overflow-hidden border border-ops-line bg-ops-panel p-8 sm:p-12">
        <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-[3px] ${ACCENT_RULE}`} />
        {s.head.eyebrow ? <Eyebrow>{s.head.eyebrow}</Eyebrow> : null}
        {s.head.title ? <h2 className={`${s.head.eyebrow ? "mt-5" : ""} ${H2}`}>{s.head.title}</h2> : null}
        <p className="mt-5 max-w-3xl whitespace-pre-line text-[17px] leading-relaxed text-fg">{s.body}</p>
        {s.termsUrl ? (
          <a href={s.termsUrl} target="_blank" rel="noopener noreferrer" className={`mt-6 ${CTA_INLINE}`}>
            Read the full terms
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </a>
        ) : null}
      </div>
    </Reveal>
  );
}

function Faq({ s }: { s: Extract<DrawnSection, { key: "faq" }> }) {
  return (
    <>
      <OfferHead head={s.head} />
      <div className="mt-10 max-w-3xl divide-y divide-ops-line border-y border-ops-line">
        {s.items.map((it, i) => (
          <details key={i} className="group py-1">
            <summary className="flex cursor-pointer list-none items-start justify-between gap-6 py-5 font-display text-[17px] font-bold tracking-tight text-fg [&::-webkit-details-marker]:hidden">
              <span>{it.q}</span>
              <span aria-hidden="true" className={`mt-1 font-data text-sm transition-transform group-open:rotate-45 ${ACCENT_TEXT}`}>
                +
              </span>
            </summary>
            <p className="max-w-2xl whitespace-pre-line pb-6 text-[15px] leading-relaxed text-fg-muted">{it.a}</p>
          </details>
        ))}
      </div>
    </>
  );
}

/**
 * One drawn section, with its anchor. `cta` (the page's button label) ends it
 * with the booking button, so a long page asks again after its proof, its
 * value and its guarantee instead of only in the header.
 */
export function OfferSection({
  s,
  prepared,
  cta = null,
  tracking = null,
}: {
  s: DrawnSection;
  prepared: PreparedOffer;
  cta?: string | null;
  /** V5a funnel tracking (HANDOVER section 5): threaded to every video this
   *  section draws. null in the owner's preview. */
  tracking?: VideoTracking;
}): ReactNode {
  const id = BODY_ANCHORS[s.key];
  let inner: ReactNode;
  switch (s.key) {
    case "what_you_get":
      inner = <WhatYouGet s={s} media={prepared.media} tracking={tracking} />;
      break;
    case "obstacles":
      inner = <Obstacles s={s} />;
      break;
    case "work":
      inner = <Work s={s} media={prepared.media} tracking={tracking} />;
      break;
    case "results":
      inner = <Results s={s} prepared={prepared} />;
      break;
    case "bonuses":
      inner = <Bonuses s={s} />;
      break;
    case "pricing":
      inner = <Pricing s={s} ctaLabel={prepared.ctaLabel} />;
      break;
    case "guarantee":
      inner = <Guarantee s={s} />;
      break;
    case "faq":
      inner = <Faq s={s} />;
      break;
  }
  return (
    <Section id={id} className="m-edge">
      {inner}
      {cta ? (
        <div className="mt-12 flex">
          <a href="#book" className={CTA_PRIMARY} data-section={s.key}>
            {cta}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </a>
        </div>
      ) : null}
    </Section>
  );
}

export { Facade as OfferFacade };
