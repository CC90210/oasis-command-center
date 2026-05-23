"use client";

import type { ModuleProps } from "../AssemblyModule";
import { AssemblyModule } from "../AssemblyModule";

const HEXES = [
  { x: -62, y: -95, r: 18 },
  { x: -24, y: -112, r: 16 },
  { x: 24, y: -112, r: 16 },
  { x: 62, y: -95, r: 18 },
  { x: -78, y: -46, r: 17 },
  { x: -34, y: -43, r: 18 },
  { x: 14, y: -42, r: 18 },
  { x: 62, y: -44, r: 17 },
  { x: -66, y: 6, r: 18 },
  { x: -18, y: 10, r: 18 },
  { x: 30, y: 10, r: 18 },
  { x: 78, y: 6, r: 18 },
  { x: -48, y: 62, r: 17 },
  { x: 0, y: 66, r: 19 },
  { x: 48, y: 62, r: 17 },
  { x: -24, y: 118, r: 16 },
  { x: 24, y: 118, r: 16 },
];

function hexPath(cx: number, cy: number, r: number) {
  const points = Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 3) * index + Math.PI / 6;
    return `${(cx + Math.cos(angle) * r).toFixed(2)},${(
      cy + Math.sin(angle) * r
    ).toFixed(2)}`;
  });

  return `M${points.join(" L")} Z`;
}

export function SecurityMesh(props: ModuleProps) {
  return (
    <AssemblyModule
      {...props}
      dock={{ x: 210, y: 298 }}
      from={{ x: 652, y: 246, rotate: 152, scale: 0.48 }}
      via={{ x: 384, y: 250 }}
      burstColor="rgba(52, 211, 153, 0.98)"
    >
      <g filter="url(#agent-soft-glow)">
        <path
          d="M-106 -132 C-75 -165 75 -165 106 -132 C128 -64 126 62 86 141 C51 163 -51 163 -86 141 C-126 62 -128 -64 -106 -132 Z"
          fill="rgba(52, 211, 153, 0.05)"
          stroke="rgba(52, 211, 153, 0.34)"
          strokeWidth={1.2}
        />
        {HEXES.map((hex) => (
          <path
            key={`${hex.x}-${hex.y}`}
            d={hexPath(hex.x, hex.y, hex.r)}
            fill="none"
            stroke="rgba(110, 231, 183, 0.44)"
            strokeWidth={1.1}
          />
        ))}
        <path
          d="M-86 -104 L-34 -43 L30 10 L78 6 M-78 -46 L0 66 L48 62 M-48 62 L24 118 M-24 -112 L-18 10 L24 118 M62 -95 L14 -42 L-66 6"
          fill="none"
          stroke="rgba(209, 250, 229, 0.18)"
          strokeLinecap="round"
          strokeWidth={1}
        />
      </g>
    </AssemblyModule>
  );
}
