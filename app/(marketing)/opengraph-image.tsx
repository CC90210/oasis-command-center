import { ImageResponse } from "next/og";

/**
 * Share card for every marketing page.
 *
 * Placed in the route group so all six pages inherit it without each
 * declaring one. Rendered by Satori, which supports a flexbox subset of
 * CSS only — no grid, no background-image shorthand tricks, and every
 * element with more than one child needs an explicit `display: flex`.
 *
 * No webfont is loaded: fetching one at image-generation time is a network
 * call in the render path that fails closed on a cold edge, and the card is
 * six words. The system fallback is the right trade here.
 */

export const runtime = "edge";
export const alt =
  "OASIS AI — Operational Agentic Systems Increasing Scalability";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const CYAN = "#00D4FF";
const VOID = "#050608";

export default function OpengraphImage() {
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
          // The hairline grid, as two repeating linear gradients — the same
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
    size,
  );
}
