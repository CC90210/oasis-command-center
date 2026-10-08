/**
 * scripts/gen-og-card.ts - render the marketing share card to the PNG file
 * Next serves for it, so the Worker serves fixed bytes instead of bundling an
 * image renderer.
 *
 * WHY. app/(marketing)/opengraph-image.tsx used to return
 * `new ImageResponse(...)` from next/og on every request. On the Cloudflare
 * Worker that put @vercel/og into the upload (OpenNext includes it whenever a
 * route's file trace reaches it): the Satori library, resvg.wasm, yoga.wasm
 * and a fallback font, about 2 MiB of the 64 MiB limit, to draw one card that
 * has no inputs and so renders the same bytes every time.
 *
 * WHAT IT WRITES (committed): app/(marketing)/opengraph-image.png, the PNG that
 * lib/marketing/og-card.tsx renders. That is Next's static metadata-image
 * convention: Next serves the file from a route it generates, writes the
 * og:image and twitter:image tags from it (size, type, and the alt text in
 * opengraph-image.alt.txt beside it), and puts a hash of THE FILE'S BYTES in
 * the image URL's query string. A new card therefore gets a new URL, which is
 * what makes the year-long immutable cache header on that URL safe.
 *
 * tests/og-card-static.test.ts renders the card again and fails when the
 * committed PNG differs, so editing the design without running this script
 * fails CI instead of shipping a stale card.
 *
 * Usage:
 *   node --import tsx scripts/gen-og-card.ts          write the PNG
 *   node --import tsx scripts/gen-og-card.ts --check  exit 1 if it is stale
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as React from "react";

export const OG_CARD_PNG = "app/(marketing)/opengraph-image.png";

const ROOT = path.join(__dirname, "..");

/** Render the card with next/og, outside Next. */
async function renderOgCardPngForFile(): Promise<Buffer> {
  // tsx compiles the card's JSX to React.createElement (tsconfig jsx: preserve).
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderOgCardPng } = await import("../lib/marketing/og-card");
  return renderOgCardPng();
}

async function main(): Promise<number> {
  const check = process.argv.includes("--check");
  const file = path.join(ROOT, OG_CARD_PNG);
  const want = await renderOgCardPngForFile();
  const have = existsSync(file) ? readFileSync(file) : null;
  const same = have !== null && have.equals(want);
  if (check) {
    if (same) return 0;
    console.error(`${OG_CARD_PNG} is stale: run node --import tsx scripts/gen-og-card.ts`);
    return 1;
  }
  if (!same) writeFileSync(file, want);
  console.log(`${OG_CARD_PNG}: ${same ? "unchanged" : "written"} (${want.length} bytes)`);
  return 0;
}

if (/gen-og-card\.ts$/.test(process.argv[1] || "")) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
