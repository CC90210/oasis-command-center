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
  },
  // Standalone output for Docker — produces .next/standalone with a
  // self-contained server.js + trimmed node_modules. No effect on Vercel
  // (Vercel uses its own builder).
  output: "standalone",
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
