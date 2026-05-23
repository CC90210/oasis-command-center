"use client";

import type { ModuleProps } from "../AssemblyModule";
import { AssemblyModule } from "../AssemblyModule";

/**
 * State Pulse — small centered pulse orb anchored on the figure's
 * sternum, BETWEEN the Reasoning Core (above) and Memory Spine (below).
 * Concentric rings emanate from a bright nucleus; three small status
 * pips on each side indicate live event throughput. Reads as a
 * heartbeat without the messy ECG strip that previously cluttered
 * the chest.
 */
export function StatePulse(props: ModuleProps) {
  return (
    <AssemblyModule
      {...props}
      dock={{ x: 210, y: 332 }}
      from={{ x: 622, y: 44, rotate: 104, scale: 0.42 }}
      via={{ x: 342, y: 180 }}
      burstColor="rgba(74, 222, 128, 0.94)"
    >
      <g filter="url(#agent-soft-glow)">
        {/* Outer ripple ring */}
        <circle r={18} fill="none" stroke="rgba(74, 222, 128, 0.32)" strokeWidth={0.7} strokeDasharray="2 3" />
        {/* Mid ripple ring */}
        <circle r={12} fill="none" stroke="rgba(74, 222, 128, 0.62)" strokeWidth={0.9} />
        {/* Bright nucleus */}
        <circle r={6} fill="rgba(74, 222, 128, 0.32)" />
        <circle r={3.2} fill="#bbf7d0" />
        <circle r={1.4} fill="#ffffff" />
        {/* Three event-throughput pips on each side */}
        {[-1, 1].map((side) => (
          <g key={side}>
            <circle cx={side * 26} cy={0} r={1.2} fill="rgba(187, 247, 208, 0.9)" />
            <circle cx={side * 32} cy={-3} r={1} fill="rgba(187, 247, 208, 0.65)" />
            <circle cx={side * 32} cy={3} r={1} fill="rgba(187, 247, 208, 0.65)" />
            <circle cx={side * 38} cy={0} r={0.8} fill="rgba(187, 247, 208, 0.42)" />
          </g>
        ))}
      </g>
    </AssemblyModule>
  );
}
