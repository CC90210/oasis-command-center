/**
 * components/marketplace/builder-paths.ts - where the custom-agent builder
 * (CustomAgentBuilder.tsx) sends people, by the page it is mounted on.
 *
 *   "marketplace"  /t/<slug>/marketplace/new: a saved agent opens on its
 *                  marketplace page, a delete lands on the marketplace.
 *   "ai-team"      /agents/new (W1a review R4): a saved teammate opens in its
 *                  chat (/agents/<slug>), a delete lands on the AI team
 *                  (/agents), so an owner who started at AI team > New
 *                  teammate never ends up back in the marketplace.
 *
 * Plain data and functions, no React, so a test reads it directly. A server
 * page passes the builder only the `home` word: a function cannot cross into a
 * client component.
 */

export type BuilderHome = "marketplace" | "ai-team";

export type BuilderPaths = {
  /** Where a saved agent opens. */
  saved: (agentSlug: string) => string;
  /** Where a delete lands. */
  afterDelete: string;
  /** The URL-slug field's hint. */
  slugHint: (agentSlug: string) => string;
  /** Shown while a newly created agent opens. */
  createdNote: string;
};

export function builderPaths(tenantSlug: string, home: BuilderHome = "marketplace"): BuilderPaths {
  if (home === "ai-team") {
    return {
      saved: (agentSlug) => `/agents/${encodeURIComponent(agentSlug)}`,
      afterDelete: "/agents",
      slugHint: (agentSlug) => `Chat URL: /agents/${agentSlug}`,
      createdNote: "Created. Opening its chat...",
    };
  }
  return {
    saved: (agentSlug) => `/t/${tenantSlug}/marketplace/${agentSlug}`,
    afterDelete: `/t/${tenantSlug}/marketplace`,
    slugHint: (agentSlug) => `Marketplace URL: /t/${tenantSlug}/marketplace/${agentSlug}`,
    createdNote: "Created. Redirecting to the marketplace...",
  };
}
