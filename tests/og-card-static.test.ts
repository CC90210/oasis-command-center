/**
 * tests/og-card-static.test.ts - the marketing share card is served as
 * prebuilt PNG bytes, and those bytes are exactly what its design renders.
 *
 * WHY (2026-10-02, Worker bundle diet)
 * ------------------------------------
 * app/(marketing)/opengraph-image.tsx used to return next/og's ImageResponse
 * on every request. That put @vercel/og into the Cloudflare Worker (OpenNext
 * includes it whenever a route's file trace reaches it): the Satori library,
 * resvg.wasm, yoga.wasm and a fallback font, about 2 MiB of the 64 MiB upload
 * limit, to draw one card with no inputs. The route now serves the PNG that
 * lib/marketing/og-card.tsx renders, committed by scripts/gen-og-card.ts.
 *
 * WHAT THIS PINS
 *  1. The committed PNG is what the design renders now, and the committed
 *     module is exactly what the generator writes: editing the design without
 *     regenerating fails here instead of shipping a stale card.
 *  2. The route still exports the same alt, size and content type (they become
 *     the og:image and twitter:image meta tags), and the PNG really is 1200x630.
 *  3. The route answers with the same status, body and headers that
 *     next/og's ImageResponse gave.
 *  4. Nothing the Worker bundles imports next/og, @vercel/og or the design
 *     module, so the renderer cannot creep back into the upload. (The size
 *     itself is checked by CI's wrangler dry run, scripts/check-worker-bundle.ts.)
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import * as ReactNS from "react";

// tsx compiles the design's JSX to React.createElement (tsconfig jsx: preserve).
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

const root = path.resolve(__dirname, "..");

async function main(): Promise<void> {
  const route = await import("../app/(marketing)/opengraph-image");
  const { OG_CARD_PNG_BASE64 } = await import("../lib/marketing/og-card.generated");
  const { OG_CARD_SIZE, renderOgCard, renderOgCardPng } = await import("../lib/marketing/og-card");
  const { OG_CARD_MODULE, renderOgCardModule } = await import("../scripts/gen-og-card");

  const shipped = Buffer.from(OG_CARD_PNG_BASE64, "base64");

  // 1. No drift between the design and the committed bytes.
  const fresh = await renderOgCardPng();
  assert.ok(
    fresh.equals(shipped),
    `the committed share card (${shipped.length} bytes) differs from what lib/marketing/og-card.tsx renders ` +
      `(${fresh.length} bytes). Run: node --import tsx scripts/gen-og-card.ts`,
  );
  const committed = readFileSync(path.join(root, OG_CARD_MODULE), "utf8").replace(/\r\n?/g, "\n");
  assert.equal(committed, renderOgCardModule(fresh), `${OG_CARD_MODULE} is not what scripts/gen-og-card.ts writes`);
  assert.ok(/^[\x00-\x7f]*$/.test(committed), `${OG_CARD_MODULE} must stay ASCII (one-byte Worker source)`);

  // 2. Same metadata exports as before, and a real 1200x630 PNG.
  assert.equal(route.alt, "OASIS AI — Operational Agentic Systems Increasing Scalability");
  assert.deepEqual(route.size, { width: 1200, height: 630 });
  assert.deepEqual(OG_CARD_SIZE, route.size, "the design renders at the size the route declares");
  assert.equal(route.contentType, "image/png");
  assert.equal(shipped.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG signature");
  assert.equal(shipped.subarray(12, 16).toString("latin1"), "IHDR");
  assert.equal(shipped.readUInt32BE(16), route.size.width, "PNG width");
  assert.equal(shipped.readUInt32BE(20), route.size.height, "PNG height");

  // 3. The same response ImageResponse gave: status, headers, body.
  const res = route.default();
  const before = renderOgCard();
  assert.equal(res.status, before.status);
  assert.equal(res.status, 200);
  for (const name of ["content-type", "cache-control"]) {
    assert.equal(res.headers.get(name), before.headers.get(name), `${name} header matches next/og's ImageResponse`);
  }
  assert.equal(res.headers.get("content-type"), "image/png");
  if (process.env.NODE_ENV !== "development") {
    assert.equal(res.headers.get("cache-control"), "public, immutable, no-transform, max-age=31536000");
  }
  const body = Buffer.from(await res.arrayBuffer());
  const beforeBody = Buffer.from(await before.arrayBuffer());
  assert.ok(body.equals(shipped), "the route serves the committed bytes");
  assert.ok(body.equals(beforeBody), "the route serves exactly what ImageResponse rendered");

  // 4. The renderer stays out of everything the Worker bundles.
  const IMPORT = String.raw`(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']`;
  const RENDERER = new RegExp(`${IMPORT}(?:next/og|@vercel/og|next/dist/compiled/@vercel/og[^"']*)["']`);
  const DESIGN = new RegExp(`${IMPORT}[^"']*/og-card(?:\\.tsx?)?["']`);
  const offenders: string[] = [];
  let scanned = 0;
  const walk = (rel: string) => {
    const abs = path.join(root, rel);
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        walk(`${rel}/${name}`);
      }
      return;
    }
    if (!/\.(?:[cm]?[jt]sx?)$/.test(rel)) return;
    scanned++;
    const text = readFileSync(abs, "utf8");
    if (rel === "lib/marketing/og-card.tsx") return; // the design source itself
    if (RENDERER.test(text)) offenders.push(`${rel} imports the image renderer`);
    if (DESIGN.test(text)) offenders.push(`${rel} imports lib/marketing/og-card (which imports next/og)`);
  };
  // The same set tests/worker-source-one-byte.test.ts scans: everything
  // OpenNext bundles into the server Worker.
  for (const entry of ["app", "components", "hooks", "lib", "config", "content", "middleware.ts", "instrumentation.ts"]) {
    if (existsSync(path.join(root, entry))) walk(entry);
  }
  assert.ok(scanned > 500, `scanned only ${scanned} source files; the walk has lost a directory`);
  assert.deepEqual(offenders, [], `the Worker would bundle @vercel/og again:\n  ${offenders.join("\n  ")}`);

  console.log(
    `og-card-static: route serves the committed ${shipped.length}-byte card, identical to a fresh render and to ` +
      `ImageResponse's response; ${scanned} Worker source files import no renderer`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
