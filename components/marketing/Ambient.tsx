/**
 * Site-wide atmosphere.
 *
 * Mounted once in the marketing layout and `position: fixed`, so it sits
 * behind every page and every scroll position rather than being bolted to
 * the top of each hero. Previously each page mounted its own hero-height
 * backdrop and everything below the fold was flat black.
 *
 * Three layers, all CSS, no canvas and no requestAnimationFrame:
 *
 *   1. Aurora — three very large blurred blooms on mutually prime cycles
 *      (41s / 53s / 67s, so the composition takes ~40 minutes to repeat).
 *      Light through water, which is where the name comes from.
 *   2. Helix — a double strand of nodes turning slowly, off to one side.
 *      The visual OASIS has always reached for, and it reads as structure
 *      rather than as decoration.
 *   3. Drift — a handful of small technical glyphs travelling upward on
 *      long offset cycles.
 *
 * Deliberately NOT a connected-dot "neural network" mesh. That is the
 * single most recognisable AI-slop background on the internet and it says
 * nothing about this company.
 *
 * Everything here is inert to input (`pointer-events: none`) and flattened
 * by the reduced-motion block in marketing.css.
 */

/**
 * Helix nodes, positioned here rather than in CSS.
 *
 * The obvious version uses CSS `sin()` and `abs()` in a calc, but those are
 * recent additions and a browser that lacks them drops the whole transform,
 * collapsing both strands into one straight vertical line. These offsets
 * never change, so there is no reason to make the browser derive them —
 * computing once at module load is both safer and cheaper.
 *
 * `depth` fakes the near/far side of the turn: nodes at the edges of the
 * swing are closest to the viewer and brightest, nodes crossing the centre
 * are rounding the back and dim out.
 */
const AMPLITUDE = 70; // px of horizontal swing
const RADIANS_PER_NODE = 0.68;

function strand(phase: number) {
  return Array.from({ length: 14 }, (_, i) => {
    const angle = i * RADIANS_PER_NODE + phase;
    return {
      top: `${i * 7.4}%`,
      x: `${(Math.sin(angle) * AMPLITUDE).toFixed(1)}px`,
      depth: (1 - Math.abs(Math.sin(angle))).toFixed(3),
    };
  });
}

const STRAND_A = strand(0);
const STRAND_B = strand(Math.PI);

const DRIFT = [
  { left: "12%", delay: "0s", dur: "34s", size: 5 },
  { left: "27%", delay: "9s", dur: "44s", size: 3 },
  { left: "48%", delay: "17s", dur: "38s", size: 4 },
  { left: "63%", delay: "4s", dur: "50s", size: 3 },
  { left: "81%", delay: "23s", dur: "41s", size: 5 },
  { left: "91%", delay: "13s", dur: "47s", size: 3 },
];

export function Ambient() {
  return (
    <div aria-hidden="true" className="m-ambient">
      <div className="m-aurora">
        <span />
        <span />
        <span />
      </div>

      <div className="m-helix">
        {STRAND_A.map((n, i) => (
          <span
            key={`a${i}`}
            style={
              { top: n.top, "--x": n.x, "--depth": n.depth } as React.CSSProperties
            }
          />
        ))}
        {STRAND_B.map((n, i) => (
          <span
            key={`b${i}`}
            data-strand="b"
            style={
              { top: n.top, "--x": n.x, "--depth": n.depth } as React.CSSProperties
            }
          />
        ))}
      </div>

      {DRIFT.map((d, i) => (
        <span
          key={i}
          className="m-drift"
          style={
            {
              left: d.left,
              width: d.size,
              height: d.size,
              animationDelay: d.delay,
              animationDuration: d.dur,
            } as React.CSSProperties
          }
        />
      ))}

      <div className="m-grain" />
      <div className="m-vignette" />
    </div>
  );
}
