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
  },
  // Standalone output for Docker — produces .next/standalone with a
  // self-contained server.js + trimmed node_modules. No effect on Vercel
  // (Vercel uses its own builder).
  output: "standalone",
};

module.exports = nextConfig;
