/**
 * Spawned by tests/offer-nav-phone-menu.test.ts as a PLAIN node process
 * (OfferNavMenu is a client component and cannot render under
 * --conditions=react-server; same reason as tests/offer-preview-form.render.ts).
 *
 * Renders the offer header with the sections an offer page pins, and with
 * none, and prints one JSON object { withNav, withoutNav }.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OfferNav } from "../components/offer-pages/OfferNav";

type Nav = Parameters<typeof OfferNav>[0]["nav"];
const nav = [
  { key: "obstacles", anchor: "obstacles", label: "Challenges" },
  { key: "what_you_get", anchor: "what-you-get", label: "What you get" },
  { key: "pricing", anchor: "pricing", label: "Pricing" },
  { key: "faq", anchor: "faq", label: "FAQ" },
] as unknown as Nav;

const props = { name: "OASIS AI", logoUrl: null, ctaLabel: "Request the audit" };
process.stdout.write(
  JSON.stringify({
    withNav: renderToStaticMarkup(React.createElement(OfferNav, { ...props, nav })),
    withoutNav: renderToStaticMarkup(React.createElement(OfferNav, { ...props, nav: [] as unknown as Nav })),
  }),
);
