import type { Metadata } from "next";
import { Space_Grotesk, Inter_Tight, JetBrains_Mono } from "next/font/google";
import { Ambient } from "@/components/marketing/Ambient";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { SITE_ORIGIN } from "@/lib/marketing/routes";
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
 * next/font self-hosts them, so there is no runtime request to Google and
 * no third-party added to the subprocessor list.
 */

const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

const body = Inter_Tight({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
  display: "swap",
});

const data = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
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
      {/* One fixed atmosphere behind the entire site. Each page used to
          mount its own hero-height backdrop, so everything below the fold
          was flat black — the reason the site felt like it stopped having
          a design after the first screen. */}
      <Ambient />
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded focus:bg-signal focus:px-4 focus:py-2 focus:font-data focus:text-sm focus:font-medium focus:text-ops-void"
      >
        Skip to content
      </a>
      <MarketingNav />
      <main id="main">{children}</main>
      <MarketingFooter />
    </div>
  );
}
