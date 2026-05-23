"use client";

import type { ModuleProps } from "../AssemblyModule";
import { AssemblyModule } from "../AssemblyModule";

export function ToolLimbs(props: ModuleProps) {
  return (
    <AssemblyModule
      {...props}
      dock={{ x: 210, y: 288 }}
      from={{ x: -264, y: 222, rotate: 134, scale: 0.38 }}
      via={{ x: 62, y: 224 }}
      burstColor="rgba(110, 231, 183, 0.95)"
    >
      <g>
        <path
          d="M-106 -52 L-69 -71 L-42 -49 L-52 -16 L-93 -18 Z"
          fill="rgba(7, 18, 15, 0.96)"
          stroke="rgba(110, 231, 183, 0.6)"
          strokeWidth={1.5}
        />
        <path
          d="M106 -52 L69 -71 L42 -49 L52 -16 L93 -18 Z"
          fill="rgba(7, 18, 15, 0.96)"
          stroke="rgba(110, 231, 183, 0.6)"
          strokeWidth={1.5}
        />
        <path
          d="M-92 -16 L-122 44 L-105 105 L-80 101 L-91 47 L-61 -9 Z"
          fill="rgba(6, 78, 59, 0.54)"
          stroke="rgba(110, 231, 183, 0.42)"
          strokeWidth={1.3}
        />
        <path
          d="M92 -16 L122 44 L105 105 L80 101 L91 47 L61 -9 Z"
          fill="rgba(6, 78, 59, 0.54)"
          stroke="rgba(110, 231, 183, 0.42)"
          strokeWidth={1.3}
        />
        <path
          d="M-122 44 L-142 37 M122 44 L142 37 M-105 105 L-121 125 M105 105 L121 125"
          stroke="rgba(252, 211, 77, 0.45)"
          strokeLinecap="round"
          strokeWidth={2.2}
        />
        <circle cx={-78} cy={-42} r={8} fill="rgba(167,243,208,0.62)" />
        <circle cx={78} cy={-42} r={8} fill="rgba(167,243,208,0.62)" />
      </g>
    </AssemblyModule>
  );
}
