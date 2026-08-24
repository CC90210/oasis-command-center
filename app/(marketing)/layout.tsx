import type { Metadata } from "next";
import localFont from "next/font/local";
import { Ambient } from "@/components/marketing/Ambient";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { CONTACT_EMAIL, SITE_ORIGIN } from "@/lib/marketing/routes";
import "./marketing.css";

/**
 * Marketing shell — nav, footer, type, and the progressive-enhancement
 * switch, for every public page.
 *
 * This is a route GROUP: "(marketing)" contributes nothing to any URL, so
 * app/(marketing)/fleet/page.tsx still serves /fleet. It nests inside the
 * root layout's full-bleed branch, which is why every path here must also
 * appear in lib/marketing/routes.ts — miss one and the root layout wraps
 * it in the operator sidebar and runs a tenant-manifest resolution for a
 * visitor with no account.
 *
 * Fonts are declared here rather than in the root layout on purpose. The
 * dashboard renders on a system-font stack and has no webfont in its
 * critical path; loading three faces globally would put a network fetch in
 * front of every operator's first paint to style pages they never see.
 * The files are vendored into app/fonts/ and loaded with next/font/local —
 * still self-hosted at runtime, and no longer fetched from Google at BUILD
 * time either, which is what kept breaking deploys. See the note below.
 */

/**
 * SELF-HOSTED, NOT next/font/google — because the build kept failing.
 *
 * `next/font/google` fetches the font binaries from fonts.gstatic.com AT BUILD
 * TIME. When that fetch fails the whole build fails, and it fails for reasons
 * that have nothing to do with the change being built:
 *
 *   2026-08-14  GitHub Actions  Failed to fetch `Space Grotesk` from Google Fonts
 *   2026-08-13  Vercel 104cd22  same, 3 retries, then `next build` exited 1
 *                               (Vercel labels it "lint_or_type_error", which
 *                                sent the first diagnosis in the wrong direction)
 *
 * Two failed deploys in two days from an unrelated third party, on a build that
 * is otherwise deterministic. CC, 2026-08-14: "make sure that all functionality
 * throughout the software is built and then correctly maintained so that, down
 * the line, when things get changed, it doesn't affect it in any way that causes
 * it to break for some random reason." A network call in a build step is exactly
 * that class of thing.
 *
 * The .woff2 files now live in app/fonts/ (latin subset, the same files Google
 * was serving — 146 KB total). Nothing about the rendered output changes: the
 * same faces, the same weights, the same --font-* variable names. next/font
 * still self-hosts and still emits no runtime request to Google, so the privacy
 * and subprocessor position is unchanged; the build simply no longer needs the
 * internet.
 *
 * Licensing: Space Grotesk, Inter Tight and JetBrains Mono are all SIL Open Font
 * License 1.1, which explicitly permits redistribution. See app/fonts/OFL.md.
 */
const display = localFont({
  src: [
    { path: "../fonts/SpaceGrotesk-500.woff2", weight: "500", style: "normal" },
    { path: "../fonts/SpaceGrotesk-600.woff2", weight: "600", style: "normal" },
    { path: "../fonts/SpaceGrotesk-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-display",
  display: "swap",
});

const body = localFont({
  src: [
    { path: "../fonts/InterTight-400.woff2", weight: "400", style: "normal" },
    { path: "../fonts/InterTight-500.woff2", weight: "500", style: "normal" },
    { path: "../fonts/InterTight-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-body",
  display: "swap",
});

const data = localFont({
  src: [
    { path: "../fonts/JetBrainsMono-400.woff2", weight: "400", style: "normal" },
    { path: "../fonts/JetBrainsMono-500.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-data",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: {
    default: "OASIS AI — Operational agentic systems",
    template: "%s · OASIS AI",
  },
  description:
    "Operational Agentic Systems Increasing Scalability. OASIS builds AI agents that hold a seat in your business — operations, marketing, finance, legal — and the systems they run on.",
  openGraph: {
    type: "website",
    siteName: "OASIS AI",
    locale: "en_CA",
  },
  twitter: { card: "summary_large_image" },
};

/**
 * Marks the document as script-capable BEFORE first paint, so marketing.css
 * can hide things it knows JavaScript will be able to reveal. Without this
 * running early there would be a flash of the enhanced state; without it
 * running at all — JS disabled, script blocked, an error earlier in the
 * page — every reveal stays visible and the site reads as a normal
 * document. That is the fallback, not a degraded mode.
 */
const JS_FLAG = `document.documentElement.classList.add('js')`;

/**
 * Entity identity for search and AI assistants.
 *
 * The OG/Twitter metadata above tells a crawler how to RENDER a link. This
 * tells it WHO the link is about, which is the part an assistant needs before
 * it will name us in an answer. "OASIS AI" is a generic-sounding string that
 * collides with several unrelated products, so the job here is to pin the
 * entity to a domain and an email that nothing else shares.
 *
 * WHAT IS DELIBERATELY ABSENT:
 *   - `offers` / any price. Engagements are scoped individually and no public
 *     figure exists. Structured data that states a price we do not publish is
 *     how an assistant ends up quoting a number to a prospect that we then have
 *     to walk back.
 *   - `sameAs`. It should list the real GitHub / LinkedIn / X profiles, and
 *     guessing URLs that 404 actively damages entity resolution. Add them here
 *     once the handles are confirmed.
 */
const ORGANIZATION_JSONLD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": `${SITE_ORIGIN}/#organization`,
  name: "OASIS AI",
  alternateName: "Operational Agentic Systems Increasing Scalability",
  url: SITE_ORIGIN,
  email: CONTACT_EMAIL,
  description:
    "OASIS builds AI agents that hold a seat in a business — operations, marketing, finance, legal — and the systems they run on.",
  knowsAbout: [
    "AI agents",
    "business process automation",
    "agentic systems",
    "operations automation",
  ],
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "sales",
    email: CONTACT_EMAIL,
    url: `${SITE_ORIGIN}/contact`,
  },
};

const WEBSITE_JSONLD = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": `${SITE_ORIGIN}/#website`,
  url: SITE_ORIGIN,
  name: "OASIS AI",
  publisher: { "@id": `${SITE_ORIGIN}/#organization` },
  inLanguage: "en-CA",
};

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      className={`marketing ${display.variable} ${body.variable} ${data.variable} min-h-screen bg-ops-void font-body text-fg antialiased`}
    >
      <script dangerouslySetInnerHTML={{ __html: JS_FLAG }} />
      {/* JSON-LD is emitted from the layout so every marketing page carries the
          same entity identity. Rendering it per-page invites drift, and an
          assistant that sees two different @id values for one organisation
          resolves neither. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(ORGANIZATION_JSONLD) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(WEBSITE_JSONLD) }}
      />
      {/* One fixed atmosphere behind the entire site. Each page used to
          mount its own hero-height backdrop, so everything below the fold
          was flat black — the reason the site felt like it stopped having
          a design after the first screen. */}
      <Ambient />
      <a
        href="#main"
        className="m-skip rounded-md bg-signal px-4 py-2 text-sm font-semibold text-ops-void"
      >
        Skip to content
      </a>
      <MarketingNav />
      <main id="main">{children}</main>
      <MarketingFooter />
    </div>
  );
}
