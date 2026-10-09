import localFont from "next/font/local";

/**
 * The marketing site's faces, for offer pages (components/offer-pages/OfferPage.tsx).
 *
 * SAME FILES, WEIGHTS AND VARIABLES as app/(marketing)/layout.tsx declares,
 * self-hosted for the reason given there (next/font/google downloads at build
 * time, and that download has failed deploys; tests/font-selfhost.test.ts).
 * tests/marketing-accent-parity.test.ts fails if the two declarations drift.
 *
 * WHY A SECOND DECLARATION, WITH PRELOAD OFF. next/font preloads every face
 * declared in any module a route imports, whether or not the page draws it
 * (its font manifest is built per route entry). Offer pages share
 * /f/<workspace>/<form> with every plain form, so importing the marketing
 * layout's set here would make every plain form page download eight font
 * files it never draws. With preload off nothing downloads until text set in
 * one of these faces is drawn, and display: swap shows that text at once in
 * the fallback face. The only trace on a plain form page is the one
 * same-origin preconnect Next adds for a route whose fonts do not preload.
 */

const offerDisplay = localFont({
  src: [
    { path: "./SpaceGrotesk-500.woff2", weight: "500", style: "normal" },
    { path: "./SpaceGrotesk-600.woff2", weight: "600", style: "normal" },
    { path: "./SpaceGrotesk-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-display",
  display: "swap",
  preload: false,
});

const offerBody = localFont({
  src: [
    { path: "./InterTight-400.woff2", weight: "400", style: "normal" },
    { path: "./InterTight-500.woff2", weight: "500", style: "normal" },
    { path: "./InterTight-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-body",
  display: "swap",
  preload: false,
});

const offerData = localFont({
  src: [
    { path: "./JetBrainsMono-400.woff2", weight: "400", style: "normal" },
    { path: "./JetBrainsMono-500.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-data",
  display: "swap",
  preload: false,
});

/** The class names that put the marketing faces on an offer page's root. */
export const offerFontVariables = `${offerDisplay.variable} ${offerBody.variable} ${offerData.variable}`;
