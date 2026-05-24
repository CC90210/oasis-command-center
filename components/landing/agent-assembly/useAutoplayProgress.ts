"use client";

import { useEffect } from "react";
import {
  animate,
  useMotionValue,
  type MotionValue,
} from "framer-motion";

/**
 * Time-driven 0→1 progress for the mobile autoplay variant of the agent
 * assembly. Mobile viewports can't carry the 700vh sticky scroll experience
 * the desktop uses, so we drive the same phase machine off a two-phase
 * keyframed animation that fires on mount and holds at 1:
 *
 *  Phase A (0 → 0.909, linear, ~7.5s):
 *    Installs 10 fragments one by one (each install window is 1/11 of
 *    progress wide). At the end of phase A, every fragment is installed
 *    and floating in its scattered position — peak cinematic suspense.
 *
 *  Phase B (0.909 → 1, easeInOut, ~2.5s):
 *    The compaction climax. Fragments converge, links draw, pulses
 *    travel, lock-in flash, center shockwave, solid figure fades in.
 *    Eased so the lock-in beat feels mechanical, not abrupt.
 *
 * Total ~10s. Returns a stable MotionValue so the same useTransform
 * calls in the scene work whether the progress source is scroll or time.
 */
export function useAutoplayProgress(enabled: boolean): MotionValue<number> {
  const progress = useMotionValue(0);

  useEffect(() => {
    if (!enabled) {
      progress.set(0);
      return;
    }

    const controls = animate(progress, [0, 0.909, 1], {
      duration: 10,
      times: [0, 0.75, 1],
      ease: ["linear", [0.4, 0, 0.2, 1]],
    });

    return () => controls.stop();
  }, [enabled, progress]);

  return progress;
}
