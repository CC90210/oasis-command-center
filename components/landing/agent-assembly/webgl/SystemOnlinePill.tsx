"use client";

import { motion, useTransform, type MotionValue } from "framer-motion";

/**
 * SystemOnlinePill — DOM overlay (NOT WebGL) absolutely positioned over
 * the canvas. Fades in during the back half of the compaction beat to
 * complete the "SYSTEM ONLINE" moment.
 *
 * Rendered outside the Canvas so it gets crisp browser text rendering
 * instead of WebGL-rasterized text (which always looks slightly blurry).
 */

const PILL_CLASSES =
  "flex items-center gap-3 border border-emerald-300/80 bg-[#03070a]/90 px-5 py-2.5 font-mono text-[13px] font-bold uppercase tracking-[0.32em] text-emerald-200 backdrop-blur-sm shadow-[0_0_24px_rgba(134,239,172,0.45)]";

const DOT_CLASSES =
  "h-2.5 w-2.5 rounded-full bg-emerald-300 shadow-[0_0_10px_rgba(52,211,153,0.95)]";

export function SystemOnlinePill({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  // Always call useTransform — never conditional. forceInstalled toggles
  // the render path, not the hook count.
  const opacity = useTransform(compactionProgress, [0.5, 0.85], [0, 1]);

  if (forceInstalled) {
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-[3%] z-30 flex justify-center">
        <div className={PILL_CLASSES}>
          <span className={DOT_CLASSES} />
          SYSTEM ONLINE
        </div>
      </div>
    );
  }

  return (
    <motion.div
      style={{ opacity }}
      className="pointer-events-none absolute inset-x-0 bottom-[3%] z-30 flex justify-center"
    >
      <div className={PILL_CLASSES}>
        <span className={`${DOT_CLASSES} animate-pulse`} />
        SYSTEM ONLINE
      </div>
    </motion.div>
  );
}
