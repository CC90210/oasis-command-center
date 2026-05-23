"use client";

import type { ModuleProps } from "../AssemblyModule";
import { AssemblyModule } from "../AssemblyModule";

/**
 * Dashboard Metrics — live business KPIs floating beside the figure.
 * Renders as two small dashboard cards (MRR + Pipeline) with a sparkline
 * and a numeric headline each. Represents the operator's metrics view —
 * the agents act, the dashboard reports.
 *
 * Phase 11 (new — final phase). Floats to the LEFT of the figure at
 * shoulder/torso height so it doesn't crowd the body.
 */
export function DashboardMetrics(props: ModuleProps) {
  return (
    <AssemblyModule
      {...props}
      dock={{ x: 80, y: 290 }}
      from={{ x: -260, y: 290, rotate: -16, scale: 0.5 }}
      via={{ x: -40, y: 290 }}
      burstColor="rgba(132, 204, 22, 0.95)"
    >
      <g filter="url(#agent-soft-glow)">
        {/* MRR card */}
        <g transform="translate(0 -50)">
          <rect
            x={-44}
            y={-22}
            width={88}
            height={44}
            rx={3}
            fill="rgba(7, 18, 15, 0.94)"
            stroke="rgba(132, 204, 22, 0.65)"
            strokeWidth={0.9}
          />
          <text x={-38} y={-12} fontSize="5" fill="rgba(217, 249, 157, 0.85)" fontFamily="ui-monospace, monospace" letterSpacing="0.18em">
            MRR
          </text>
          <text x={-38} y={4} fontSize="11" fill="#d9f99d" fontFamily="ui-monospace, monospace" fontWeight="700">
            $5,000
          </text>
          <text x={-38} y={14} fontSize="4.4" fill="rgba(190, 242, 100, 0.75)" fontFamily="ui-monospace, monospace">
            +18% MoM
          </text>
          {/* Mini sparkline */}
          <path
            d="M14 14 L22 8 L28 11 L34 4 L40 -2"
            fill="none"
            stroke="rgba(132, 204, 22, 0.85)"
            strokeWidth={1.1}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>

        {/* Pipeline card */}
        <g transform="translate(0 8)">
          <rect
            x={-44}
            y={-22}
            width={88}
            height={44}
            rx={3}
            fill="rgba(7, 18, 15, 0.94)"
            stroke="rgba(132, 204, 22, 0.65)"
            strokeWidth={0.9}
          />
          <text x={-38} y={-12} fontSize="5" fill="rgba(217, 249, 157, 0.85)" fontFamily="ui-monospace, monospace" letterSpacing="0.18em">
            PIPELINE
          </text>
          <text x={-38} y={4} fontSize="11" fill="#d9f99d" fontFamily="ui-monospace, monospace" fontWeight="700">
            42 / 7
          </text>
          <text x={-38} y={14} fontSize="4.4" fill="rgba(190, 242, 100, 0.75)" fontFamily="ui-monospace, monospace">
            leads / closing
          </text>
          {/* Mini bar chart */}
          {[14, 10, 16, 8, 12, 18].map((h, i) => (
            <rect
              key={i}
              x={14 + i * 5}
              y={4 - h}
              width={3}
              height={h}
              fill="rgba(132, 204, 22, 0.85)"
            />
          ))}
        </g>

        {/* Connection beam from cards to the figure's chest */}
        <path
          d="M44 -28 L130 -22 M44 14 L130 22"
          stroke="rgba(132, 204, 22, 0.45)"
          strokeWidth={0.7}
          strokeDasharray="3 4"
        />
      </g>
    </AssemblyModule>
  );
}
