import type { MetadataRoute } from "next";
import { SITE_ORIGIN } from "@/lib/marketing/routes";

/**
 * robots.txt.
 *
 * Allow the marketing pages, disallow the application. Everything under
 * the operator surface is auth-gated anyway, so this is not a security
 * control — it stops crawlers burning budget on paths that will only ever
 * return a login redirect, and keeps the personalised form links
 * (/f/<tenant>/<form>/<token>) out of any index.
 *
 * Note "/home" is disallowed on purpose: it is the rewrite target for "/",
 * so indexing it would put the same page in twice under the wrong URL.
 * "/" itself is NOT disallowed — that is the homepage.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/home", // rewrite target for "/" — see lib/marketing/routes.ts
          "/f/", // personalised lead forms
          "/sign/", // e-signature sessions
          "/invite/",
          "/t/", // tenant-scoped operator surfaces
          "/demo/",
          "/unsubscribe",
          "/login",
          "/signup",
          "/forgot-password",
          "/auth/",
          "/onboarding",
        ],
      },
    ],
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
    host: SITE_ORIGIN,
  };
}
