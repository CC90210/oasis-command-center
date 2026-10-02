import { OG_CARD_PNG_BASE64 } from "@/lib/marketing/og-card.generated";

/**
 * Share card for every marketing page.
 *
 * Placed in the route group so all six pages inherit it without each
 * declaring one.
 *
 * The card is one fixed design with no inputs, so this serves it as prebuilt
 * PNG bytes. lib/marketing/og-card.tsx is the design (JSX that next/og
 * renders), and scripts/gen-og-card.ts writes its PNG into
 * lib/marketing/og-card.generated.ts. Rendering it here on each request, as
 * this file used to, put @vercel/og into the Cloudflare Worker: about 2 MiB of
 * the 64 MiB upload limit (Satori, resvg.wasm, yoga.wasm and a font).
 *
 * Do not import next/og or lib/marketing/og-card here, or from anything the
 * Worker bundles. tests/og-card-static.test.ts fails if anything does, and
 * when the committed PNG differs from what the design renders.
 *
 * The headers are the ones next/og's ImageResponse set, so the response is
 * the same as before, byte for byte.
 */

export const alt = "OASIS AI — Operational Agentic Systems Increasing Scalability";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage(): Response {
  return new Response(Buffer.from(OG_CARD_PNG_BASE64, "base64"), {
    headers: {
      "content-type": contentType,
      "cache-control":
        process.env.NODE_ENV === "development" ? "no-cache, no-store" : "public, immutable, no-transform, max-age=31536000",
    },
  });
}
