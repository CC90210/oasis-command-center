"use client";

import type { ModuleProps } from "../AssemblyModule";
import { AssemblyModule } from "../AssemblyModule";

export function ReasoningCore(props: ModuleProps) {
  return (
    <AssemblyModule
      {...props}
      dock={{ x: 210, y: 282 }}
      from={{ x: -190, y: 640, rotate: -148, scale: 0.36 }}
      via={{ x: 54, y: 414 }}
      burstColor="rgba(252, 211, 77, 0.95)"
    >
      <g filter="url(#agent-soft-glow)">
        <path
          d="M0 -39 L12 -27 H30 V-8 L41 0 L30 8 V27 H12 L0 39 L-12 27 H-30 V8 L-41 0 L-30 -8 V-27 H-12 Z"
          fill="rgba(6, 78, 59, 0.82)"
          stroke="rgba(252, 211, 77, 0.74)"
          strokeWidth={1.6}
        />
        <circle r={27} fill="url(#agent-core-gradient)" />
        <circle r={12} fill="rgba(252, 211, 77, 0.76)" />
        <circle r={5} fill="#fff7ed" />
        <path
          d="M-20 -2 H-9 M9 -2 H20 M-2 -20 V-9 M-2 9 V20"
          stroke="rgba(3, 7, 10, 0.52)"
          strokeLinecap="round"
          strokeWidth={2.4}
        />
      </g>
    </AssemblyModule>
  );
}
