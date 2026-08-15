/* eslint-disable @typescript-eslint/no-require-imports -- next.config.js
   is a CommonJS module by convention; `import` would require renaming
   the file to .mjs which breaks the Vercel + standalone-build pipeline. */
const path = require("path");

// The browser client checks NEXT_PUBLIC_* env vars. If the operator only sets
// the BRAVO_* names (matching server-side conventions), mirror them here so
// the public client still resolves.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= process.env.BRAVO_SUPABASE_URL || "";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= process.env.BRAVO_SUPABASE_ANON_KEY || "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @napi-rs/canvas ships a platform-native .node binary (used by
  // lib/forms/signature-crop.ts on the autofill-application route).
  // Webpack can't parse a native binary, so it must stay an external
  // server-side require instead of being bundled — otherwise the Vercel
  // Linux build fails with "Module parse failed: Unexpected character".
  // @napi-rs/canvas ships a native .node binary webpack can't parse → external.
  // pdfjs-dist added 2026-06-28: bundling it into a chunk broke its worker
  // module lookup + its require("@napi-rs/canvas") (stale /vercel/path0 build
  // path → "fake worker failed" / "Cannot find module" on Vercel). Keeping it
  // external makes it run from node_modules with normal resolution — and copies
  // its wasm/fonts/cmaps/worker subdirs into the function alongside it.
  // @libsql/client + libsql added 2026-08-06: the Turso data-plane hybrid makes
  // supabase-server.ts import @libsql/client on every route, so its native
  // bindings now get traced — they must stay external or the build fails
  // (seen on nostalgic-requests' first Turso deploy).
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist", "@libsql/client", "libsql"],
  // 2026-08-14: preview builds started dying with SIGKILL / out_of_memory on
  // Vercel's 8 GB build container while the same commit built fine locally and
  // in production. Nothing was leaking — the app has simply grown to sit right
  // at the ceiling, so which side of it a given build lands on is luck. Two
  // preview builds OOM'd, one production build of the identical tree passed.
  //
  // webpackMemoryOptimizations trades a little build time for a materially
  // lower peak: webpack stops retaining module sources and caches it only
  // needs for incremental rebuilds, which a one-shot CI build never does.
  // Verified present in the installed Next's config schema (15.5.18) rather
  // than assumed from the docs.
  //
  // If this stops being enough, the next lever is Vercel's Enhanced Builds
  // (bigger machine, costs money — CC's call, not an agent's).
  experimental: {
    webpackMemoryOptimizations: true,
    // 2026-08-14, second pass. The build OOM'd again WITH the line above
    // active — the log shows "✓ webpackMemoryOptimizations" and then
    // "build worker exited with code: null and signal: SIGKILL". So it lowered
    // the peak but not below the ceiling, and which side of that line a build
    // lands on is still luck.
    //
    // The kill is in a build WORKER, and Vercel gives 4 cores with 8 GB. Next
    // sizes its worker pool from the CPU count by default, so four workers
    // divide 8 GB between them and a heavy route tips one over.
    // memoryBasedWorkersCount sizes the pool from available memory instead,
    // which is the dimension that is actually scarce here.
    //
    // Verified present in the installed Next's config schema (15.5.18) rather
    // than taken from the docs:
    //   grep -o memoryBasedWorkersCount node_modules/next/dist/server/config-schema.js
    //
    // If this is still not enough, the remaining lever is Vercel's Enhanced
    // Builds — a bigger machine that costs money, so that is CC's call.
    memoryBasedWorkersCount: true,
  },
  outputFileTracingRoot: path.join(__dirname),
  // lib/prompts/index.ts reads the .txt + .json prompt files at module init
  // via fs.readFileSync. Next.js's static tracer doesn't follow runtime paths,
  // so without an explicit include the prompts don't ship and the AI scoring
  // routes 500 on cold start with "ENOENT".
  outputFileTracingIncludes: {
    "/api/leads/*/score": ["./lib/prompts/**/*"],
    "/api/leads/*/next-action": ["./lib/prompts/**/*"],
    // Added 2026-06-07 after Playwright UI sweep caught the new
    // compose-checkin route 500'ing in production with ENOENT on
    // oasis-lead-scoring.txt — same root cause as the prior two
    // routes: lib/prompts/index.ts loads the .txt files at module
    // init via fs.readFileSync, which Next.js's static tracer doesn't
    // follow. Explicit include solves it.
    "/api/leads/*/compose-checkin": ["./lib/prompts/**/*"],
    // 2026-06-28: the bank-statement watermarker (lib/forms/watermark.ts) loads
    // pdfjs-dist's image-decoder WASM + JS fallbacks + fonts/cmaps at RUNTIME by
    // path (process.cwd()/node_modules/pdfjs-dist/...). Next's static tracer
    // can't follow runtime paths, so without these includes the assets don't
    // ship and real (scanned/encrypted) statements fail to rasterize on Vercel.
    // Bundle them into every route that can trigger watermarking.
    //
    // KEEP THIS LIST IN SYNC with the routes that import the watermark chain
    // (setLeadDocumentVariant / watermarkAttachmentsForShopOut /
    // ensureApplicationThreadsWatermarked / watermarkStoredBankStatement /
    // watermarkBankStatement). To re-derive it:
    //   grep -rl "setLeadDocumentVariant\|watermarkAttachmentsForShopOut\|\
    //     ensureApplicationThreadsWatermarked\|watermarkBankStatement" app --include=route.ts
    // A route that watermarks but is MISSING here still "works" for simple PDFs
    // (the pdf-lib overlay is pure JS) but silently degrades and then fails:
    //   - public/brand/sunbiz-logo.png absent -> the mark falls back to a tiled
    //     TEXT wordmark, so the same statement gets a DIFFERENT brand depending
    //     on which route branded it;
    //   - pdfjs wasm/fonts/cmaps/worker absent -> the raster fallback dies, and
    //     the raster fallback is the ONLY path for permission-encrypted bank
    //     PDFs (a large share of real statements, which pdf-lib cannot decrypt).
    //     Net effect: "can't watermark it" on exactly the files that need it.
    ...Object.fromEntries(
      [
        "/api/bridge/exec-tool",
        "/api/applications/*/shop-out",
        "/api/applications/*/shop-out/run",
        "/api/applications/*/lender-threads/retry-all",
        "/api/applications/*/lender-threads/*/retry",
        // 2026-08-03: MISSING since the 2026-06-29 variant-toggle shipped. This
        // is the operator's "Clean | WM" switch in the lead drawer + documents
        // viewer, so the one surface whose entire job is watermarking was the
        // one surface without the watermark assets.
        "/api/lead-documents/*/watermark-variant",
        // Retained: these two no longer watermark (statements have been stored
        // CLEAN since 2026-06-29) but they still read/serve statement bytes, and
        // the includes are cheap insurance if branding is ever re-added there.
        "/api/leads/*/documents",
        "/api/forms/submit",
      ].map((route) => [
        route,
        [
          "./node_modules/pdfjs-dist/wasm/**",
          "./node_modules/pdfjs-dist/standard_fonts/**",
          "./node_modules/pdfjs-dist/cmaps/**",
          "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
          // The watermark tiles this logo + registers LiberationSans-Bold (above)
          // so canvas text renders on Vercel (no system fonts there).
          "./public/brand/sunbiz-logo.png",
        ],
      ]),
    ),
  },
  // Standalone output for Docker — produces .next/standalone with a
  // self-contained server.js + trimmed node_modules. No effect on Vercel
  // (Vercel uses its own builder).
  output: "standalone",
  // Cached / external links to retired routes land cleanly on a live page
  // instead of bouncing through middleware (which would return 307→/login
  // for unauthenticated visitors because the path is no longer in
  // PUBLIC_PATH_PREFIXES). 308 = permanent redirect so search engines
  // update the canonical URL.
  async redirects() {
    return [
      {
        // The entry-path page moved off the brand apex when the marketing
        // site took over "/" (2026-07-31). /welcome had been shared
        // directly, so the old URL has to keep resolving.
        source: "/welcome",
        destination: "/start",
        permanent: true,
      },
      {
        source: "/command-centre-explained",
        destination: "/start",
        permanent: true,
      },
      // Inbound links from the previous marketing site
      // (oasis-ai-platform-iota.vercel.app). Both of its commercial pages
      // are consolidated into /work.
      {
        source: "/pricing",
        destination: "/work",
        permanent: true,
      },
      {
        source: "/services",
        destination: "/work",
        permanent: true,
      },
    ];
  },
  // Production security headers — applied to every response (including
  // static assets and 404s). Added 2026-06-06 alongside the oasisai.work
  // migration to harden the dashboard surface now that it sits at the
  // OASIS AI brand apex. CSP intentionally omitted — Next.js inlines
  // bootstrap script tags + RSC payloads, and a too-strict policy
  // breaks the App Router. Add CSP via report-only mode in a follow-up
  // if XSS becomes a real concern.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Lock browser into MIME-correct interpretation — defends
          // against attacker-uploaded files being interpreted as
          // scripts.
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Prevent the dashboard from being framed by any other site.
          // SAMEORIGIN over DENY so the desktop Electron wrapper (which
          // loads the dashboard in a BrowserView pointed at oasisai.work)
          // keeps working.
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          // Don't send full referrer cross-origin. strict-origin-when-cross-origin
          // matches what most modern browsers default to but pins it.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Disable browser features the dashboard doesn't need —
          // prevents an XSS-able vulnerability in a sub-component from
          // turning into a microphone/camera/geolocation hijack.
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self), payment=()" },
          // HTTPS-only for the next 2 years across every subdomain
          // (oasisai.work + bridge.oasisai.work + www.oasisai.work).
          // Safe to enable because the migration today established all
          // surfaces over HTTPS — the marketing-site fallback that used
          // to risk an HTTP downgrade is gone.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
