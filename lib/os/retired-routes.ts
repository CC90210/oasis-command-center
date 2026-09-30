/**
 * lib/os/retired-routes.ts - the answer a retired page gives: HTTP 404, before
 * anything renders.
 *
 * WHY NOT notFound(). The legacy SunBiz pages retired on 2026-09-30 (/contacts,
 * /embed, /offers, /lenders, /funded-deals, /applications, /sms, /email-blast,
 * /metrics, /templates, /renewals) first became pages that call notFound(). That
 * draws the not-found screen, but the response status was 200: the root
 * app/loading.tsx is a Suspense boundary around every page, so the shell (and
 * its 200) has streamed before the page runs. A browser, a crawler and a
 * monitor all read 200 as "this page exists". A route handler answers before
 * any rendering starts, so its status is the one the client gets.
 *
 * Each retired folder holds only a route.ts whose GET returns
 * retiredRouteResponse(); it must not also hold a page.tsx (Next refuses both).
 * tests/client-route-gating.test.ts calls each GET and checks the 404, and
 * tests/os-redirects.test.ts treats a folder like that as retired, so nothing
 * in app/, components/ or lib/ may link to one.
 *
 * The body is plain HTML with its own styles (the app's stylesheet is not
 * loaded for a route handler) in the OS's dark palette. ASCII only: the shipped
 * Worker may not carry a character above U+00FF (tests/worker-source-one-byte).
 */

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page not found</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem;
    background: #020409; color: #f5f7fa; font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif; }
  main { max-width: 28rem; width: 100%; border: 1px solid #1e2532; border-radius: 16px; background: #0b0f17; padding: 1.75rem; text-align: center; }
  h1 { font-size: 1.125rem; margin: 0 0 0.375rem; }
  p { font-size: 0.875rem; color: #9ba3b1; line-height: 1.55; margin: 0 0 1.25rem; }
  a { display: inline-block; padding: 0.5rem 1rem; border-radius: 6px; background: #3b82f6; color: #020409; font-weight: 700; font-size: 0.875rem; text-decoration: none; }
</style>
</head>
<body>
<main>
<h1>Page not found</h1>
<p>That page is no longer part of the Command Center.</p>
<a href="/">Back to Today</a>
</main>
</body>
</html>
`;

/** A 404 with the not-found page, for a retired route's GET. */
export function retiredRouteResponse(): Response {
  return new Response(HTML, {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });
}
