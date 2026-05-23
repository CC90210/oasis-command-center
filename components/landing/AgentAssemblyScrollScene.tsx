"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { motion, useReducedMotion, useTransform, type MotionValue } from "framer-motion";
import { AgentFigure } from "./agent-assembly/AgentFigure";
import { BrowserOptics } from "./agent-assembly/modules/BrowserOptics";
import { BusinessLayer } from "./agent-assembly/modules/BusinessLayer";
import { CommandCentre } from "./agent-assembly/modules/CommandCentre";
import { DashboardMetrics } from "./agent-assembly/modules/DashboardMetrics";
import { GuardShield } from "./agent-assembly/modules/GuardShield";
import { MemorySpine } from "./agent-assembly/modules/MemorySpine";
import { OutputHalo } from "./agent-assembly/modules/OutputHalo";
import { ReasoningCore } from "./agent-assembly/modules/ReasoningCore";
import { SecurityMesh } from "./agent-assembly/modules/SecurityMesh";
import { StatePulse } from "./agent-assembly/modules/StatePulse";
import { ToolLimbs } from "./agent-assembly/modules/ToolLimbs";
import { useCursorTracking } from "./agent-assembly/useCursorTracking";
import { useScrollPhase } from "./agent-assembly/useScrollPhase";

const PHASE_COUNT = 11;
const INSTALL_WINDOW = 0.05;

/**
 * Each phase maps to a real subsystem in CC's empire. Labels surface in
 * the manifest HUD beside the figure so the operator knows exactly what
 * is being installed — not "Reasoning Core" in the abstract but the
 * actual model + provider + script powering it.
 *
 * IMPORTANT: order must stay in sync with the <AgentFigure> children
 * below (ReasoningCore, StatePulse, MemorySpine, BrowserOptics,
 * ToolLimbs, GuardShield, OutputHalo, SecurityMesh — that exact
 * sequence). Reordering one without the other silently desyncs the
 * label from the geometry being installed.
 */
const MODULE_MANIFEST = [
  { label: "Reasoning Core",     subsystem: "Claude Sonnet 4.5 · OpenRouter · GPT-5" },
  { label: "State Pulse",        subsystem: "empire_state.db · agent_events" },
  { label: "Memory Spine",       subsystem: "FTS5 lexical + LanceDB semantic · 219 files" },
  { label: "Browser Optics",     subsystem: "CloakBrowser · Browser Harness" },
  { label: "Bridge Tools",       subsystem: "bravo_cli/bridge_tools.py · 21 tools + 115 scripts" },
  { label: "Guard Shield",       subsystem: "secret · exec · state guard hooks" },
  { label: "Output Channels",    subsystem: "Telegram · Email · Dashboard feed" },
  { label: "Security Mesh",      subsystem: "Zero-trust mesh · audit_mcp_secrets · RLS" },
  { label: "Business Layer",     subsystem: "Brand · Voice · Audience · Goals manifest" },
  { label: "Command Centre",     subsystem: "Pulse · Crons · Funnel · Pipeline" },
  { label: "Dashboard Metrics",  subsystem: "MRR · Pipeline · Conversions live" },
] as const;

const AMBIENT_PARTICLES = [
  { left: 8, top: 22, size: 2, delay: 0, drift: -16 },
  { left: 17, top: 72, size: 3, delay: 0.9, drift: 18 },
  { left: 26, top: 38, size: 2, delay: 1.4, drift: -20 },
  { left: 34, top: 84, size: 2, delay: 0.4, drift: 15 },
  { left: 43, top: 18, size: 3, delay: 1.8, drift: -12 },
  { left: 52, top: 77, size: 2, delay: 2.2, drift: 20 },
  { left: 61, top: 31, size: 2, delay: 0.7, drift: -18 },
  { left: 69, top: 66, size: 3, delay: 1.2, drift: 16 },
  { left: 76, top: 16, size: 2, delay: 2.5, drift: -15 },
  { left: 83, top: 49, size: 2, delay: 0.2, drift: 18 },
  { left: 91, top: 81, size: 3, delay: 1.7, drift: -21 },
  { left: 13, top: 49, size: 2, delay: 2.9, drift: 14 },
  { left: 47, top: 54, size: 2, delay: 3.3, drift: -17 },
  { left: 88, top: 27, size: 2, delay: 3.7, drift: 12 },
];

// Distant cosmic star field. Hand-tuned positions across the viewport for a
// natural-looking scatter. Tiny sizes (0.6–1.6px) keep it reading as DISTANT
// while the AMBIENT_PARTICLES (above) read as closer foreground sparkles.
const COSMIC_STARS = [
  { left: 3,  top: 6,  size: 1.1, twinkle: 4.2 },
  { left: 7,  top: 32, size: 0.7, twinkle: 6.1 },
  { left: 11, top: 17, size: 1.4, twinkle: 5.8 },
  { left: 14, top: 88, size: 0.9, twinkle: 4.7 },
  { left: 19, top: 46, size: 0.8, twinkle: 5.3 },
  { left: 21, top: 11, size: 1.2, twinkle: 6.6 },
  { left: 23, top: 64, size: 0.6, twinkle: 5.1 },
  { left: 27, top: 27, size: 1.6, twinkle: 4.4 },
  { left: 29, top: 81, size: 0.7, twinkle: 6.9 },
  { left: 31, top: 4,  size: 1.0, twinkle: 5.5 },
  { left: 33, top: 56, size: 0.8, twinkle: 4.9 },
  { left: 36, top: 38, size: 1.1, twinkle: 6.3 },
  { left: 38, top: 92, size: 0.6, twinkle: 5.7 },
  { left: 41, top: 23, size: 1.3, twinkle: 4.6 },
  { left: 44, top: 71, size: 0.7, twinkle: 6.5 },
  { left: 46, top: 9,  size: 0.9, twinkle: 5.2 },
  { left: 48, top: 47, size: 0.6, twinkle: 5.9 },
  { left: 51, top: 84, size: 1.0, twinkle: 4.8 },
  { left: 53, top: 30, size: 1.5, twinkle: 6.2 },
  { left: 55, top: 62, size: 0.7, twinkle: 5.4 },
  { left: 57, top: 14, size: 0.9, twinkle: 4.3 },
  { left: 59, top: 49, size: 1.2, twinkle: 6.0 },
  { left: 62, top: 89, size: 0.6, twinkle: 5.6 },
  { left: 65, top: 35, size: 0.8, twinkle: 4.5 },
  { left: 67, top: 73, size: 1.4, twinkle: 6.8 },
  { left: 71, top: 20, size: 0.7, twinkle: 5.0 },
  { left: 73, top: 58, size: 0.9, twinkle: 6.4 },
  { left: 76, top: 41, size: 0.6, twinkle: 4.1 },
  { left: 78, top: 86, size: 1.1, twinkle: 5.5 },
  { left: 81, top: 12, size: 0.8, twinkle: 6.7 },
  { left: 84, top: 67, size: 1.3, twinkle: 4.7 },
  { left: 86, top: 33, size: 0.7, twinkle: 5.8 },
  { left: 89, top: 92, size: 0.9, twinkle: 5.1 },
  { left: 92, top: 22, size: 1.0, twinkle: 6.5 },
  { left: 94, top: 54, size: 0.6, twinkle: 4.4 },
  { left: 96, top: 78, size: 1.5, twinkle: 5.9 },
  { left: 2,  top: 51, size: 0.8, twinkle: 6.1 },
  { left: 5,  top: 75, size: 1.0, twinkle: 4.9 },
  { left: 16, top: 60, size: 0.7, twinkle: 5.6 },
  { left: 39, top: 5,  size: 1.2, twinkle: 4.2 },
  { left: 42, top: 95, size: 0.6, twinkle: 6.3 },
  { left: 64, top: 8,  size: 0.9, twinkle: 5.4 },
  { left: 87, top: 7,  size: 0.7, twinkle: 4.8 },
  { left: 24, top: 96, size: 0.8, twinkle: 5.2 },
  { left: 70, top: 96, size: 1.1, twinkle: 6.6 },
  { left: 56, top: 96, size: 0.6, twinkle: 4.5 },
  { left: 9,  top: 96, size: 0.9, twinkle: 5.7 },
  { left: 32, top: 70, size: 0.8, twinkle: 4.6 },
];

function useCompactViewport() {
  const [isCompact, setIsCompact] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const update = () => setIsCompact(media.matches);

    update();
    media.addEventListener("change", update);

    return () => media.removeEventListener("change", update);
  }, []);

  return isCompact;
}

function useInstallProgress(scrollProgress: MotionValue<number>, phaseIndex: number) {
  const start = phaseIndex / PHASE_COUNT;
  return useTransform(
    scrollProgress,
    [start, Math.min(start + INSTALL_WINDOW, 1)],
    [0, 1],
    { clamp: true },
  );
}

export function AgentAssemblyScrollScene() {
  const sectionRef = useRef<HTMLElement>(null);
  const { phase, localProgress, scrollProgress } = useScrollPhase(sectionRef);
  const shouldReduceMotion = useReducedMotion();
  const isCompact = useCompactViewport();
  const forceInstalled = Boolean(shouldReduceMotion || isCompact);
  const cursor = useCursorTracking(forceInstalled);

  const reasoningProgress = useInstallProgress(scrollProgress, 0);
  const stateProgress = useInstallProgress(scrollProgress, 1);
  const memoryProgress = useInstallProgress(scrollProgress, 2);
  const opticsProgress = useInstallProgress(scrollProgress, 3);
  const limbsProgress = useInstallProgress(scrollProgress, 4);
  const shieldProgress = useInstallProgress(scrollProgress, 5);
  const haloProgress = useInstallProgress(scrollProgress, 6);
  const meshProgress = useInstallProgress(scrollProgress, 7);
  const businessProgress = useInstallProgress(scrollProgress, 8);
  const commandProgress = useInstallProgress(scrollProgress, 9);
  const dashboardProgress = useInstallProgress(scrollProgress, 10);

  const progressScale = forceInstalled ? 1 : scrollProgress;
  const buildPercent = forceInstalled
    ? 100
    : Math.min(100, Math.round(((phase + localProgress) / PHASE_COUNT) * 100));

  return (
    <section
      ref={sectionRef}
      id="agent-build"
      className="relative z-10 min-h-screen min-[641px]:min-h-[700vh] lg:min-h-[800vh]"
    >
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-5 py-12 min-[641px]:sticky min-[641px]:top-0 min-[641px]:h-screen sm:px-8">
        {/* Cosmic background: deep space gradient → nebula clouds → slowly
            rotating spiral galaxy → distant star field → faint grid →
            edge vignette. Each layer is pointer-events-none and aria-hidden. */}

        {/* Layer 1 — deep cosmic gradient (indigo / violet / emerald horizon
            bleed). Anchored colour stops give a "looking out from inside a
            nebula" feel. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_30%_25%,rgba(76,29,149,0.32),transparent_38%),radial-gradient(ellipse_at_72%_75%,rgba(15,118,110,0.28),transparent_40%),radial-gradient(ellipse_at_50%_55%,rgba(52,211,153,0.13),transparent_55%),linear-gradient(180deg,#02060c_0%,#03070a_55%,#02050a_100%)]"
        />

        {/* Layer 2 — coloured nebula clouds (large soft-blurred shapes that
            drift very slowly so the universe feels alive without distracting
            from the figure). */}
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute -left-[10%] top-[12%] h-[55vh] w-[55vw] rounded-full opacity-[0.42] blur-[80px] bg-[radial-gradient(circle,rgba(124,58,237,0.55),transparent_70%)]"
          animate={forceInstalled ? undefined : { x: [0, 24, 0], y: [0, 18, 0] }}
          transition={{ duration: 32, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute -right-[12%] top-[55%] h-[50vh] w-[50vw] rounded-full opacity-[0.38] blur-[90px] bg-[radial-gradient(circle,rgba(20,184,166,0.5),transparent_70%)]"
          animate={forceInstalled ? undefined : { x: [0, -22, 0], y: [0, -14, 0] }}
          transition={{ duration: 38, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute right-[18%] top-[6%] h-[28vh] w-[28vw] rounded-full opacity-[0.28] blur-[60px] bg-[radial-gradient(circle,rgba(252,211,77,0.42),transparent_70%)]"
          animate={forceInstalled ? undefined : { x: [0, -12, 0], y: [0, 10, 0] }}
          transition={{ duration: 26, repeat: Infinity, ease: "easeInOut" }}
        />

        {/* Layer 3 — slowly rotating spiral galaxy (large, low opacity,
            sits as background depth behind the figure). 120s rotation
            cycle reads as cosmic-slow without being motionless. */}
        <motion.svg
          aria-hidden="true"
          viewBox="0 0 600 600"
          className="pointer-events-none absolute left-[58%] top-[20%] h-[90vh] w-[90vh] -translate-x-1/2 opacity-[0.18]"
          animate={forceInstalled ? undefined : { rotate: 360 }}
          transition={{ duration: 120, repeat: Infinity, ease: "linear" }}
        >
          <defs>
            <radialGradient id="galaxy-core" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(252,211,77,0.85)" />
              <stop offset="22%" stopColor="rgba(134,239,172,0.55)" />
              <stop offset="58%" stopColor="rgba(76,29,149,0.32)" />
              <stop offset="100%" stopColor="rgba(2,6,12,0)" />
            </radialGradient>
            <radialGradient id="galaxy-arm" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(167,243,208,0.42)" />
              <stop offset="100%" stopColor="rgba(167,243,208,0)" />
            </radialGradient>
          </defs>
          <circle cx="300" cy="300" r="240" fill="url(#galaxy-core)" />
          {/* Five logarithmic spiral arms, each rotated 72° around the core */}
          {[0, 72, 144, 216, 288].map((deg) => (
            <g key={deg} transform={`rotate(${deg} 300 300)`}>
              <path
                d="M300 300 C 360 285, 420 270, 470 240 C 510 215, 540 180, 555 140"
                stroke="url(#galaxy-arm)"
                strokeWidth="42"
                fill="none"
                strokeLinecap="round"
                opacity="0.55"
              />
            </g>
          ))}
        </motion.svg>

        {/* Layer 4 — distant star field. 48 hand-placed twinkling stars. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          {COSMIC_STARS.map((star) => (
            <motion.span
              key={`star-${star.left}-${star.top}`}
              className="absolute rounded-full bg-white shadow-[0_0_6px_rgba(167,243,208,0.6)]"
              style={{
                left: `${star.left}%`,
                top: `${star.top}%`,
                height: star.size,
                width: star.size,
              }}
              animate={
                forceInstalled
                  ? undefined
                  : { opacity: [0.18, 0.86, 0.18] }
              }
              transition={{
                duration: star.twinkle,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            />
          ))}
        </div>

        {/* Layer 5 — subtle holographic grid overlay (existing, kept but
            faded down so the cosmic layers dominate). */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(167,243,208,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(167,243,208,0.035)_1px,transparent_1px)] [background-size:96px_96px] [mask-image:radial-gradient(ellipse_72%_64%_at_50%_50%,black_20%,transparent_84%)]"
        />

        {/* Layer 6 — corner vignette so text + HUD stay legible against
            the cosmic backdrop */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_42%,rgba(2,5,10,0.82)_100%)]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-200/35 to-transparent"
        />

        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          {AMBIENT_PARTICLES.map((particle, index) => (
            <motion.span
              key={`${particle.left}-${particle.top}`}
              className="absolute rounded-full bg-emerald-200 shadow-[0_0_14px_rgba(52,211,153,0.85)]"
              style={{
                left: `${particle.left}%`,
                top: `${particle.top}%`,
                height: particle.size,
                width: particle.size,
              }}
              animate={
                forceInstalled
                  ? undefined
                  : {
                      y: [0, particle.drift, 0],
                      opacity: [0.22, 0.78, 0.22],
                      scale: [1, 1.55, 1],
                    }
              }
              transition={{
                delay: particle.delay,
                duration: 5.5 + (index % 4),
                repeat: Infinity,
                ease: "easeInOut",
              }}
            />
          ))}
        </div>

        <div className="absolute left-5 right-5 top-8 z-20 mx-auto max-w-xl text-center min-[641px]:left-8 min-[641px]:right-auto min-[641px]:mx-0 min-[641px]:max-w-[18rem] min-[641px]:text-left xl:max-w-md">
          <div className="mb-4 inline-flex items-center gap-2 border-l border-emerald-300/[0.45] bg-emerald-300/[0.08] px-3 py-2 text-[10px] font-mono uppercase tracking-[0.22em] text-emerald-100/[0.85] backdrop-blur-md">
            Build the agent first
          </div>
          <h1 className="text-[clamp(2.35rem,7vw,4.2rem)] font-black leading-[0.94] tracking-tight text-white min-[641px]:text-[clamp(2.1rem,4.1vw,4rem)]">
            Build the agent before you enter.
          </h1>
          <p className="mt-5 text-sm leading-6 text-white/[0.66] min-[641px]:text-[13px] xl:text-base xl:leading-7">
            OASIS assembles reasoning, memory, vision, tools, guardrails, and security into a working operator before you pick an entry path.
          </p>

          {/* Live manifest — names the REAL subsystem powering each phase so
              the operator can see exactly what's installing. Status flips
              from pending → active (during install) → locked (after install)
              based on scroll phase. Hidden on mobile (compact mode). */}
          <ul className="mt-6 hidden space-y-1.5 text-left font-mono text-[10px] uppercase tracking-[0.14em] min-[641px]:block">
            {MODULE_MANIFEST.map((entry, idx) => {
              const status: "locked" | "active" | "pending" = forceInstalled
                ? "locked"
                : idx < phase
                  ? "locked"
                  : idx === phase
                    ? "active"
                    : "pending";
              const dotClass =
                status === "active"
                  ? "bg-emerald-300 shadow-[0_0_10px_rgba(52,211,153,0.85)] animate-pulse"
                  : status === "locked"
                    ? "bg-emerald-300/55"
                    : "bg-white/15";
              const textClass =
                status === "active"
                  ? "text-emerald-100"
                  : status === "locked"
                    ? "text-white/70"
                    : "text-white/30";
              return (
                <li key={entry.label} className={`flex items-start gap-3 ${textClass}`}>
                  <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
                  <span className="flex-1">
                    <span className="block tracking-[0.18em]">
                      {String(idx + 1).padStart(2, "0")} · {entry.label}
                    </span>
                    <span className="block text-[9px] normal-case tracking-[0.04em] text-white/45">
                      {entry.subsystem}
                    </span>
                  </span>
                  <span className="text-[8px] tracking-[0.22em] opacity-70">
                    {status === "active" ? "ACTIVE" : status === "locked" ? "LOCKED" : "PENDING"}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        <div
          aria-hidden="true"
          className="absolute left-1/2 top-[55%] z-10 w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2 min-[641px]:top-1/2 min-[641px]:w-[min(58vw,520px)] lg:w-[min(44vw,560px)]"
        >
          <AgentFigure
            cursorX={cursor.x}
            cursorY={cursor.y}
            className="h-auto w-full overflow-visible drop-shadow-[0_0_34px_rgba(52,211,153,0.22)]"
          >
            <ReasoningCore installProgress={reasoningProgress} forceInstalled={forceInstalled} />
            <StatePulse installProgress={stateProgress} forceInstalled={forceInstalled} />
            <MemorySpine installProgress={memoryProgress} forceInstalled={forceInstalled} />
            <BrowserOptics installProgress={opticsProgress} forceInstalled={forceInstalled} />
            <ToolLimbs installProgress={limbsProgress} forceInstalled={forceInstalled} />
            <GuardShield installProgress={shieldProgress} forceInstalled={forceInstalled} />
            <OutputHalo installProgress={haloProgress} forceInstalled={forceInstalled} />
            <SecurityMesh installProgress={meshProgress} forceInstalled={forceInstalled} />
            <BusinessLayer installProgress={businessProgress} forceInstalled={forceInstalled} />
            <CommandCentre installProgress={commandProgress} forceInstalled={forceInstalled} />
            <DashboardMetrics installProgress={dashboardProgress} forceInstalled={forceInstalled} />
          </AgentFigure>
        </div>

        <div className="pointer-events-none absolute bottom-8 left-5 right-5 z-20 flex items-end justify-between gap-6 sm:left-8 sm:right-8">
          <div className="hidden min-[641px]:block">
            <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-emerald-200/60">
              Assembly {buildPercent}%
            </div>
            <div className="mt-2 h-1 w-44 origin-left overflow-hidden bg-white/10">
              <motion.div
                className="h-full origin-left bg-gradient-to-r from-emerald-300 to-amber-300"
                style={{ scaleX: progressScale }}
              />
            </div>
          </div>

          <a
            href="#choose-agent"
            className="pointer-events-auto ml-auto inline-flex items-center gap-2 border border-emerald-200/[0.55] bg-emerald-200/[0.14] px-5 py-3 text-sm font-bold text-emerald-100 backdrop-blur-md transition-all hover:border-emerald-200/[0.85] hover:bg-emerald-200/[0.22]"
          >
            Choose entry
            <ChevronDown className="h-4 w-4" />
          </a>
        </div>
      </div>
    </section>
  );
}
