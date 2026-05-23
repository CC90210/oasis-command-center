"use client";

import type { ModuleProps } from "../AssemblyModule";
import { AssemblyModule } from "../AssemblyModule";

export function OutputHalo(props: ModuleProps) {
  return (
    <AssemblyModule
      {...props}
      dock={{ x: 210, y: 92 }}
      from={{ x: -184, y: -122, rotate: 210, scale: 0.35 }}
      via={{ x: 96, y: 26 }}
      burstColor="rgba(252, 211, 77, 0.98)"
    >
      <g filter="url(#agent-gold-glow)">
        <ellipse
          rx={55}
          ry={15}
          fill="rgba(252, 211, 77, 0.08)"
          stroke="rgba(252, 211, 77, 0.82)"
          strokeWidth={2}
        />
        <ellipse
          rx={34}
          ry={8}
          fill="none"
          stroke="rgba(255, 247, 237, 0.48)"
          strokeWidth={1.1}
        />
        <path
          d="M-68 0 H-84 M68 0 H84 M0 -22 V-34 M0 22 V34"
          stroke="rgba(252, 211, 77, 0.7)"
          strokeLinecap="round"
          strokeWidth={2}
        />
        <circle cx={-52} cy={0} r={3.5} fill="#fef3c7" />
        <circle cx={52} cy={0} r={3.5} fill="#fef3c7" />
      </g>
    </AssemblyModule>
  );
}
