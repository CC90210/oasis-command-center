"use client";

import { useEffect } from "react";
import { useMotionValue, type MotionValue } from "framer-motion";

export type CursorVector = {
  x: MotionValue<number>;
  y: MotionValue<number>;
};

function clampUnit(value: number) {
  return Math.max(-1, Math.min(1, value));
}

export function useCursorTracking(disabled = false): CursorVector {
  const x = useMotionValue(0);
  const y = useMotionValue(0);

  useEffect(() => {
    if (disabled) {
      x.set(0);
      y.set(0);
      return;
    }

    let frame: number | null = null;
    let latestX = window.innerWidth / 2;
    let latestY = window.innerHeight / 2;

    const update = () => {
      frame = null;

      const halfWidth = Math.max(window.innerWidth / 2, 1);
      const halfHeight = Math.max(window.innerHeight / 2, 1);

      x.set(clampUnit((latestX - halfWidth) / halfWidth));
      y.set(clampUnit((latestY - halfHeight) / halfHeight));
    };

    const onPointerMove = (event: PointerEvent) => {
      latestX = event.clientX;
      latestY = event.clientY;

      if (frame === null) {
        frame = window.requestAnimationFrame(update);
      }
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      x.set(0);
      y.set(0);
    };
  }, [disabled, x, y]);

  return { x, y };
}
