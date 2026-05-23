"use client";

import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

// Each phase reveals via a clip-path circle that blooms from a body-part
// origin so the operator sees the new system bolt onto the previous figure
// instead of crossfading over it.
const PHASES = [
  { id: 1, title: "Initial seed",       image: "/images/agent-assembly/phase-01-initial-seed.jpg",      revealX: 50, revealY: 50, accentColor: "rgba(52,211,153,0.95)" },
  { id: 2, title: "Neural backbone",    image: "/images/agent-assembly/phase-02-neural-backbone.jpg",   revealX: 50, revealY: 36, accentColor: "rgba(52,211,153,0.95)" },
  { id: 3, title: "Optic calibration",  image: "/images/agent-assembly/phase-03-optic-calibration.jpg", revealX: 50, revealY: 30, accentColor: "rgba(134,239,172,0.95)" },
  { id: 4, title: "Tool limb docking",  image: "/images/agent-assembly/phase-04-tool-limb-docking.jpg", revealX: 50, revealY: 52, accentColor: "rgba(167,243,208,0.95)" },
  { id: 5, title: "Guard shield",       image: "/images/agent-assembly/phase-05-guard-shield.jpg",      revealX: 50, revealY: 50, accentColor: "rgba(187,247,208,0.95)" },
  { id: 6, title: "Output halo",        image: "/images/agent-assembly/phase-06-output-halo.jpg",       revealX: 50, revealY: 22, accentColor: "rgba(252,211,77,0.95)" },
  { id: 7, title: "Security mesh",      image: "/images/agent-assembly/phase-07-security-mesh.jpg",     revealX: 50, revealY: 50, accentColor: "rgba(110,231,183,0.95)" },
  { id: 8, title: "Bravo online",       image: "/images/agent-assembly/phase-08-bravo-online.jpg",      revealX: 50, revealY: 50, accentColor: "rgba(252,211,77,0.95)" },
] as const;

const REVEAL_PORTION = 0.55; // reveal animation occupies first 55% of each phase segment
const FLASH_PORTION = 0.08;  // flash overlay punches the first 8% of each segment

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(value: number) {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

/**
 * Returns the clip-path string for the image at index `i` given current scroll
 * progress. Phase 0 is the base layer (always fully visible). Phases 1..7 each
 * reveal via a circle that blooms from the phase's revealX/revealY origin
 * during the first REVEAL_PORTION of their own segment.
 */
function clipPathFor(i: number, progress: number): string {
  if (i === 0) return "circle(150% at 50% 50%)";
  const segmentSize = 1 / PHASES.length;
  const segmentStart = i * segmentSize;
  const revealWindow = segmentSize * REVEAL_PORTION;
  const localT = (progress - segmentStart) / revealWindow;
  const eased = smoothstep(localT);
  const phase = PHASES[i];
  return `circle(${eased * 160}% at ${phase.revealX}% ${phase.revealY}%)`;
}

/**
 * Subtle scale pulse on whichever phase is currently active. Adds depth and
 * suggests the figure is "breathing" between phase changes.
 */
function imageScale(i: number, progress: number): number {
  const segmentSize = 1 / PHASES.length;
  const center = (i + 0.5) * segmentSize;
  const dist = Math.abs(progress - center);
  const active = Math.max(0, 1 - dist / segmentSize);
  return 1 + active * 0.024;
}

/**
 * Returns 0..1 indicating "how close are we to a phase boundary" so we can
 * pulse a flash overlay precisely at each phase transition.
 */
function flashIntensityAt(progress: number): number {
  const segmentSize = 1 / PHASES.length;
  const segmentLocal = (progress / segmentSize) % 1;
  if (segmentLocal > FLASH_PORTION) return 0;
  return 1 - segmentLocal / FLASH_PORTION;
}

export function AgentAssemblyScrollScene() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [progress, setProgress] = useState(0);
  const [loadedSet, setLoadedSet] = useState<Set<number>>(() => new Set());

  const markLoaded = (i: number) => {
    setLoadedSet((prev) => {
      if (prev.has(i)) return prev;
      const next = new Set(prev);
      next.add(i);
      return next;
    });
  };

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

  const flashIntensity = flashIntensityAt(progress);
  const activePhase = PHASES[phaseIdx];

  return (
    <section
      ref={sectionRef}
      id="agent-build"
      className="agent-assembly relative z-10"
      style={{ minHeight: "800vh" } as CSSProperties}
    >
      <div className="sticky top-0 h-screen w-full overflow-hidden bg-[#03070a]">
        {/* Image stack — every phase always rendered, clip-path controls reveal */}
        <div className="absolute inset-0">
          {PHASES.map((p, i) => (
            <div
              key={p.id}
              className="absolute inset-0"
              style={{
                clipPath: clipPathFor(i, progress),
                transform: `scale(${imageScale(i, progress)})`,
                transformOrigin: "center center",
                willChange: "clip-path, transform",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={p.image}
                alt={p.title}
                loading={i <= 1 ? "eager" : "lazy"}
                decoding="async"
                className="h-full w-full object-cover object-center"
                style={{ filter: "saturate(1.06) contrast(1.05)" }}
                onLoad={() => markLoaded(i)}
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            </div>
          ))}
        </div>

        {/* Placeholder hero — visible while the current phase image is still loading */}
        {!loadedSet.has(phaseIdx) && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="placeholder-figure">
              <div className="placeholder-head" />
              <div className="placeholder-torso" />
              <div className="placeholder-core" />
              <div className="placeholder-scan" />
            </div>
          </div>
        )}

        {/* Continuous manufacturing motion layer — runs forever, intensifies at transitions */}
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 1920 1080"
          preserveAspectRatio="xMidYMid slice"
        >
          <defs>
            <radialGradient id="reveal-bloom" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor={activePhase.accentColor} stopOpacity="0.55" />
              <stop offset="35%" stopColor={activePhase.accentColor} stopOpacity="0.18" />
              <stop offset="100%" stopColor={activePhase.accentColor} stopOpacity="0" />
            </radialGradient>
            <linearGradient id="scan-line-gradient" x1="0" y1="0" x2="1920" y2="0">
              <stop offset="0%" stopColor="rgba(52,211,153,0)" />
              <stop offset="50%" stopColor="rgba(134,239,172,0.85)" />
              <stop offset="100%" stopColor="rgba(52,211,153,0)" />
            </linearGradient>
            <linearGradient id="arm-beam-left" x1="0" y1="0.5" x2="1" y2="0.5">
              <stop offset="0%" stopColor="rgba(52,211,153,0)" />
              <stop offset="100%" stopColor="rgba(252,211,77,0.95)" />
            </linearGradient>
            <linearGradient id="arm-beam-right" x1="1" y1="0.5" x2="0" y2="0.5">
              <stop offset="0%" stopColor="rgba(52,211,153,0)" />
              <stop offset="100%" stopColor="rgba(252,211,77,0.95)" />
            </linearGradient>
          </defs>

          {/* Reveal bloom — radial gradient at the active phase's reveal origin,
              pulses brighter during transitions */}
          <rect
            x={`${activePhase.revealX - 25}%`}
            y={`${activePhase.revealY - 18}%`}
            width="50%"
            height="36%"
            fill="url(#reveal-bloom)"
            opacity={0.35 + flashIntensity * 0.5}
            className="reveal-bloom-rect"
          />

          {/* Vertical scan line — continuous top-to-bottom sweep, gives the
              impression of an active 3D scanner / printer head */}
          <rect
            className="scan-line"
            x="0"
            y="-3"
            width="1920"
            height="3"
            fill="url(#scan-line-gradient)"
          />

          {/* Horizontal scan field — slow horizontal sweep at chest level */}
          <line
            className="scan-field"
            x1="0"
            y1="540"
            x2="1920"
            y2="540"
            stroke="rgba(52,211,153,0.18)"
            strokeWidth="0.5"
            strokeDasharray="8 16"
          />

          {/* Robotic arm energy beams — animated dashed lines from L/R edges
              to figure center, intensify at transitions */}
          <line
            x1="0"
            y1="540"
            x2="940"
            y2="540"
            stroke="url(#arm-beam-left)"
            strokeWidth="1.2"
            strokeDasharray="120 60"
            className="arm-beam arm-beam-l"
            opacity={0.5 + flashIntensity * 0.5}
          />
          <line
            x1="1920"
            y1="540"
            x2="980"
            y2="540"
            stroke="url(#arm-beam-right)"
            strokeWidth="1.2"
            strokeDasharray="120 60"
            className="arm-beam arm-beam-r"
            opacity={0.5 + flashIntensity * 0.5}
          />

          {/* Pulse halo at chest — anchored to the figure's energy core */}
          <circle
            cx="960"
            cy="540"
            r="180"
            fill="none"
            stroke={activePhase.accentColor}
            strokeWidth="1"
            opacity={0.25 + flashIntensity * 0.6}
            className="chest-pulse"
          />
          <circle
            cx="960"
            cy="540"
            r="260"
            fill="none"
            stroke={activePhase.accentColor}
            strokeWidth="0.8"
            strokeDasharray="6 14"
            opacity={0.18}
            className="chest-pulse-outer"
          />

          {/* Spark burst at reveal origin during transitions */}
          {flashIntensity > 0.1 && (
            <g
              transform={`translate(${(activePhase.revealX / 100) * 1920} ${(activePhase.revealY / 100) * 1080})`}
              opacity={flashIntensity}
            >
              {Array.from({ length: 8 }, (_, i) => {
                const angle = (i * Math.PI) / 4;
                const len = 80 + flashIntensity * 60;
                const x2 = Math.cos(angle) * len;
                const y2 = Math.sin(angle) * len;
                return (
                  <line
                    key={i}
                    x1="0"
                    y1="0"
                    x2={x2}
                    y2={y2}
                    stroke={activePhase.accentColor}
                    strokeWidth="1.5"
                    opacity="0.85"
                  />
                );
              })}
              <circle cx="0" cy="0" r={20 + flashIntensity * 40} fill={activePhase.accentColor} opacity="0.45" />
            </g>
          )}

          {/* Drifting particles */}
          {Array.from({ length: 14 }, (_, i) => i).map((i) => (
            <circle key={i} className={`particle particle-${i}`} r="1.4" fill="rgba(167,243,208,0.78)" />
          ))}
        </svg>

        {/* Transition flash — full-viewport flash at every phase boundary */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: `radial-gradient(ellipse at ${activePhase.revealX}% ${activePhase.revealY}%, ${activePhase.accentColor.replace("0.95", "0.42")} 0%, transparent 50%)`,
            opacity: flashIntensity * 0.85,
            transition: "opacity 60ms linear",
            mixBlendMode: "screen",
          }}
        />

        {/* Subtle vignette so text affordances at bottom stay legible */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-[#03070a]/85" />

        {/* Bottom-center affordance */}
        <div className="pointer-events-none absolute inset-x-0 bottom-10 z-20 flex justify-center">
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
          .placeholder-figure {
            position: relative;
            width: 280px;
            height: 480px;
          }
          .placeholder-head {
            position: absolute;
            top: 0; left: 50%;
            width: 120px; height: 140px;
            margin-left: -60px;
            border-radius: 60px 60px 56px 56px;
            border: 1px solid rgba(52,211,153,0.20);
            background: radial-gradient(circle at 50% 35%, rgba(52,211,153,0.10), transparent 60%);
            animation: placeholder-pulse 3.6s ease-in-out infinite;
          }
          .placeholder-torso {
            position: absolute;
            top: 150px; left: 50%;
            width: 220px; height: 320px;
            margin-left: -110px;
            border-radius: 70px 70px 90px 90px;
            border: 1px solid rgba(52,211,153,0.16);
            background: linear-gradient(180deg, rgba(52,211,153,0.06), transparent 70%);
            animation: placeholder-pulse 3.6s ease-in-out infinite;
            animation-delay: 0.6s;
          }
          .placeholder-core {
            position: absolute;
            top: 250px; left: 50%;
            width: 50px; height: 50px;
            margin-left: -25px;
            border-radius: 9999px;
            background: radial-gradient(circle, rgba(236,253,245,0.85) 0 8%, rgba(52,211,153,0.42) 9% 35%, transparent 60%);
            box-shadow: 0 0 42px rgba(52,211,153,0.42);
            animation: placeholder-core-pulse 2.2s ease-in-out infinite;
          }
          .placeholder-scan {
            position: absolute;
            top: 0; left: -20px; right: -20px;
            height: 2px;
            background: linear-gradient(90deg, transparent, rgba(52,211,153,0.62), transparent);
            box-shadow: 0 0 18px rgba(52,211,153,0.62);
            animation: placeholder-scan 3.2s ease-in-out infinite;
          }

          @keyframes placeholder-pulse {
            0%, 100% { opacity: 0.32; }
            50% { opacity: 0.78; }
          }
          @keyframes placeholder-core-pulse {
            0%, 100% { transform: scale(0.92); opacity: 0.72; }
            50% { transform: scale(1.12); opacity: 1; }
          }
          @keyframes placeholder-scan {
            0%   { transform: translateY(0); opacity: 0; }
            10%  { opacity: 1; }
            90%  { opacity: 1; }
            100% { transform: translateY(480px); opacity: 0; }
          }

          /* Continuous scan line travelling top → bottom across the figure.
             Gives a constant "scanning / fabricating" feel even when the user
             pauses scrolling. */
          .scan-line {
            animation: scan-travel 5.2s linear infinite;
            filter: drop-shadow(0 0 8px rgba(134,239,172,0.72));
          }
          @keyframes scan-travel {
            0%   { transform: translateY(0);    opacity: 0; }
            8%   { opacity: 0.9; }
            92%  { opacity: 0.9; }
            100% { transform: translateY(1080px); opacity: 0; }
          }

          .scan-field {
            animation: scan-field-pulse 3.6s ease-in-out infinite;
          }
          @keyframes scan-field-pulse {
            0%, 100% { opacity: 0.18; }
            50%      { opacity: 0.62; }
          }

          /* L/R arm energy beams — dashed lines that march toward centre,
             so the operator sees a constant "feed" into the figure */
          .arm-beam {
            stroke-dashoffset: 0;
            animation: arm-beam-march 1.8s linear infinite;
          }
          .arm-beam-r { animation-direction: reverse; }

          @keyframes arm-beam-march {
            from { stroke-dashoffset: 0; }
            to   { stroke-dashoffset: -180; }
          }

          .chest-pulse {
            transform-origin: 960px 540px;
            animation: chest-pulse-anim 3.4s ease-in-out infinite;
          }
          .chest-pulse-outer {
            transform-origin: 960px 540px;
            animation: chest-pulse-anim 4.6s ease-in-out infinite reverse;
          }
          @keyframes chest-pulse-anim {
            0%, 100% { transform: scale(0.94); opacity: 0.22; }
            50%      { transform: scale(1.10); opacity: 0.62; }
          }

          .reveal-bloom-rect {
            filter: blur(40px);
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
            .scan-line, .scan-field, .arm-beam, .chest-pulse, .chest-pulse-outer, .particle,
            .placeholder-head, .placeholder-torso, .placeholder-core, .placeholder-scan {
              animation: none !important;
            }
          }
        `}</style>
      </div>
    </section>
  );
}
