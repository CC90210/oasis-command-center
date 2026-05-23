"use client";

import { motion, useSpring, useTransform, type MotionValue } from "framer-motion";

type AgentEyeProps = {
  cx: number;
  cy: number;
  cursorX: MotionValue<number>;
  cursorY: MotionValue<number>;
  maxPupilOffset?: number;
};

const SPRING = {
  stiffness: 180,
  damping: 24,
  mass: 0.35,
};

export function AgentEye({
  cx,
  cy,
  cursorX,
  cursorY,
  maxPupilOffset = 3,
}: AgentEyeProps) {
  const pupilX = useSpring(
    useTransform(cursorX, [-1, 1], [-maxPupilOffset, maxPupilOffset]),
    SPRING,
  );
  const pupilY = useSpring(
    useTransform(cursorY, [-1, 1], [-maxPupilOffset, maxPupilOffset]),
    SPRING,
  );

  return (
    <g transform={`translate(${cx} ${cy})`}>
      <ellipse
        rx={15}
        ry={9}
        fill="rgba(5, 18, 16, 0.96)"
        stroke="rgba(167, 243, 208, 0.55)"
        strokeWidth={1.2}
      />
      <ellipse rx={10} ry={5.8} fill="rgba(52, 211, 153, 0.15)" />
      <motion.circle
        r={4.4}
        fill="#d1fae5"
        style={{
          x: pupilX,
          y: pupilY,
        }}
      />
      <motion.circle
        r={8}
        fill="none"
        stroke="rgba(52, 211, 153, 0.38)"
        strokeWidth={1}
        style={{
          x: pupilX,
          y: pupilY,
        }}
      />
      <circle cx={5} cy={-3.5} r={1.5} fill="rgba(255,255,255,0.9)" />
    </g>
  );
}
