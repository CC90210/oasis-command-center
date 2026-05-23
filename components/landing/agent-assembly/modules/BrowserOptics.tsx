"use client";

import type { ModuleProps } from "../AssemblyModule";
import { AssemblyModule } from "../AssemblyModule";

export function BrowserOptics(props: ModuleProps) {
  return (
    <AssemblyModule
      {...props}
      dock={{ x: 210, y: 176 }}
      from={{ x: 562, y: -166, rotate: -86, scale: 0.42 }}
      via={{ x: 368, y: 52 }}
      burstColor="rgba(153, 246, 228, 0.95)"
    >
      <g filter="url(#agent-soft-glow)">
        <path
          d="M-59 -13 H-18 L-10 -4 H10 L18 -13 H59 V13 H19 L10 4 H-10 L-19 13 H-59 Z"
          fill="rgba(15, 118, 110, 0.22)"
          stroke="rgba(153, 246, 228, 0.72)"
          strokeWidth={1.5}
        />
        <ellipse cx={-39} cy={0} rx={16} ry={8} fill="rgba(153, 246, 228, 0.18)" />
        <ellipse cx={39} cy={0} rx={16} ry={8} fill="rgba(153, 246, 228, 0.18)" />
        <path
          d="M-51 20 L-94 58 M-30 20 L-52 68 M30 20 L52 68 M51 20 L94 58"
          stroke="rgba(153, 246, 228, 0.24)"
          strokeLinecap="round"
          strokeWidth={1.2}
        />
        <path
          d="M-50 -22 H50"
          stroke="rgba(209, 250, 229, 0.72)"
          strokeLinecap="round"
          strokeDasharray="7 9"
          strokeWidth={1.2}
        />
      </g>
    </AssemblyModule>
  );
}
