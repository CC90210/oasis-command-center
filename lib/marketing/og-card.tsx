import { ImageResponse } from "next/og";

/**
 * Share card for every marketing page: the DESIGN SOURCE.
 *
 * The page serves app/(marketing)/opengraph-image.png, the PNG this renders,
 * through Next's static metadata-image convention (alt text in
 * opengraph-image.alt.txt beside it). Next puts a hash of the PNG's bytes in
 * the og:image URL, so a new card gets a new URL. The card used to be rendered
 * per request by an opengraph-image.tsx route, which put @vercel/og into the
 * Cloudflare Worker: about 2 MiB of the 64 MiB upload limit (the Satori
 * library, resvg.wasm, yoga.wasm and a fallback font) to draw one fixed card
 * that has no inputs.
 *
 * NOTHING THE WORKER BUNDLES MAY IMPORT THIS FILE. OpenNext adds @vercel/og to
 * the Worker as soon as any route's file trace reaches it. Only
 * scripts/gen-og-card.ts and tests/og-card-static.test.ts import it, and the
 * test fails if anything under app/, components/ or lib/ imports next/og.
 *
 * To change the card: edit the JSX below, run
 *   node --import tsx scripts/gen-og-card.ts
 * and commit the regenerated PNG. tests/og-card-static.test.ts fails while
 * the committed PNG differs from what this file renders.
 *
 * Callers outside Next (the script, the test) set globalThis.React first:
 * tsx compiles this JSX to React.createElement.
 *
 * Rendered by Satori, which supports a flexbox subset of CSS only - no grid,
 * no background-image shorthand tricks, and every element with more than one
 * child needs an explicit `display: flex`.
 *
 * No webfont is loaded: fetching one at image-generation time is a network
 * call in the render path that fails closed on a cold runtime, and the card is
 * six words. The system fallback is the right trade here.
 */

/** Next reads the og:image width and height from the PNG; the test checks its header. */
export const OG_CARD_SIZE = { width: 1200, height: 630 };

const CYAN = "#00D4FF";
const VOID = "#050608";

export function renderOgCard(): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: VOID,
          padding: 72,
          // The hairline grid, as two repeating linear gradients - the same
          // device the site uses, and the only part of this card that has
          // to survive being seen at thumbnail size.
          backgroundImage: `linear-gradient(#1a1e26 1px, transparent 1px), linear-gradient(90deg, #1a1e26 1px, transparent 1px)`,
          backgroundSize: "64px 64px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: 12,
              background: "#10b981",
            }}
          />
          {/* The acronym in full, matching the hero. The card used to say
              "Operational agentic systems", which is three of the five
              words and reads as a tagline rather than as what OASIS
              stands for. */}
          <div
            style={{
              fontSize: 19,
              letterSpacing: 4,
              color: "#9ca0a8",
              textTransform: "uppercase",
            }}
          >
            Operational Agentic Systems Increasing Scalability
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: 84,
              lineHeight: 1.02,
              fontWeight: 700,
              color: "#faf9f5",
              letterSpacing: -2,
            }}
          >
            You don&rsquo;t hire a tool.
          </div>
          <div
            style={{
              fontSize: 84,
              lineHeight: 1.02,
              fontWeight: 700,
              color: CYAN,
              letterSpacing: -2,
            }}
          >
            You staff a company.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            borderTop: "1px solid #1a1e26",
            paddingTop: 28,
          }}
        >
          <div style={{ fontSize: 26, fontWeight: 700, color: "#faf9f5", letterSpacing: 4 }}>
            OASIS AI
          </div>
          <div style={{ fontSize: 20, color: "#5b6068", letterSpacing: 2 }}>
            oasisai.work
          </div>
        </div>
      </div>
    ),
    OG_CARD_SIZE,
  );
}

/** The card as PNG bytes. */
export async function renderOgCardPng(): Promise<Buffer> {
  return Buffer.from(await renderOgCard().arrayBuffer());
}
