"use client";

import type { ModuleProps } from "../AssemblyModule";
import { AssemblyModule } from "../AssemblyModule";

export function GuardShield(props: ModuleProps) {
  return (
    <AssemblyModule
      {...props}
      dock={{ x: 210, y: 302 }}
      from={{ x: 646, y: 626, rotate: -115, scale: 0.45 }}
      via={{ x: 424, y: 430 }}
      burstColor="rgba(45, 212, 191, 0.95)"
    >
      <g filter="url(#agent-soft-glow)">
        <path
          d="M0 -220 L105 -174 L132 -34 C124 70 81 149 0 202 C-81 149 -124 70 -132 -34 L-105 -174 Z"
          fill="rgba(20, 184, 166, 0.11)"
          stroke="rgba(94, 234, 212, 0.62)"
          strokeWidth={2}
        />
        <path
          d="M0 -184 L78 -149 L101 -29 C94 56 61 119 0 162 C-61 119 -94 56 -101 -29 L-78 -149 Z"
          fill="none"
          stroke="rgba(167, 243, 208, 0.24)"
          strokeWidth={1.1}
        />
        <path
          d="M0 -184 V162 M-101 -29 H101 M-78 -149 L78 -149 M-70 111 L70 111"
          stroke="rgba(94, 234, 212, 0.16)"
          strokeLinecap="round"
          strokeWidth={1}
        />
      </g>
    </AssemblyModule>
  );
}
