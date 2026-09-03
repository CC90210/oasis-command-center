/**
 * battle-hud.ts — the battle card's HUD palette, shared by the 2D SVG
 * hologram (BattleCard.tsx) and the WebGL radar (Radar3D.tsx).
 *
 * ═══ COLOUR IS IDENTITY, NEVER VERDICT ══════════════════════════════════════
 *
 * A colour from this module answers exactly two questions, and neither is
 * "how good is it":
 *
 *   WHICH area is this — each dimension wears ONE fixed hue, on its radar
 *   vertex / light pillar, its axis label, its list dot, its meter and its
 *   fix-first row. Trust is that blue at a score of 4 and at a score of 94.
 *
 *   WHOSE mark is this — the prospect is always cyan, the benchmark
 *   competitor is always GOLD, in every chart and every track.
 *
 * The palette is deliberately cool-spectrum with no traffic-light red or
 * green: a red 22 renders a judgement the measurement does not support, and a
 * rep who sees red says something aloud they cannot back up.
 * tests/web-leads-guards.test.ts bans the verdict colour classes in every
 * file of this feature, and tests/web-leads-battlecard.test.ts pins that all
 * seven dimensions have hues here (one falling through to the grey fallback
 * breaks the "this colour IS trust" coding on three surfaces at once).
 */

export const DIM_HUES: Record<string, { from: string; to: string }> = {
  conversion: { from: "#22d3ee", to: "#67e8f9" },
  trust: { from: "#3b82f6", to: "#93c5fd" },
  design: { from: "#8b5cf6", to: "#c4b5fd" },
  mobile: { from: "#d946ef", to: "#f0abfc" },
  content: { from: "#0ea5e9", to: "#7dd3fc" },
  performance: { from: "#6366f1", to: "#a5b4fc" },
  discoverability: { from: "#14b8a6", to: "#5eead4" },
};

export const FALLBACK_HUE = { from: "#38bdf8", to: "#7dd3fc" };

export const hueFor = (key: string) => DIM_HUES[key] || FALLBACK_HUE;

/**
 * The presence layer's pillar hues (phase 2) — same doctrine, same cool
 * spectrum, deliberately DISTINCT from every DIM_HUES value so a presence
 * pillar can never be mistaken for a website dimension on a card that shows
 * both. Identity, never verdict: "Google Business Profile" wears its teal at
 * a 5 and at a 95. Completeness pinned in web-leads-battlecard.test.ts §8k.
 */
export const PILLAR_HUES: Record<string, { from: string; to: string }> = {
  gbp: { from: "#2dd4bf", to: "#99f6e4" },
  consistency: { from: "#60a5fa", to: "#bfdbfe" },
  email: { from: "#a78bfa", to: "#ddd6fe" },
  social: { from: "#22ccee", to: "#a5f3fc" },
};

export const pillarHueFor = (key: string) => PILLAR_HUES[key] || FALLBACK_HUE;

/** The benchmark competitor's mark, everywhere it appears: radar overlay,
 *  head-to-head ticks, the 3D wireframe. A fixed identity, worn at every
 *  score. */
export const GOLD = "#fbbf24";

/** The prospect's own mark: the cyan every "theirs" line, fill and track
 *  wears. */
export const CYAN = "#22d3ee";
