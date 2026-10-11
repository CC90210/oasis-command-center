/**
 * OfferNav - the offer page's sticky header (design 2.3 and 2.5): the
 * workspace's mark, the pinned sections that are actually drawn, and the Book
 * button. Phones keep the mark and the button; the anchors are hidden there.
 *
 * Plain anchors: in-page links work without JavaScript, and Section's scroll-mt
 * keeps a heading clear of this bar. The mark is the one client piece
 * (SafeLogo), only so a mark that fails to load is hidden.
 */
import { CTA_PRIMARY } from "@/components/marketing/Cta";
import { SafeLogo } from "@/components/brand/SafeLogo";
import type { DrawnPage } from "@/lib/offer-pages/visibility";

export function OfferNav({
  nav,
  name,
  logoUrl,
  ctaLabel,
}: {
  nav: DrawnPage["nav"];
  name: string;
  logoUrl: string | null;
  ctaLabel: string;
}) {
  return (
    <header className="sticky top-0 z-50 border-b border-ops-line bg-ops-void/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-6 px-5 sm:px-8">
        <a href="#top" className="flex min-w-0 items-center gap-3" aria-label={`${name}, top of the page`}>
          {/* The workspace's own mark, any host; one that fails to load draws
              nothing (the name beside it stays), never a broken-image icon. */}
          <SafeLogo src={logoUrl} alt="" height={32} className="h-8 w-auto max-w-[9rem] object-contain" />
          <span className="truncate font-display text-[17px] font-bold tracking-[0.01em] text-fg">{name}</span>
        </a>
        {nav.length ? (
          <nav aria-label="On this page" className="hidden items-center gap-1 md:flex">
            {nav.map((n) => (
              <a
                key={n.key}
                href={`#${n.anchor}`}
                className="px-3 py-2 text-[15px] font-medium tracking-[-0.01em] text-fg-muted transition-colors hover:text-fg"
              >
                {n.label}
              </a>
            ))}
          </nav>
        ) : null}
        <a href="#book" className={`${CTA_PRIMARY} shrink-0 !px-4 !py-2`} data-section="nav">
          {ctaLabel}
        </a>
      </div>
    </header>
  );
}
