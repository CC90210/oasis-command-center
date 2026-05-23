"use client";

import type { ModuleProps } from "../AssemblyModule";
import { AssemblyModule } from "../AssemblyModule";

export function StatePulse(props: ModuleProps) {
  return (
    <AssemblyModule
      {...props}
      dock={{ x: 210, y: 321 }}
      from={{ x: 622, y: 44, rotate: 104, scale: 0.42 }}
      via={{ x: 342, y: 180 }}
      burstColor="rgba(74, 222, 128, 0.94)"
    >
      <g>
        <path
          d="M-58 -17 H-15 L-6 -27 H16 L25 -17 H58 V17 H20 L10 27 H-13 L-22 17 H-58 Z"
          fill="rgba(5, 18, 16, 0.92)"
          stroke="rgba(74, 222, 128, 0.65)"
          strokeWidth={1.4}
        />
        <path
          d="M-45 1 H-25 L-18 -10 L-8 15 L2 -16 L12 7 H24 L31 -4 L39 1 H48"
          fill="none"
          stroke="#86efac"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={3}
        />
        <circle cx={-48} cy={0} r={3} fill="#bbf7d0" />
        <circle cx={48} cy={0} r={3} fill="#bbf7d0" />
      </g>
    </AssemblyModule>
  );
}
