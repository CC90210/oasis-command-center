import Link from "next/link";
import { ArrowRight } from "lucide-react";

/**
 * The site's call-to-action styling, in one place.
 *
 * This was four hand-copied class strings across home / work / about /
 * AuditForm. That is fine until CC wants the button to look different,
 * at which point it is four edits and four chances to miss one — on the
 * one element the whole site exists to get clicked.
 *
 * The class constants are exported separately because not every CTA is a
 * link: AuditForm's is a real submit button and the nav's is a compact
 * variant. Those import the string; everything else uses <CtaLink>.
 */

/**
 * TYPOGRAPHY NOTE. These were mono, uppercase, and wide-tracked, matching
 * the eyebrows and the roster readouts. With the nav, every button, and
 * every inline link set the same way, the whole page was shouting in
 * monospace and nothing stood out because everything did.
 *
 * The mono face is now reserved for text that is genuinely data — eyebrows,
 * status readouts, callsigns, field labels, timestamps. Anything a person
 * reads as a sentence, including the label on a button, is set in the body
 * face at a comfortable size. Buttons keep their weight and their size; they
 * lost the costume.
 */
export const CTA_PRIMARY =
  "inline-flex items-center justify-center gap-2 rounded-md bg-signal px-6 py-3 text-[15px] font-semibold tracking-[-0.01em] text-ops-void transition-all hover:brightness-110 disabled:opacity-60";

export const CTA_SECONDARY =
  "inline-flex items-center justify-center gap-2 rounded-md border border-ops-edge px-6 py-3 text-[15px] font-medium tracking-[-0.01em] text-fg-muted transition-colors hover:border-fg-dim hover:text-fg";

/** Inline "read more" link. Sentence case, arrow carries the affordance. */
export const CTA_INLINE =
  "inline-flex items-center gap-1.5 text-[15px] font-medium text-signal transition-colors hover:text-fg";

export function CtaLink({
  href,
  children,
  variant = "primary",
  /** Set for off-site destinations — opens in a new tab with rel guards. */
  external = false,
  /** The arrow is the affordance; drop it only where it would read as noise. */
  arrow = true,
  className = "",
}: {
  href: string;
  children: React.ReactNode;
  variant?: "primary" | "secondary";
  external?: boolean;
  arrow?: boolean;
  className?: string;
}) {
  const cls = `${variant === "primary" ? CTA_PRIMARY : CTA_SECONDARY} ${className}`;
  const inner = (
    <>
      {children}
      {arrow ? <ArrowRight className="h-4 w-4" aria-hidden="true" /> : null}
    </>
  );

  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
        {inner}
      </a>
    );
  }

  return (
    <Link href={href} className={cls}>
      {inner}
    </Link>
  );
}
