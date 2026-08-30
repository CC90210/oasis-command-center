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
    // Vercel builds this on 4 cores / 8 GB and kept OOM-killing a build worker.
    // Three passes, and the middle one was mine being wrong:
    //
    // 1. webpackMemoryOptimizations — real, kept. Webpack stops retaining module
    //    sources and caches only useful for incremental rebuilds, which a
    //    one-shot CI build never does. Lowered the peak; not below the ceiling.
    //
    // 2. memoryBasedWorkersCount — REMOVED, it was a no-op. A reviewer said it
    //    enforces a floor of four workers and I checked the installed source
    //    rather than argue (node_modules/next/dist/build/index.js:307):
    //
    //      return Math.max(Math.min(cpus || 1, Math.floor(os.freemem() / 1e9)),
    //        4);   // enforce a minimum of 4 workers
    //
    //    The default with no config is also 4, so on this box it changed
    //    nothing. I had shipped it as a fix.
    //
    // 3. cpus — the actual lever. It is checked FIRST in getNumberOfWorkers and
    //    returns directly, with no floor applied:
    //
    //      if (config.experimental.cpus && cpus !== defaultConfig...cpus)
    //        return config.experimental.cpus;
    //
    //    Two workers instead of four halves the concurrent build memory. It
    //    costs build time, which is the right thing to spend when the scarce
    //    resource is RAM and the failure mode is a SIGKILL.
    //
    // 4. THE ACTUAL CAUSE, found 2026-08-16 by measuring instead of reasoning.
    //    The build does not need 8 GB and never did. Capping V8's heap and
    //    rebuilding from a cold .next:
    //
    //      --max-old-space-size=3072  -> Compiled successfully in 39.8s, 40/40
    //      --max-old-space-size=2048  -> Compiled successfully in 38.8s, 40/40
    //
    //    Real per-worker demand is under 2 GB. What kills the Vercel build is
    //    that V8 with NO cap sizes its heap against the CONTAINER, so each
    //    worker grows toward 8 GB whether or not it needs to. Two of them do it
    //    at once, the container runs out, and one gets SIGKILLed. That is why
    //    the failures burn 38-46 minutes first — a GC death spiral at the
    //    ceiling, making no progress — and why the identical tree passes as
    //    often as it fails. It was never a leak or a size problem; it was an
    //    unbounded heap on a bounded machine.
    //
    //    Fixed in vercel.json, not here: Next has no config knob for the heap,
    //    so the cap rides on the buildCommand as
    //    `NODE_OPTIONS='--max-old-space-size=5120' next build`.
    //
    // 5. WHY ONE WORKER AND 5 GB RATHER THAN TWO AND 3 GB. The first attempt was
    //    3072 x 2, sized from the local measurement above. Vercel rejected the
    //    premise: a worker hit that ceiling and aborted in 36 SECONDS.
    //
    //      FATAL ERROR: Reached heap limit Allocation failed
    //      Next.js build worker exited with code: null and signal: SIGABRT
    //
    //    The local number was measured on a build with no cache, because the
    //    test did `rm -rf .next` first. Vercel restores one — "Restored build
    //    cache from previous deployment" — and deserializing that cache lives
    //    in the same heap, so the real ceiling there is higher than anything a
    //    cold local build can show. Measuring the wrong machine measured the
    //    wrong number.
    //
    //    So: cpus 1 instead of 2, and the freed budget goes to the one worker.
    //    5 GB + parent + install overhead fits inside 8 GB with room, and there
    //    is no second worker to race for it. Build time is the cost, and it is
    //    the right thing to spend when the scarce resource is RAM.
    //
    //    NODE_OPTIONS reaches the workers, which is the half worth checking
    //    rather than assuming — jest-worker children inherit the parent env.
    //    Verified by setting an absurd 180 MB cap and watching the failure land
    //    where it should: "Next.js build worker exited with code: 134", V8's own
    //    heap error inside the WORKER, not a container SIGKILL.
    //
    //    Bonus: a capped build that genuinely runs out now fails in seconds with
    //    "JavaScript heap out of memory" instead of thrashing for 46 minutes and
    //    dying to an opaque signal.
    //
    // Enhanced Builds (a bigger machine, costs money) is therefore NOT needed,
    // and was the wrong lever to reach for — it would have paid to accommodate
    // an unbounded heap rather than bounding it.
    webpackMemoryOptimizations: true,
    // 1, not 2 — see note 5 above. Two workers each entitled to a multi-GB heap
    // is what exhausted the container; one worker cannot race itself.
    cpus: 1,
  },
  outputFileTracingRoot: path.join(__dirname),
  // lib/prompts/index.ts reads the .txt + .json prompt files at module init
  // via fs.readFileSync. Next.js's static tracer doesn't follow runtime paths,
  // so without an explicit include the prompts don't ship and the AI scoring
  // routes 500 on cold start with "ENOENT".
  outputFileTracingIncludes: {
    // 2026-08-29 (Cloudflare migration): the OpenNext bundle step needs the
    // COMPLETE @libsql/client family in the traced tree — the default trace
    // copies it partially ("lib-esm/web.js not found") and hrana's ws shim
    // not at all. Gated on CF_MIGRATION_BUILD (set by wrangler_tool.py builds
    // only): a global include participates in VERCEL function packaging too
    // and would bloat every function there (codex audit 2026-08-30).
    ...(process.env.CF_MIGRATION_BUILD === "1"
      ? {
          "/**/*": [
            "./node_modules/@libsql/client/**/*",
            "./node_modules/@libsql/core/**/*",
            "./node_modules/@libsql/hrana-client/**/*",
            "./node_modules/@libsql/isomorphic-ws/**/*",
            "./node_modules/@libsql/isomorphic-fetch/**/*",
            "./node_modules/js-base64/**/*",
          ],
        }
      : {}),
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
        // 2026-08-30: signature-crop consumer (extract-signature flow).
        "/api/internal/apply-extraction",
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
          // 2026-08-30 (codex audit): lib/forms/native-raster.ts now loads the
          // native raster stack via a bundler-opaque dynamic import, which
          // hides the dependency edge from output tracing too — without these
          // the packaged Vercel functions would lack the packages entirely and
          // watermark/signature-crop would silently regress to ok:false.
          // Excluded from CF builds (unreachable there; @napi-rs store entries
          // also EPERM on the Windows OpenNext copy step).
          ...(process.env.CF_MIGRATION_BUILD === "1"
            ? []
            : [
                "./node_modules/@napi-rs/**",
                "./node_modules/sharp/**",
                "./node_modules/@img/**",
                "./node_modules/pdfjs-dist/legacy/**",
                "./node_modules/pdfjs-dist/package.json",
              ]),
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
