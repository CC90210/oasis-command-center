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

export const CTA_PRIMARY =
  "inline-flex items-center justify-center gap-2.5 rounded-sm bg-signal px-6 py-3.5 font-data text-[13px] font-medium uppercase tracking-[0.16em] text-ops-void transition-opacity hover:opacity-90 disabled:opacity-60";

export const CTA_SECONDARY =
  "inline-flex items-center justify-center gap-2.5 rounded-sm border border-ops-edge px-6 py-3.5 font-data text-[13px] uppercase tracking-[0.16em] text-fg-muted transition-colors hover:border-signal/50 hover:text-fg";

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
