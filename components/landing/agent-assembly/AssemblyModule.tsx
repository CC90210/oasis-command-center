"use client";

import type { ReactNode } from "react";
import { motion, useTransform, type MotionValue } from "framer-motion";

export type ModuleDock = {
  x: number;
  y: number;
};

export type ModuleOrigin = ModuleDock & {
  rotate: number;
  scale: number;
};

export type ModuleProps = {
  installProgress: MotionValue<number>;
  forceInstalled?: boolean;
};

type AssemblyModuleProps = ModuleProps & {
  children: ReactNode;
  dock: ModuleDock;
  from: ModuleOrigin;
  via?: ModuleDock;
  burstColor?: string;
  className?: string;
};

const SPARKS = [
  { x: 0, y: -28, length: 16 },
  { x: 22, y: -18, length: 13 },
  { x: 31, y: 4, length: 12 },
  { x: 18, y: 24, length: 13 },
  { x: -4, y: 30, length: 11 },
  { x: -25, y: 17, length: 13 },
  { x: -30, y: -6, length: 12 },
  { x: -18, y: -23, length: 14 },
];

export function AssemblyModule({
  children,
  dock,
  from,
  via,
  installProgress,
  forceInstalled = false,
  burstColor = "rgba(52, 211, 153, 0.9)",
  className,
}: AssemblyModuleProps) {
  const midpoint = via ?? {
    x: (from.x + dock.x) / 2,
    y: (from.y + dock.y) / 2,
  };

  const x = useTransform(
    installProgress,
    [0, 0.58, 1],
    [from.x, midpoint.x, dock.x],
  );
  const y = useTransform(
    installProgress,
    [0, 0.58, 1],
    [from.y, midpoint.y, dock.y],
  );
  const rotate = useTransform(
    installProgress,
    [0, 0.72, 1],
    [from.rotate, from.rotate * 0.18, 0],
  );
  const scale = useTransform(
    installProgress,
    [0, 0.72, 0.88, 1],
    [from.scale, 0.96, 1.1, 1],
  );
  const opacity = useTransform(installProgress, [0, 0.05, 0.18], [0, 0.35, 1]);
  const burstOpacity = useTransform(
    installProgress,
    [0.78, 0.88, 1],
    [0, 1, 0],
  );
  const burstScale = useTransform(
    installProgress,
    [0.78, 0.92, 1],
    [0.25, 1.45, 1.9],
  );

  return (
    <motion.g
      className={className}
      style={{
        x: forceInstalled ? dock.x : x,
        y: forceInstalled ? dock.y : y,
        rotate: forceInstalled ? 0 : rotate,
        scale: forceInstalled ? 1 : scale,
        opacity: forceInstalled ? 1 : opacity,
        transformBox: "fill-box",
        transformOrigin: "center",
      }}
    >
      {children}
      <motion.g
        style={{
          opacity: forceInstalled ? 0 : burstOpacity,
          scale: forceInstalled ? 1 : burstScale,
          transformBox: "fill-box",
          transformOrigin: "center",
        }}
      >
        {SPARKS.map((spark) => {
          const unit = Math.hypot(spark.x, spark.y) || 1;
          const startX = (spark.x / unit) * 8;
          const startY = (spark.y / unit) * 8;
          const endX = (spark.x / unit) * (spark.length + 16);
          const endY = (spark.y / unit) * (spark.length + 16);

          return (
            <line
              key={`${spark.x}-${spark.y}`}
              x1={startX}
              y1={startY}
              x2={endX}
              y2={endY}
              stroke={burstColor}
              strokeLinecap="round"
              strokeWidth={1.6}
            />
          );
        })}
        <circle r={5.5} fill={burstColor} opacity={0.32} />
        <circle r={2.4} fill="#f8fafc" opacity={0.76} />
      </motion.g>
    </motion.g>
  );
}
