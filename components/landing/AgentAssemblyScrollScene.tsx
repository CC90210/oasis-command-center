"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { motion, useReducedMotion, useTransform, type MotionValue } from "framer-motion";
import { AgentFigure } from "./agent-assembly/AgentFigure";
import { BrowserOptics } from "./agent-assembly/modules/BrowserOptics";
import { GuardShield } from "./agent-assembly/modules/GuardShield";
import { MemorySpine } from "./agent-assembly/modules/MemorySpine";
import { OutputHalo } from "./agent-assembly/modules/OutputHalo";
import { ReasoningCore } from "./agent-assembly/modules/ReasoningCore";
import { SecurityMesh } from "./agent-assembly/modules/SecurityMesh";
import { StatePulse } from "./agent-assembly/modules/StatePulse";
import { ToolLimbs } from "./agent-assembly/modules/ToolLimbs";
import { useCursorTracking } from "./agent-assembly/useCursorTracking";
import { useScrollPhase } from "./agent-assembly/useScrollPhase";

const PHASE_COUNT = 8;
const INSTALL_WINDOW = 0.06;

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
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(52,211,153,0.17),transparent_30%),radial-gradient(circle_at_68%_64%,rgba(252,211,77,0.10),transparent_24%),linear-gradient(180deg,rgba(3,7,10,0)_0%,rgba(3,7,10,0.86)_100%)]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-55 [background-image:linear-gradient(rgba(167,243,208,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(167,243,208,0.045)_1px,transparent_1px)] [background-size:72px_72px] [mask-image:radial-gradient(ellipse_78%_70%_at_50%_46%,black_20%,transparent_84%)]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_38%,rgba(3,7,10,0.76)_100%)]"
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
