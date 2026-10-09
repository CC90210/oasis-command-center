/**
 * Accent classes for offer pages, in one place. Every one reads the --accent
 * variable the page sets on its root (the offer's colour, signal cyan by
 * default), the same variable the marketing CTAs and eyebrows read, so an
 * offer changes one value and the whole page follows.
 *
 * Literal strings on purpose: Tailwind generates CSS only for class names it
 * can read in the source.
 */
export const ACCENT_TEXT = "text-[color:var(--accent,#00D4FF)]";
export const ACCENT_FILL = "bg-[color:var(--accent,#00D4FF)]";
export const ACCENT_RULE = "bg-[color:color-mix(in_srgb,var(--accent,#00D4FF)_55%,transparent)]";
export const ACCENT_BORDER = "border-[color:color-mix(in_srgb,var(--accent,#00D4FF)_40%,transparent)]";
export const ACCENT_WASH = "bg-[color:color-mix(in_srgb,var(--accent,#00D4FF)_7%,transparent)]";

/** The mono label used for numerals and chips. */
export const DATA_LABEL = "font-data text-[11px] uppercase tracking-[0.22em]";

/** Section heading, the marketing site's scale. */
export const H2 = "font-display text-[clamp(1.9rem,4vw,2.9rem)] font-bold leading-[1.08] tracking-tight text-fg";
export const LEDE = "text-[16px] leading-relaxed text-fg-muted sm:text-[17px]";
