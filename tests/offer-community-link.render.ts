/**
 * Spawned by tests/offer-community-link.test.ts as a PLAIN node process (same
 * reason as tests/book-meet-panel.render.ts: CommunityLink is a client
 * component and cannot render under --conditions=react-server).
 * Prints one JSON object { state: markup }.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommunityLink } from "../components/offer-pages/CommunityLink";

const out: Record<string, string> = {
  configured: renderToStaticMarkup(
    React.createElement(CommunityLink, { tenantSlug: "oasis-ai-cc", formSlug: "protocol", configured: true }),
  ),
  notConfigured: renderToStaticMarkup(
    React.createElement(CommunityLink, { tenantSlug: "other-co", formSlug: "intake", configured: false }),
  ),
  previewNullSlugs: renderToStaticMarkup(
    React.createElement(CommunityLink, { tenantSlug: null, formSlug: null, configured: true }),
  ),
};

console.log(JSON.stringify(out));
