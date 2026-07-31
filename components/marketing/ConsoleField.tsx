/**
 * Ambient backdrop for the marketing hero.
 *
 * A Server Component with no JavaScript at all: a masked hairline grid, a
 * few cells that flare on long offset cycles, and one slow sweep. It reads
 * as an instrument panel with activity on it rather than as decoration,
 * which is the point — the motion means "something is running".
 *
 * Deliberately NOT the canvas particle field used on /start
 * (components/landing/HeroBackdrop.tsx). That component stays exactly as
 * it is for that page; reusing it here would put a requestAnimationFrame
 * loop and ~300 particle updates per frame behind every marketing page for
 * an effect that competes with the fleet roster. The roster is where this
 * design spends its motion budget. Everything around it stays quiet.
 *
 * Reduced motion is handled globally by marketing.css, which flattens
 * every animation inside `.marketing`.
 */

/** Flare positions, hand-placed so they read as scattered rather than
 *  patterned, and kept off the centre where the headline sits. */
const FLARES = [
  { left: "8%", top: "22%", delay: "0s" },
  { left: "17%", top: "64%", delay: "5.5s" },
  { left: "29%", top: "38%", delay: "11s" },
  { left: "38%", top: "78%", delay: "3s" },
  { left: "62%", top: "18%", delay: "8s" },
  { left: "71%", top: "56%", delay: "14s" },
  { left: "83%", top: "31%", delay: "1.5s" },
  { left: "91%", top: "70%", delay: "9.5s" },
];

export function ConsoleField({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}
    >
      <div className="m-grid absolute inset-0 opacity-[0.55]" />

      {FLARES.map((f, i) => (
        <span
          key={i}
          className="m-flare"
          style={{ left: f.left, top: f.top, animationDelay: f.delay }}
        />
      ))}

      <div className="m-sweep" />

      {/* Bottom fade so the hero dissolves into the page rather than
          ending on a hard edge against the next section. */}
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-ops-void" />
    </div>
  );
}
