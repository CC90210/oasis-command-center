"use client";

import { useState, type RefObject } from "react";
import {
  useMotionValueEvent,
  useScroll,
  type MotionValue,
} from "framer-motion";

export type ScrollPhase = {
  phase: number;
  localProgress: number;
  scrollProgress: MotionValue<number>;
};

const DEFAULT_PHASE_COUNT = 8;

function clampProgress(value: number) {
  return Math.max(0, Math.min(1, value));
}

export function useScrollPhase(
  target: RefObject<HTMLElement | null>,
  phaseCount: number = DEFAULT_PHASE_COUNT,
): ScrollPhase {
  const PHASE_COUNT = phaseCount;
  const { scrollYProgress } = useScroll({
    target,
    offset: ["start start", "end end"],
  });
  const [phaseState, setPhaseState] = useState({
    phase: 0,
    localProgress: 0,
  });

  useMotionValueEvent(scrollYProgress, "change", (latest) => {
    const clamped = clampProgress(latest);
    const rawPhase = clamped * PHASE_COUNT;
    const phase = Math.min(PHASE_COUNT - 1, Math.floor(rawPhase));
    const localProgress =
      phase === PHASE_COUNT - 1 && rawPhase >= PHASE_COUNT
        ? 1
        : rawPhase - phase;
    const roundedLocalProgress = Number(localProgress.toFixed(3));

    setPhaseState((current) => {
      if (
        current.phase === phase &&
        current.localProgress === roundedLocalProgress
      ) {
        return current;
      }

      return {
        phase,
        localProgress: roundedLocalProgress,
      };
    });
  });

  return {
    ...phaseState,
    scrollProgress: scrollYProgress,
  };
}
