/**
 * Form theme presets — SunBiz-branded looks for the public form page.
 *
 * Replaces the raw branding JSON textarea with a picker. Each theme maps
 * to a FormBranding object (primary_color, accent_color, headline style).
 * The names mirror the layout HTML files in ~/SunBiz-Agent/docs/ so the
 * operator can mentally connect the form page to the marketing surfaces
 * they already know.
 *
 * Outreach + email-only templates from that repo (ads, consolidation_blast,
 * grid_* campaigns, urgency_fast_funding, social_proof_testimonial) are
 * deliberately excluded — they're not form layouts and including them
 * would confuse operators who just want a clean intake form.
 */
import type { FormBranding } from "./types";

/**
 * Shared fallback colors for forms with no branding set. Both the prospect
 * render (FormPublicClient) and the shared FormRenderer use these so an
 * unbranded form is one consistent color, not two-tone (gold header + cyan
 * button). Match the SunBiz Standard theme.
 */
export const DEFAULT_PRIMARY_COLOR = "#E0A53F";
export const DEFAULT_ACCENT_COLOR = "#FFB81C";

export type FormTheme = {
  /** Stable key written into the branding object so the next load picks it back up. */
  id: string;
  /** Operator-facing name. */
  label: string;
  /** One-line description shown under the name. */
  description: string;
  /** Applied wholesale when the operator picks this theme. */
  branding: FormBranding;
};

export const FORM_THEMES: FormTheme[] = [
  {
    id: "sunbiz_standard",
    label: "SunBiz Standard",
    description: "Default SunBiz Funding intake — warm gold on charcoal, branded header.",
    branding: {
      primary_color: "#E0A53F",
      accent_color: "#FFB81C",
      headline: "SunBiz Funding",
      subheadline:
        "Business funding, fast — tell us about your business and we'll match you with the right capital.",
      thanks_message:
        "Thanks — we've got your details. A SunBiz Funding specialist will reach out within one business day.",
    },
  },
  {
    id: "minimal_clean",
    label: "Minimal Clean",
    description: "Neutral palette, big type. Good when the brand is already known.",
    branding: {
      primary_color: "#111827",
      accent_color: "#0ea5e9",
      headline: "Apply for funding",
      subheadline: "Three minutes. No credit pull.",
      thanks_message: "We've got it. Watch your inbox.",
    },
  },
  {
    id: "premium_executive",
    label: "Premium Executive",
    description: "Deep navy + brass — for high-revenue accounts.",
    branding: {
      primary_color: "#1e293b",
      accent_color: "#b45309",
      headline: "Executive Funding Application",
      subheadline:
        "Verified underwriting in 24 hours. Confidential intake.",
      thanks_message:
        "Your application is in. A senior funding officer will reach out personally.",
    },
  },
  {
    id: "problem_solution",
    label: "Problem · Solution",
    description: "Direct, copy-led layout for cold inbound traffic.",
    branding: {
      primary_color: "#dc2626",
      accent_color: "#0ea5e9",
      headline: "Get funded in days, not months",
      subheadline:
        "Tell us where you're stuck. We'll match you with capital that fits.",
      thanks_message:
        "Got it. We'll come back with a path forward within one business day.",
    },
  },
];

export function getFormTheme(id: string | null | undefined): FormTheme | null {
  if (!id) return null;
  return FORM_THEMES.find((t) => t.id === id) || null;
}

/**
 * Pick a readable text color (near-black or white) for text laid over the
 * tenant's brand color. The default SunBiz gold (#E0A53F) is light, so the
 * hardcoded white CTA text scored ~2.2:1 — below WCAG AA. Compute from the
 * background's relative luminance instead so light brands get dark text and
 * dark brands get white. Used by every primary CTA (form submit + the
 * interest-form continue-now buttons).
 */
export function getContrastingTextColor(hex: string | null | undefined): string {
  const raw = (hex || "").replace("#", "").trim();
  const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  const n = Number.parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(n)) return "#ffffff";
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  // Threshold ~0.4: dark text for gold/light brands, white for navy/charcoal.
  return luminance > 0.4 ? "#111827" : "#ffffff";
}

/**
 * Detects which preset (if any) matches the current branding, so the
 * builder can highlight the active theme even on a form created before
 * the picker existed. Match is by primary_color + headline because those
 * are the two fields most likely to be unique across themes.
 */
export function inferActiveThemeId(
  branding: FormBranding | null | undefined,
): string | null {
  if (!branding) return null;
  for (const t of FORM_THEMES) {
    if (
      t.branding.primary_color === branding.primary_color &&
      t.branding.headline === branding.headline
    ) {
      return t.id;
    }
  }
  return null;
}
