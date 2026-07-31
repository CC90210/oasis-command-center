/**
 * Hero atmosphere.
 *
 * A Server Component with no JavaScript: three very large blurred blooms
 * drifting on long, mutually prime cycles (41s / 53s / 67s, so the
 * composition takes ~40 minutes to repeat), film grain, and a vignette.
 * All of it is CSS — see the "Atmosphere" block in marketing.css.
 *
 * WHY NOT THE PREVIOUS GRID: it was a repeating hairline checkerboard.
 * It read as graph paper, it was the same device a thousand other
 * developer-tool sites use, and it said nothing about this company. The
 * palette here is built from the name — light through water — using the
 * brand cyan for the surface and a cold indigo underneath so it never
 * flattens into a single-hue gradient.
 *
 * WHY NOT THE CANVAS FIELD on /start: that component runs a
 * requestAnimationFrame loop over ~260 particles. Behind every page of a
 * marketing site it would burn battery for an effect that competes with
 * the fleet roster, which is where this design spends its motion budget.
 * /start keeps it; nothing here touches that file.
 *
 * Reduced motion is handled globally in marketing.css, which flattens
 * every animation inside `.marketing` — the blooms simply hold position.
 */

export function ConsoleField({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}
    >
      <div className="m-aurora">
        <span />
        <span />
        <span />
      </div>
      <div className="m-grain" />
      <div className="m-vignette" />
    </div>
  );
}
