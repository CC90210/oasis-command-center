"use client";

import type { ModuleProps } from "../AssemblyModule";
import { AssemblyModule } from "../AssemblyModule";

/**
 * State Pulse — thin horizontal heartbeat strip representing
 * empire_state.db + agent_events. Moved BELOW Reasoning Core so the
 * two no longer pile up on the chest. Compact (only 18px tall vs
 * the old 34px) so it reads as a HUD readout instead of a panel.
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
      <g>
        {/* Slim readout pill — half the previous height */}
        <path
          d="M-62 -9 H-15 L-6 -17 H16 L25 -9 H62 V9 H22 L12 17 H-13 L-22 9 H-62 Z"
          fill="rgba(5, 18, 16, 0.92)"
          stroke="rgba(74, 222, 128, 0.7)"
          strokeWidth={1.2}
        />
        {/* Heartbeat ECG trace */}
        <path
          d="M-50 1 H-28 L-22 -7 L-14 9 L-6 -10 L2 6 H10 L16 -8 L22 4 H50"
          fill="none"
          stroke="#86efac"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2.2}
        />
        {/* Endpoint dots */}
        <circle cx={-52} cy={0} r={2.4} fill="#bbf7d0" />
        <circle cx={52} cy={0} r={2.4} fill="#bbf7d0" />
        {/* Frequency tick marks */}
        <path
          d="M-40 -13 V-9 M-20 -13 V-9 M0 -13 V-9 M20 -13 V-9 M40 -13 V-9"
          stroke="rgba(74, 222, 128, 0.35)"
          strokeWidth={0.7}
          strokeLinecap="round"
        />
      </g>
    </AssemblyModule>
  );
}
