/**
 * tests/og-card-static.test.ts - the marketing share card is a static PNG that
 * Next serves and content-addresses, and it is exactly what its design renders.
 *
 * WHY (2026-10-02, Worker bundle diet)
 * ------------------------------------
 * app/(marketing)/opengraph-image.tsx used to return next/og's ImageResponse
 * on every request. That put @vercel/og into the Cloudflare Worker (OpenNext
 * includes it whenever a route's file trace reaches it): the Satori library,
 * resvg.wasm, yoga.wasm and a fallback font, about 2 MiB of the 64 MiB upload
 * limit, to draw one card with no inputs. The card is now the static file
 * app/(marketing)/opengraph-image.png, rendered from lib/marketing/og-card.tsx
 * by scripts/gen-og-card.ts.
 *
 * The first version of this change served the bytes from a route that kept the
 * old file name. Next hashes a metadata image's SOURCE FILE for the og:image
 * URL, so the URL would not have changed with the card while the response
 * said "immutable for a year" (Codex review of #531). With the static file,
 * the hashed file IS the PNG.
 *
 * WHAT THIS PINS
 *  1. The committed PNG is what the design renders now.
 *  2. It is a 1200x630 PNG with the alt text the route used to export, and no
 *     dynamic opengraph-image route competes with it.
 *  3. Next's own metadata-image loader, run on these files, writes the same
 *     og:image tags as before (type, width, height, alt) and a URL whose
 *     ?hash comes from the PNG's bytes: one changed byte, a new URL.
 *  4. The old card URL redirects to the new one.
 *  5. Nothing the Worker bundles imports next/og, @vercel/og or the design
 *     module, so the renderer cannot creep back into the upload.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import * as ReactNS from "react";

// tsx compiles the design's JSX to React.createElement (tsconfig jsx: preserve).
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

const root = path.resolve(__dirname, "..");
const requireHere = createRequire(__filename);
const ALT = "OASIS AI \u2014 Operational Agentic Systems Increasing Scalability";

type ImageMeta = { type?: string; width?: number; height?: number; alt?: string; hash: string };

/** Run Next's metadata-image loader on a static image the way the app build does. */
async function nextImageMeta(file: string): Promise<ImageMeta> {
  const loader = requireHere("next/dist/build/webpack/loaders/next-metadata-image-loader.js").default as (
    this: unknown,
    content: Buffer,
  ) => Promise<string>;
  const code = await loader.call(
    {
      resourcePath: file,
      resourceQuery: "",
      rootContext: root,
      getOptions: () => ({ type: "openGraph", segment: "(marketing)", basePath: "", pageExtensions: ["tsx", "ts", "jsx", "js"] }),
    },
    readFileSync(file),
  );
  const data = /const imageData = (\{.*\})\n/.exec(code);
  const hash = /url: imageUrl \+ "\?([0-9a-z]+)"/.exec(code);
  assert.ok(data && hash, `Next's metadata-image loader output changed shape:\n${code}`);
  return { ...(JSON.parse(data[1]) as Omit<ImageMeta, "hash">), hash: hash[1] };
}

async function main(): Promise<void> {
  const { OG_CARD_SIZE, renderOgCardPng } = await import("../lib/marketing/og-card");
  const { OG_CARD_PNG } = await import("../scripts/gen-og-card");
  const pngPath = path.join(root, OG_CARD_PNG);
  const shipped = readFileSync(pngPath);

  // 1. No drift between the design and the committed bytes.
  const fresh = await renderOgCardPng();
  assert.ok(
    fresh.equals(shipped),
    `the committed share card (${shipped.length} bytes) differs from what lib/marketing/og-card.tsx renders ` +
      `(${fresh.length} bytes). Run: node --import tsx scripts/gen-og-card.ts`,
  );

  // 2. A real 1200x630 PNG, the same alt text, and nothing competing for the slot.
  assert.equal(shipped.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG signature");
  assert.equal(shipped.subarray(12, 16).toString("latin1"), "IHDR");
  assert.equal(shipped.readUInt32BE(16), OG_CARD_SIZE.width, "PNG width");
  assert.equal(shipped.readUInt32BE(20), OG_CARD_SIZE.height, "PNG height");
  assert.deepEqual(OG_CARD_SIZE, { width: 1200, height: 630 });
  const altFile = path.join(root, "app/(marketing)/opengraph-image.alt.txt");
  assert.equal(readFileSync(altFile, "utf8"), ALT, "alt text, exactly: Next reads the file verbatim, newline included");
  const slot = readdirSync(path.join(root, "app/(marketing)")).filter((f) => /^opengraph-image/.test(f)).sort();
  assert.deepEqual(slot, ["opengraph-image.alt.txt", "opengraph-image.png"], "one share card, from the static file only");

  // 3. Next writes the same tags as before, and the URL follows the bytes.
  const meta = await nextImageMeta(pngPath);
  assert.equal(meta.type, "image/png");
  assert.equal(meta.width, 1200);
  assert.equal(meta.height, 630);
  assert.equal(meta.alt, ALT);
  assert.match(meta.hash, /^[0-9a-f]{16}$/, "the og:image URL carries a content hash");
  const scratch = mkdtempSync(path.join(tmpdir(), "og-card-"));
  try {
    const copy = path.join(scratch, "opengraph-image.png");
    writeFileSync(copy, shipped);
    writeFileSync(path.join(scratch, "opengraph-image.alt.txt"), ALT);
    assert.equal((await nextImageMeta(copy)).hash, meta.hash, "the hash depends on the bytes only, not where the file sits");
    const changed = Buffer.from(shipped);
    changed[changed.length - 20] ^= 0xff; // inside the image data, past the header Next reads the size from
    writeFileSync(copy, changed);
    const after = await nextImageMeta(copy);
    assert.notEqual(after.hash, meta.hash, "a changed card must get a new og:image URL, or caches keep the old one for a year");
    assert.equal(after.width, 1200, "the mutated copy is still read as the same-size image");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // 4. Anything still holding the old URL lands on the same card.
  const nextConfig = requireHere(path.join(root, "next.config.js")) as {
    redirects: () => Promise<Array<{ source: string; destination: string; permanent: boolean }>>;
  };
  const redirects = await nextConfig.redirects();
  assert.deepEqual(
    redirects.find((r) => r.source === "/opengraph-image-pwu6ef"),
    { source: "/opengraph-image-pwu6ef", destination: "/opengraph-image-pwu6ef.png", permanent: true },
    "the old dynamic card URL redirects to the static file",
  );

  // 5. The renderer stays out of everything the Worker bundles.
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
    `og-card-static: the committed ${shipped.length}-byte card matches a fresh render; Next's loader gives it ` +
      `?${meta.hash} and a new hash when one byte changes; ${scanned} Worker source files import no renderer`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
