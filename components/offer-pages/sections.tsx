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
import { ArrowRight } from "lucide-react";
import { Section, Eyebrow } from "@/components/marketing/Section";
import { Reveal } from "@/components/marketing/Reveal";
import { CTA_INLINE, CTA_PRIMARY } from "@/components/marketing/Cta";
import type { DrawnSection } from "@/lib/offer-pages/visibility";
import { formatMoney } from "@/lib/offer-pages/visibility";
import { BODY_ANCHORS } from "@/lib/offer-pages/types";
import type { FacadeMedia, PreparedOffer } from "@/lib/offer-pages/render";
import { imageKey } from "@/lib/offer-pages/video";
import { VideoFacade } from "./VideoFacade";
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

function Facade({ media, label, priority = false }: { media: FacadeMedia | undefined; label: string; priority?: boolean }) {
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
    />
  );
}

function WhatYouGet({ s, media }: { s: Extract<DrawnSection, { key: "what_you_get" }>; media: PreparedOffer["media"] }) {
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
                  <Facade media={media[it.video.ref]} label={it.title} />
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

function Work({ s, media }: { s: Extract<DrawnSection, { key: "work" }>; media: PreparedOffer["media"] }) {
  return (
    <>
      <OfferHead head={s.head} />
      <div className="mt-12 grid gap-10 md:grid-cols-2">
        {s.items.map((it, i) => (
          <Reveal key={it.index} delay={(i % 2) * 80}>
            <figure className="space-y-4">
              <Facade media={media[it.video.ref]} label={it.title || "Our work"} />
              {it.title || it.body ? (
                <figcaption>
                  {it.title ? <p className="font-display text-lg font-bold tracking-tight text-fg">{it.title}</p> : null}
                  {it.body ? <p className="mt-1.5 text-[15px] leading-relaxed text-fg-muted">{it.body}</p> : null}
                </figcaption>
              ) : null}
            </figure>
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
export function OfferSection({ s, prepared, cta = null }: { s: DrawnSection; prepared: PreparedOffer; cta?: string | null }): ReactNode {
  const id = BODY_ANCHORS[s.key];
  let inner: ReactNode;
  switch (s.key) {
    case "what_you_get":
      inner = <WhatYouGet s={s} media={prepared.media} />;
      break;
    case "obstacles":
      inner = <Obstacles s={s} />;
      break;
    case "work":
      inner = <Work s={s} media={prepared.media} />;
      break;
    case "results":
      inner = <Results s={s} prepared={prepared} />;
      break;
    case "bonuses":
      inner = <Bonuses s={s} />;
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
