import type { ReactNode } from "react";

/**
 * Shared page furniture for the marketing site.
 *
 * The eyebrow is the site's one structural device: a mono label behind a
 * short rule, reading as a console section header. It is used for every
 * section on every page, and nothing else is. Consistency is what makes it
 * read as a system instead of as decoration.
 */

export function Section({
  children,
  className = "",
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      // scroll-mt clears the sticky header — without it an in-page anchor
      // drops the section's first line behind the nav bar.
      className={`px-5 py-20 sm:px-8 sm:py-28 ${id ? "scroll-mt-20" : ""} ${className}`}
    >
      <div className="mx-auto w-full max-w-6xl">{children}</div>
    </section>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="m-eyebrow font-data text-[10px] uppercase tracking-[0.26em] text-signal">
      {children}
    </p>
  );
}

export function SectionHead({
  eyebrow,
  title,
  lede,
}: {
  eyebrow: string;
  title: ReactNode;
  lede?: ReactNode;
}) {
  return (
    <header className="max-w-2xl">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="mt-5 font-display text-[clamp(1.9rem,4vw,2.9rem)] font-bold leading-[1.08] tracking-tight text-fg">
        {title}
      </h2>
      {lede ? (
        <p className="mt-5 text-[16px] leading-relaxed text-fg-muted sm:text-[17px]">
          {lede}
        </p>
      ) : null}
    </header>
  );
}
