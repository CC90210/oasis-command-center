/**
 * HeroBackdrop — the quiet ground behind the /welcome hero.
 *
 * WHAT THIS REPLACED, AND WHY
 *
 * The previous version layered seven effects: drifting blurred nebula orbs, a
 * rotating spiral galaxy, 38 twinkling stars, a 260-particle Perlin flow field
 * on a permanent requestAnimationFrame loop, a holographic grid, radial washes
 * and a vignette. Every one of those is on the Oasis banned list, and together
 * they are the single most recognisable signature of generated software. This
 * is the onboarding page: the first screen a business owner ever sees.
 *
 * It also cost real money in performance. The flow field ran a canvas RAF for
 * the entire time the page was open, and the blurred orbs each held their own
 * compositor layer.
 *
 * The replacement follows the design constitution: the background has a job,
 * which is to sit still and let the words be read. A single soft vertical
 * gradient gives the page depth without performing, and one hairline marks the
 * top edge. No animation, so nothing to reduce for `prefers-reduced-motion`.
 *
 * If this page ever needs more presence, the answer is better typography and a
 * real product screenshot, not more atmosphere.
 */
export function HeroBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
    >
      {/* A single ground tone, lighter at the top where the content sits. */}
      <div className="absolute inset-0 bg-[linear-gradient(180deg,#0b1016_0%,#06090e_58%,#04070b_100%)]" />

      {/* One hairline at the top edge, the same separation idiom the product
          uses everywhere else: a border separates, a glow does not. */}
      <div className="absolute inset-x-0 top-0 h-px bg-white/[0.06]" />
    </div>
  );
}
