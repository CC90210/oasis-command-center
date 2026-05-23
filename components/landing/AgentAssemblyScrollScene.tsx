"use client";

import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

/**
 * AgentAssemblyScrollScene — manufacturing-line build for /welcome.
 *
 * One static photoreal backdrop (phase-01-initial-seed.jpg) acts as the
 * persistent figure. Eight code-driven SVG modules (spine, optics, limbs,
 * shield, halo, mesh, bravo-online) progressively bolt onto the figure as
 * the operator scrolls. Two robotic arm SVGs fly to each module's install
 * point during the install window, fire an energy beam, then retract.
 *
 * Each module's draw animation, the arm trajectories, the beam tracers,
 * the spark bursts, and the final "Bravo online" ignition are all driven
 * by scroll-progress math — no opacity crossfades between still photos.
 */

const BACKDROP = "/images/agent-assembly/phase-01-initial-seed.jpg";

// Eight ordered phases. Each phase owns:
//   - title  : displayed in the bottom HUD strip
//   - target : { x%, y% } on the figure where the module installs (drives arm + beam endpoints)
//   - accent : color for the module's primary draw + spark
//   - module : kind of SVG geometry to draw (interpreted in <ModuleLayer/>)
const PHASES = [
  { id: 1, title: "Initial seed",       target: { x: 50, y: 52 }, accent: "rgba(252,211,77,0.95)",  module: "core"    as const },
  { id: 2, title: "Neural backbone",    target: { x: 50, y: 36 }, accent: "rgba(52,211,153,0.95)",  module: "spine"   as const },
  { id: 3, title: "Optic calibration",  target: { x: 50, y: 27 }, accent: "rgba(134,239,172,0.95)", module: "optics"  as const },
  { id: 4, title: "Tool limb docking",  target: { x: 50, y: 50 }, accent: "rgba(167,243,208,0.95)", module: "limbs"   as const },
  { id: 5, title: "Guard shield",       target: { x: 50, y: 50 }, accent: "rgba(187,247,208,0.95)", module: "shield"  as const },
  { id: 6, title: "Output halo",        target: { x: 50, y: 16 }, accent: "rgba(252,211,77,0.95)",  module: "halo"    as const },
  { id: 7, title: "Security mesh",      target: { x: 50, y: 50 }, accent: "rgba(110,231,183,0.95)", module: "mesh"    as const },
  { id: 8, title: "Bravo online",       target: { x: 50, y: 52 }, accent: "rgba(252,211,77,0.95)",  module: "online"  as const },
] as const;

type ModuleKind = (typeof PHASES)[number]["module"];

const INSTALL_PORTION = 0.55; // first 55% of each phase segment is the install window

function clamp(v: number) { return Math.max(0, Math.min(1, v)); }
function smoothstep(v: number) { const t = clamp(v); return t * t * (3 - 2 * t); }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

/** 0 (not yet) → 1 (fully installed) for phase i at the given scroll position. */
function installProgress(i: number, progress: number): number {
  const segmentSize = 1 / PHASES.length;
  const segmentStart = i * segmentSize;
  const installWindow = segmentSize * INSTALL_PORTION;
  return clamp((progress - segmentStart) / installWindow);
}

/** Tent function: 0 outside install window, peaks at 1 mid-install. Drives arm + beam visibility. */
function installActivity(i: number, progress: number): number {
  const segmentSize = 1 / PHASES.length;
  const segmentStart = i * segmentSize;
  const installWindow = segmentSize * INSTALL_PORTION;
  const t = (progress - segmentStart) / installWindow;
  if (t < 0 || t > 1) return 0;
  return 1 - Math.abs(t - 0.5) * 2;
}

/** Which arm side handles each phase's install (alternating for visual rhythm). */
function armSideFor(phaseIdx: number): "left" | "right" | "both" {
  // optics, limbs, shield, mesh use BOTH arms (symmetric install).
  // spine + halo + online come from above; map to "both" too.
  // remaining (just initial seed which is base) -> both.
  if (phaseIdx === 0) return "both";
  const m = PHASES[phaseIdx].module;
  if (m === "optics" || m === "limbs" || m === "shield" || m === "mesh") return "both";
  return "both";
}

function ModuleLayer({
  kind,
  progress,
  accent,
}: {
  kind: ModuleKind;
  progress: number; // 0..1, install progress for this module
  accent: string;
}) {
  // `eased` for opacity (smooth in), `progress` for stroke draw.
  const eased = smoothstep(progress);
  const dashOffset = 1 - progress;

  // viewBox is 0..100 in both axes so numeric coords ARE percentages.
  // Stroke widths, radii, drop-shadow blur values all live in the same
  // 0..100 unit space, so use small fractional sizes (0.3, 0.6, 1.5 etc).
  switch (kind) {
    case "core":
      return (
        <g opacity={eased * 0.75}>
          <circle cx={50} cy={52} r={6} fill="none" stroke={accent} strokeWidth={0.3} />
          <circle cx={50} cy={52} r={10} fill="none" stroke={accent} strokeWidth={0.18} opacity={0.5} />
        </g>
      );

    case "spine": {
      const len = 32; // 54 - 22
      return (
        <g opacity={eased}>
          <line
            x1={50} y1={54} x2={50} y2={22}
            stroke={accent} strokeWidth={0.5} strokeLinecap="round"
            strokeDasharray={len}
            strokeDashoffset={len * dashOffset}
            filter="drop-shadow(0 0 0.8px rgba(52,211,153,0.7))"
          />
          {[22, 30, 38, 46, 54].map((y, i) => {
            const nodeT = clamp((progress - i * 0.15) * 4);
            return (
              <circle
                key={y}
                cx={50}
                cy={y}
                r={nodeT * 0.7}
                fill={accent}
                opacity={nodeT}
              />
            );
          })}
        </g>
      );
    }

    case "optics":
      return (
        <g opacity={eased}>
          {[46, 54].map((x) => (
            <g key={x}>
              <circle
                cx={x} cy={27}
                r={0.6 + progress * 1.2}
                fill="none" stroke={accent} strokeWidth={0.3}
                opacity={1 - progress * 0.4}
              />
              <circle cx={x} cy={27} r={0.4 * eased} fill={accent} />
            </g>
          ))}
          <line
            x1={30} y1={27} x2={70} y2={27}
            stroke={accent} strokeWidth={0.18} opacity={progress * 0.7}
            strokeDasharray={40}
            strokeDashoffset={40 * dashOffset}
          />
        </g>
      );

    case "limbs":
      return (
        <g opacity={eased}>
          {[
            { x: 38, y: 42 }, { x: 32, y: 56 }, { x: 28, y: 68 },
            { x: 62, y: 42 }, { x: 68, y: 56 }, { x: 72, y: 68 },
          ].map(({ x, y }, i) => {
            const nodeT = clamp((progress - i * 0.10) * 4);
            return (
              <g key={`${x}-${y}`}>
                <circle cx={x} cy={y} r={0.4 + nodeT * 0.5} fill={accent} opacity={nodeT * 0.85} />
                <circle cx={x} cy={y} r={1.2 * nodeT} fill="none" stroke={accent} strokeWidth={0.18} opacity={nodeT * 0.4} />
              </g>
            );
          })}
        </g>
      );

    case "shield": {
      const cx = 50; const cy = 52; const rx = 18; const ry = 26;
      const sides = 6;
      const points = Array.from({ length: sides }, (_, i) => {
        const a = (i / sides) * Math.PI * 2 - Math.PI / 2;
        return `${(cx + Math.cos(a) * rx).toFixed(2)},${(cy + Math.sin(a) * ry).toFixed(2)}`;
      }).join(" ");
      // Approx perimeter for dash-array (rough sum of side lengths).
      const perimeter = 6 * Math.sqrt(rx * rx + ry * ry) * 0.9;
      return (
        <g opacity={eased}>
          <polygon
            points={points}
            fill={accent}
            fillOpacity={progress * 0.10}
            stroke={accent}
            strokeWidth={0.3}
            strokeDasharray={perimeter}
            strokeDashoffset={perimeter * dashOffset}
          />
        </g>
      );
    }

    case "halo":
      return (
        <g opacity={eased}>
          <ellipse
            cx={50} cy={14} rx={14} ry={2.8}
            fill="none" stroke={accent} strokeWidth={0.4}
            strokeDasharray={90}
            strokeDashoffset={90 * dashOffset}
            filter="drop-shadow(0 0 1.2px rgba(252,211,77,0.7))"
          />
          <ellipse
            cx={50} cy={14} rx={9} ry={1.8}
            fill="none" stroke={accent} strokeWidth={0.25} opacity={progress * 0.6}
            strokeDasharray={60}
            strokeDashoffset={60 * dashOffset}
          />
          <line
            x1={50} y1={52} x2={50} y2={14}
            stroke={accent} strokeWidth={0.2} opacity={progress * 0.35}
            strokeDasharray="0.6 0.8"
          />
        </g>
      );

    case "mesh": {
      const tiles: Array<{ x: number; y: number; delay: number }> = [];
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          tiles.push({
            x: 38 + col * 6 + (row % 2 === 0 ? 0 : 3),
            y: 28 + row * 7,
            delay: (row * 5 + col) * 0.025,
          });
        }
      }
      return (
        <g opacity={eased * 0.85}>
          {tiles.map(({ x, y, delay }, i) => {
            const tileT = clamp((progress - delay) * 4);
            return (
              <polygon
                key={i}
                points={`${x - 2},${y} ${x},${y - 2} ${x + 2},${y} ${x},${y + 2}`}
                fill="none" stroke={accent} strokeWidth={0.1}
                opacity={tileT * 0.7}
              />
            );
          })}
        </g>
      );
    }

    case "online":
      return (
        <g opacity={eased}>
          <circle cx={50} cy={52} r={16 + progress * 8} fill="none" stroke={accent} strokeWidth={0.5} opacity={1 - progress * 0.5} />
          <circle cx={50} cy={52} r={10 + progress * 5} fill={accent} fillOpacity={0.12} />
          <circle cx={50} cy={52} r={3.5} fill={accent} fillOpacity={0.65} />
        </g>
      );

    default:
      return null;
  }
}

function RoboticArm({
  side,
  targetX,
  targetY,
  activity,
}: {
  side: "left" | "right";
  targetX: number; // 0..100 viewBox X
  targetY: number; // 0..100 viewBox Y
  activity: number; // 0 idle (off-screen) → 1 fully deployed at target
}) {
  const idleX = side === "left" ? -8 : 108;
  const idleY = 50;
  const x = lerp(idleX, targetX, activity);
  const y = lerp(idleY, targetY, activity);
  const armReach = activity * 30;
  const fromX = side === "left" ? x - armReach : x + armReach;
  const fromY = y;
  const midX = (fromX + x) / 2;
  const midY = (fromY + y) / 2;
  return (
    <g opacity={activity * 0.95}>
      {/* Arm shaft */}
      <line
        x1={fromX} y1={fromY}
        x2={x} y2={y}
        stroke="rgba(236,253,245,0.88)" strokeWidth={0.55}
        filter="drop-shadow(0 0 0.6px rgba(0,0,0,0.6))"
      />
      {/* Mid-segment joint */}
      <circle cx={midX} cy={midY} r={0.7} fill="rgba(20,40,30,0.95)" stroke="rgba(167,243,208,0.85)" strokeWidth={0.18} />
      {/* Claw / needle tip */}
      <circle
        cx={x} cy={y} r={0.85}
        fill="rgba(252,211,77,0.88)"
        stroke="rgba(252,211,77,1)" strokeWidth={0.2}
        filter="drop-shadow(0 0 1.2px rgba(252,211,77,0.9))"
      />
      {/* Beam from tip toward the figure centre */}
      <line
        x1={x} y1={y}
        x2={50} y2={y}
        stroke="rgba(252,211,77,0.78)" strokeWidth={0.22}
        strokeDasharray="0.8 0.6"
        opacity={activity * 0.85}
      />
    </g>
  );
}

export function AgentAssemblyScrollScene() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      if (!sectionRef.current) return;
      const rect = sectionRef.current.getBoundingClientRect();
      const travel = Math.max(1, rect.height - window.innerHeight);
      setProgress(clamp(-rect.top / travel));
    };
    const requestUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
    };
  }, []);

  const phaseIdx = useMemo(() => {
    const raw = Math.floor(progress * PHASES.length);
    return Math.min(PHASES.length - 1, Math.max(0, raw));
  }, [progress]);

  const activePhase = PHASES[phaseIdx];
  const activeInstall = installProgress(phaseIdx, progress);
  const activeActivity = installActivity(phaseIdx, progress);

  return (
    <section
      ref={sectionRef}
      id="agent-build"
      className="agent-assembly relative z-10"
      style={{ minHeight: "800vh" } as CSSProperties}
    >
      <div className="sticky top-0 h-screen w-full overflow-hidden bg-[#03070a]">
        {/* Persistent photoreal backdrop — the figure that all modules attach to. */}
        <div className="absolute inset-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={BACKDROP}
            alt="OASIS executive agent — assembly base"
            loading="eager"
            decoding="async"
            className="h-full w-full object-cover object-center"
            style={{ filter: "saturate(1.06) contrast(1.06)" }}
          />
        </div>

        {/* Code-driven assembly layer — modules + arms + beams + sparks
            ride on top of the backdrop. This is the scroll-dynamic part. */}
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="xMidYMid slice"
        >
          {/* Cumulative module stack — all phases up to and including the
              current one render at their fully-installed state. The active
              phase renders with `activeInstall` controlling the draw. */}
          {PHASES.map((p, i) => {
            if (i > phaseIdx) return null;
            const isActive = i === phaseIdx;
            const moduleProgress = isActive ? activeInstall : 1;
            return (
              <ModuleLayer
                key={p.id}
                kind={p.module}
                progress={moduleProgress}
                accent={p.accent}
              />
            );
          })}

          {/* Active install: robotic arms fly to the target during the
              install window, fire the beam, then retract. Both arms always
              active for symmetric assembly. */}
          {activeActivity > 0.01 && (
            <>
              <RoboticArm
                side="left"
                targetX={activePhase.target.x - 12}
                targetY={activePhase.target.y}
                activity={activeActivity}
              />
              <RoboticArm
                side="right"
                targetX={activePhase.target.x + 12}
                targetY={activePhase.target.y}
                activity={activeActivity}
              />
              {/* Spark burst at install point — radiates 8 lines + a fill disc. */}
              <g
                transform={`translate(${activePhase.target.x} ${activePhase.target.y})`}
                opacity={activeActivity}
              >
                {Array.from({ length: 10 }, (_, i) => {
                  const angle = (i * Math.PI * 2) / 10;
                  const len = 4 + activeActivity * 5;
                  return (
                    <line
                      key={i}
                      x1="0" y1="0"
                      x2={(Math.cos(angle) * len).toFixed(2)}
                      y2={(Math.sin(angle) * len).toFixed(2)}
                      stroke={activePhase.accent}
                      strokeWidth="0.4"
                      opacity={0.85}
                    />
                  );
                })}
                <circle cx="0" cy="0" r={2 + activeActivity * 2.5} fill={activePhase.accent} opacity="0.55" />
              </g>
            </>
          )}
        </svg>

        {/* Continuous ambient motion — scan line, chest pulse, particles.
            Lives in its own SVG with native pixel viewBox for crisp sizing. */}
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 1920 1080"
          preserveAspectRatio="xMidYMid slice"
        >
          <defs>
            <linearGradient id="scan-grad" x1="0" y1="0" x2="1920" y2="0">
              <stop offset="0%" stopColor="rgba(52,211,153,0)" />
              <stop offset="50%" stopColor="rgba(134,239,172,0.85)" />
              <stop offset="100%" stopColor="rgba(52,211,153,0)" />
            </linearGradient>
          </defs>

          <rect className="scan-line" x="0" y="-3" width="1920" height="2" fill="url(#scan-grad)" />

          {Array.from({ length: 14 }, (_, i) => i).map((i) => (
            <circle key={i} className={`particle particle-${i}`} r="1.4" fill="rgba(167,243,208,0.78)" />
          ))}
        </svg>

        {/* Bottom vignette + HUD strip */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-[#03070a]/85" />

        <div className="pointer-events-none absolute inset-x-0 bottom-10 z-20 flex flex-col items-center gap-3">
          {/* Phase indicator strip — always visible mid-scroll, lets the operator know what's being installed */}
          {progress > 0.005 && progress < 0.98 && (
            <div className="flex items-center gap-4 border border-white/[0.10] bg-black/55 px-5 py-2 backdrop-blur-md">
              <span className="font-mono text-[10px] uppercase tracking-[0.32em] text-emerald-200/[0.78]">
                Phase {String(activePhase.id).padStart(2, "0")}
              </span>
              <span className="h-3 w-px bg-emerald-200/[0.30]" />
              <span className="text-sm font-bold text-white">{activePhase.title}</span>
              <span className="h-3 w-px bg-emerald-200/[0.30]" />
              <span className="font-mono text-[10px] tracking-[0.20em] text-emerald-200/[0.85]">
                {Math.round(progress * 100)}%
              </span>
            </div>
          )}

          {progress < 0.04 && (
            <div className="flex flex-col items-center gap-2 text-[10px] font-mono uppercase tracking-[0.32em] text-emerald-200/[0.72]">
              <span>Scroll to assemble</span>
              <ChevronDown className="h-4 w-4 animate-bounce" />
            </div>
          )}
          {progress > 0.92 && (
            <a
              href="#choose-agent"
              className="pointer-events-auto inline-flex items-center gap-2 border border-amber-200/[0.55] bg-amber-200/[0.14] px-5 py-3 text-sm font-bold text-amber-100 backdrop-blur-md transition-all hover:border-amber-200/[0.85] hover:bg-amber-200/[0.22]"
            >
              Bravo online — choose entry
              <ChevronDown className="h-4 w-4 animate-bounce" />
            </a>
          )}
        </div>

        <style>{`
          .scan-line {
            animation: scan-travel 5.2s linear infinite;
            filter: drop-shadow(0 0 8px rgba(134,239,172,0.72));
          }
          @keyframes scan-travel {
            0%   { transform: translateY(0); opacity: 0; }
            8%   { opacity: 0.9; }
            92%  { opacity: 0.9; }
            100% { transform: translateY(1080px); opacity: 0; }
          }

          .particle {
            opacity: 0.42;
            animation: particle-pulse 7s ease-in-out infinite;
          }
          ${Array.from({ length: 14 }, (_, i) => {
            const x = 80 + ((i * 197) % 1760);
            const y = 80 + ((i * 131) % 920);
            const delay = (i * 0.55) % 5;
            return `
              .particle-${i} {
                cx: ${x};
                cy: ${y};
                animation-delay: ${delay}s;
              }
            `;
          }).join("")}
          @keyframes particle-pulse {
            0%, 100% { opacity: 0.18; transform: translate(0, 0); }
            50%      { opacity: 0.85; transform: translate(0, -10px); }
          }

          @media (max-width: 1023px) {
            .agent-assembly { min-height: 700vh; }
          }
          @media (max-width: 640px) {
            .agent-assembly { min-height: 600vh; }
          }
          @media (prefers-reduced-motion: reduce) {
            .scan-line, .particle { animation: none !important; }
          }
        `}</style>
      </div>
    </section>
  );
}
