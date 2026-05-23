"use client";

import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

const PHASES = [
  { id: 1, title: "Initial seed",       image: "/images/agent-assembly/phase-01-initial-seed.jpg" },
  { id: 2, title: "Neural backbone",    image: "/images/agent-assembly/phase-02-neural-backbone.jpg" },
  { id: 3, title: "Optic calibration",  image: "/images/agent-assembly/phase-03-optic-calibration.jpg" },
  { id: 4, title: "Tool limb docking",  image: "/images/agent-assembly/phase-04-tool-limb-docking.jpg" },
  { id: 5, title: "Guard shield",       image: "/images/agent-assembly/phase-05-guard-shield.jpg" },
  { id: 6, title: "Output halo",        image: "/images/agent-assembly/phase-06-output-halo.jpg" },
  { id: 7, title: "Security mesh",      image: "/images/agent-assembly/phase-07-security-mesh.jpg" },
  { id: 8, title: "Bravo online",       image: "/images/agent-assembly/phase-08-bravo-online.jpg" },
] as const;

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

function imageOpacity(i: number, progress: number): number {
  const center = (i + 0.5) / PHASES.length;
  if (i === 0 && progress < center) return 1;
  if (i === PHASES.length - 1 && progress > center) return 1;
  const dist = Math.abs(progress - center);
  return Math.max(0, 1 - dist * 16);
}

function imageScale(i: number, progress: number): number {
  const center = (i + 0.5) / PHASES.length;
  const dist = Math.abs(progress - center);
  const active = Math.max(0, 1 - dist * 8);
  return 1 + active * 0.018;
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

  return (
    <section
      ref={sectionRef}
      id="agent-build"
      className="agent-assembly relative z-10"
      style={{ minHeight: "800vh" } as CSSProperties}
    >
      <div className="sticky top-0 h-screen w-full overflow-hidden bg-[#03070a]">
        {/* Image stack — all 8 phases absolutely positioned, opacity-controlled by scroll */}
        <div className="absolute inset-0">
          {PHASES.map((p, i) => {
            const opacity = imageOpacity(i, progress);
            if (opacity <= 0.001) {
              return (
                <div
                  key={p.id}
                  aria-hidden
                  className="absolute inset-0"
                  style={{ opacity: 0, pointerEvents: "none" }}
                />
              );
            }
            return (
              <div
                key={p.id}
                className="absolute inset-0"
                style={{
                  opacity,
                  transform: `scale(${imageScale(i, progress)})`,
                  transformOrigin: "center center",
                  transition: "opacity 80ms linear",
                  willChange: "opacity, transform",
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.image}
                  alt={p.title}
                  loading={i <= 1 ? "eager" : "lazy"}
                  decoding="async"
                  className="h-full w-full object-cover object-center"
                  style={{ filter: "saturate(1.05) contrast(1.05)" }}
                  onLoad={() => markLoaded(i)}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              </div>
            );
          })}
        </div>

        {/* Placeholder hero — visible whenever the CURRENT phase's
            image hasn't loaded. Renders a centered figure silhouette
            + scanline so the page doesn't read as broken while
            public/images/agent-assembly/ is being populated. */}
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

        {/* Subtle vignette + bottom darkening for CTA legibility — image carries its own UI so keep this light */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_transparent_55%,_rgba(3,7,10,0.45)_100%)]" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-[#03070a]/85" />

        {/* SVG overlay layer — orbit rings, particles, subtle motion */}
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 1920 1080"
          preserveAspectRatio="xMidYMid slice"
        >
          <defs>
            <radialGradient id="pulse-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(52,211,153,0.18)" />
              <stop offset="100%" stopColor="rgba(52,211,153,0)" />
            </radialGradient>
          </defs>

          {/* Faint pulse halo from chest area */}
          <circle cx="1080" cy="540" r="200" fill="url(#pulse-glow)" className="pulse-halo" />

          {/* Orbit rings */}
          <circle cx="1080" cy="540" r="260" stroke="rgba(52,211,153,0.10)" strokeWidth="1" fill="none" className="orbit-ring orbit-slow" />
          <circle
            cx="1080"
            cy="540"
            r="360"
            stroke="rgba(52,211,153,0.06)"
            strokeWidth="1"
            fill="none"
            strokeDasharray="3 8"
            className="orbit-ring orbit-reverse"
          />

          {/* Drifting particle dots */}
          {Array.from({ length: 16 }, (_, i) => i).map((i) => (
            <circle key={i} className={`particle particle-${i}`} r="1.6" fill="rgba(167,243,208,0.78)" />
          ))}

          {/* Robotic arm hint glints — left and right edges */}
          <path
            d="M 0 540 L 120 540 L 80 520 Z"
            fill="rgba(52,211,153,0.20)"
            className="arm-hint arm-left"
          />
          <path
            d="M 1920 540 L 1800 540 L 1840 560 Z"
            fill="rgba(52,211,153,0.20)"
            className="arm-hint arm-right"
          />
        </svg>

        {/* Bottom-center affordance: scroll hint at start, CTA at end. Image bakes in the rest of the UI. */}
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
            top: 0;
            left: 50%;
            width: 120px;
            height: 140px;
            margin-left: -60px;
            border-radius: 60px 60px 56px 56px;
            border: 1px solid rgba(52,211,153,0.18);
            background: radial-gradient(circle at 50% 35%, rgba(52,211,153,0.08), transparent 60%);
            animation: placeholder-pulse 3.6s ease-in-out infinite;
          }
          .placeholder-torso {
            position: absolute;
            top: 150px;
            left: 50%;
            width: 220px;
            height: 320px;
            margin-left: -110px;
            border-radius: 70px 70px 90px 90px;
            border: 1px solid rgba(52,211,153,0.14);
            background:
              linear-gradient(180deg, rgba(52,211,153,0.06), transparent 70%);
            animation: placeholder-pulse 3.6s ease-in-out infinite;
            animation-delay: 0.6s;
          }
          .placeholder-core {
            position: absolute;
            top: 250px;
            left: 50%;
            width: 50px;
            height: 50px;
            margin-left: -25px;
            border-radius: 9999px;
            background:
              radial-gradient(circle, rgba(236,253,245,0.85) 0 8%, rgba(52,211,153,0.42) 9% 35%, transparent 60%);
            box-shadow: 0 0 42px rgba(52,211,153,0.42);
            animation: placeholder-core-pulse 2.2s ease-in-out infinite;
          }
          .placeholder-scan {
            position: absolute;
            top: 0;
            left: -20px;
            right: -20px;
            height: 2px;
            background: linear-gradient(90deg, transparent, rgba(52,211,153,0.62), transparent);
            box-shadow: 0 0 18px rgba(52,211,153,0.62);
            animation: placeholder-scan 3.2s ease-in-out infinite;
          }

          @keyframes placeholder-pulse {
            0%, 100% { opacity: 0.32; }
            50%      { opacity: 0.78; }
          }

          @keyframes placeholder-core-pulse {
            0%, 100% { transform: scale(0.92); opacity: 0.72; }
            50%      { transform: scale(1.12); opacity: 1; }
          }

          @keyframes placeholder-scan {
            0%   { transform: translateY(0);    opacity: 0; }
            10%  { opacity: 1; }
            90%  { opacity: 1; }
            100% { transform: translateY(480px); opacity: 0; }
          }

          .pulse-halo {
            opacity: 0.6;
            animation: pulse-breathe 6s ease-in-out infinite;
            transform-origin: 1080px 540px;
          }

          @keyframes pulse-breathe {
            0%, 100% { opacity: 0.32; transform: scale(0.94); }
            50%      { opacity: 0.72; transform: scale(1.08); }
          }

          .orbit-ring {
            transform-origin: 1080px 540px;
          }

          .orbit-slow {
            animation: orbit-rotate 34s linear infinite;
          }

          .orbit-reverse {
            animation: orbit-rotate 46s linear infinite reverse;
          }

          @keyframes orbit-rotate {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
          }

          .arm-hint {
            opacity: 0.28;
            animation: arm-flicker 4.6s ease-in-out infinite;
          }

          .arm-left  { transform-origin: 0 540px; }
          .arm-right { transform-origin: 1920px 540px; }

          @keyframes arm-flicker {
            0%, 100% { opacity: 0.22; }
            50%      { opacity: 0.62; }
          }

          .particle {
            opacity: 0.45;
            animation: particle-pulse 9s ease-in-out infinite;
          }

          ${Array.from({ length: 16 }, (_, i) => {
            const x = 80 + ((i * 217) % 1760);
            const y = 60 + ((i * 137) % 960);
            const delay = (i * 0.7) % 6;
            return `
              .particle-${i} {
                cx: ${x};
                cy: ${y};
                animation-delay: ${delay}s;
              }
            `;
          }).join("")}

          @keyframes particle-pulse {
            0%, 100% { opacity: 0.20; transform: translateY(0); }
            50%      { opacity: 0.78; transform: translateY(-8px); }
          }

          @media (max-width: 1023px) {
            .agent-assembly {
              min-height: 700vh;
            }
          }

          @media (max-width: 640px) {
            .agent-assembly {
              min-height: 600vh;
            }
          }

          @media (prefers-reduced-motion: reduce) {
            .pulse-halo,
            .orbit-slow,
            .orbit-reverse,
            .arm-hint,
            .particle {
              animation: none !important;
            }
          }
        `}</style>
      </div>
    </section>
  );
}
