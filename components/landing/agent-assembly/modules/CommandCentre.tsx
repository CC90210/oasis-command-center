"use client";

import type { ModuleProps } from "../AssemblyModule";
import { AssemblyModule } from "../AssemblyModule";

/**
 * Command Centre — the operational hub. Renders as a thin control bar
 * BELOW the figure with four module pills (Pulse · Crons · Funnel ·
 * Pipeline) representing the daily Telegram pulse, the cron engine,
 * the inbound funnel poller, and the lead pipeline.
 *
 * Phase 10 (new). Lives under the figure's base disc so it reads as
 * the operator's command surface — what the agent acts on.
 */
export function CommandCentre(props: ModuleProps) {
  const pills = [
    { x: -78, label: "PULSE" },
    { x: -26, label: "CRONS" },
    { x: 26, label: "FUNNEL" },
    { x: 78, label: "PIPELINE" },
  ];

  return (
    <AssemblyModule
      {...props}
      dock={{ x: 210, y: 540 }}
      from={{ x: 210, y: 820, rotate: 0, scale: 0.5 }}
      via={{ x: 210, y: 660 }}
      burstColor="rgba(34, 211, 238, 0.95)"
    >
      <g filter="url(#agent-soft-glow)">
        {/* Background tray */}
        <rect
          x={-118}
          y={-14}
          width={236}
          height={28}
          rx={4}
          fill="rgba(7, 18, 15, 0.92)"
          stroke="rgba(34, 211, 238, 0.6)"
          strokeWidth={1}
        />
        {/* Section label */}
        <text
          x={-118}
          y={-20}
          fontSize="5"
          fill="rgba(165, 243, 252, 0.85)"
          fontFamily="ui-monospace, monospace"
          letterSpacing="0.32em"
        >
          COMMAND CENTRE
        </text>
        {/* Four control pills */}
        {pills.map((pill, idx) => (
          <g key={pill.label} transform={`translate(${pill.x} 0)`}>
            <rect
              x={-22}
              y={-9}
              width={44}
              height={18}
              rx={2}
              fill={idx === 0 ? "rgba(34, 211, 238, 0.18)" : "rgba(15, 23, 42, 0.85)"}
              stroke="rgba(34, 211, 238, 0.55)"
              strokeWidth={0.7}
            />
            <circle
              cx={-15}
              cy={0}
              r={1.6}
              fill={idx === 0 ? "rgba(34, 211, 238, 0.95)" : "rgba(165, 243, 252, 0.7)"}
            />
            <text
              x={2}
              y={2.5}
              fontSize="5.4"
              fill="rgba(207, 250, 254, 0.95)"
              fontFamily="ui-monospace, monospace"
              textAnchor="middle"
              letterSpacing="0.12em"
            >
              {pill.label}
            </text>
          </g>
        ))}
        {/* Connection line from tray to the figure's base */}
        <path
          d="M0 -14 V-38"
          stroke="rgba(34, 211, 238, 0.55)"
          strokeWidth={0.9}
          strokeDasharray="2 3"
        />
      </g>
    </AssemblyModule>
  );
}
