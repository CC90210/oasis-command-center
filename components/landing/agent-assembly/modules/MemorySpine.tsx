"use client";

import type { ModuleProps } from "../AssemblyModule";
import { AssemblyModule } from "../AssemblyModule";

const NODES = [-48, -24, 0, 24, 48];

export function MemorySpine(props: ModuleProps) {
  return (
    <AssemblyModule
      {...props}
      dock={{ x: 210, y: 361 }}
      from={{ x: 218, y: 728, rotate: 72, scale: 0.34 }}
      via={{ x: 146, y: 482 }}
      burstColor="rgba(52, 211, 153, 0.95)"
    >
      <g filter="url(#agent-soft-glow)">
        <path
          d="M-17 -68 H17 L24 -56 V56 L17 68 H-17 L-24 56 V-56 Z"
          fill="rgba(4, 47, 46, 0.88)"
          stroke="rgba(52, 211, 153, 0.62)"
          strokeWidth={1.4}
        />
        <path
          d="M0 -58 V58"
          stroke="rgba(167, 243, 208, 0.52)"
          strokeLinecap="round"
          strokeWidth={1.4}
        />
        {NODES.map((nodeY) => (
          <g key={nodeY} transform={`translate(0 ${nodeY})`}>
            <circle r={10.5} fill="rgba(6, 78, 59, 0.94)" />
            <circle r={5.2} fill="#6ee7b7" />
            <path
              d="M-18 0 H-28 M18 0 H28"
              stroke="rgba(52, 211, 153, 0.48)"
              strokeLinecap="round"
              strokeWidth={1.2}
            />
          </g>
        ))}
      </g>
    </AssemblyModule>
  );
}
